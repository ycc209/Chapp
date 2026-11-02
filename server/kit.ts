import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { z } from 'zod';
import { streamTrack, wantsEvents } from './events.ts';
import type { AIProvider, BottleCapRequest, CapSide, FindPackagingRequest, LabelTarget, Photo, ReadLabelsRequest, RecognizeKitRequest, SegmentBottlesRequest, WholeBottleRequest } from '../shared/ai.ts';

/**
 * Kit photos (KitVision in shared/ai.ts, server/ai/vision.ts):
 *
 *   POST /api/kit/recognize   RecognizeKitRequest   → RecognizedKit      Muse Spark reads the kit's box
 *   POST /api/kit/segment     SegmentBottlesRequest → SegmentedBottles   SAM 3.1 finds the bottles
 *   POST /api/kit/packaging   FindPackagingRequest  → KitPackaging       SAM 3.1 finds the kit's box or bag
 *   POST /api/kit/track       the video itself      → TrackedBottles     SAM 3.1 follows the bottles through it
 *                                                                          (as events, frame by frame: TrackEvent)
 *   POST /api/kit/labels      ReadLabelsRequest     → ReadLabels         Muse Spark reads each bottle's crop
 *   POST /api/kit/cap         BottleCapRequest      → BottleCap          Muse Spark says which way its cap points
 *   POST /api/kit/whole       WholeBottleRequest    → WholeBottle        Muse Image draws the bottle whole
 *
 * Both are kept in `wholes` by the crop they were asked about (its SHA-256), with the crop beside a whole bottle: asked
 * again for the same crop, the kept answer answers, and each is paid for once.
 *
 * JSON up to 8 MB, photos as base64 JPEG, PNG or WebP; a video to follow is the body itself (video/mp4 or
 * video/quicktime, up to MAX_KIT_VIDEO). Errors are { error } with 400 (not a photo or video, bad fields), 404, 405,
 * 413, 415, 501 (this provider cannot look at photos); a model that fails throws UpstreamError, which app.ts answers
 * with 502.
 */

export const MAX_KIT_JSON = 8 * 1024 * 1024;
/** A video to follow: the phone sends only 20 s or less of it (src/screens/kit/photo.ts), which a phone films smaller. */
export const MAX_KIT_VIDEO = 150 * 1024 * 1024;
/** The first box of an MP4 or a MOV (after its 4-byte size): what tells a video from anything else sent as one. */
const VIDEO_BOXES = new Set(['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip']);
const MAX_CROPS = 24;

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
};

/** The whole body, or null once it passes the limit (read to the end anyway, so the client gets the 413). */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((done, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
    });
    req.on('end', () => done(size > limit ? null : Buffer.concat(chunks)));
    req.on('error', fail);
  });
}

const PhotoData = z.object({ type: z.enum(['image/jpeg', 'image/png', 'image/webp']), data: z.string().min(16) });
const PointSchema = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) });

const RecognizeSchema = z.object({ photo: PhotoData }) satisfies z.ZodType<RecognizeKitRequest>;
const WholeSchema = z.object({ photo: PhotoData }) satisfies z.ZodType<WholeBottleRequest>;
const CapSchema = z.object({ photo: PhotoData }) satisfies z.ZodType<BottleCapRequest>;
const PackagingSchema = z.object({ photo: PhotoData, what: z.string().trim().min(1).max(60) }) satisfies z.ZodType<FindPackagingRequest>;
const BoxInPhoto = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().min(0).max(1), height: z.number().min(0).max(1) });
const SegmentSchema = z.object({
  photo: PhotoData,
  points: z.array(PointSchema).max(20).optional(),
  boxes: z.array(BoxInPhoto).max(16).optional(),
  index: z.int().min(0).max(1000).optional(),
}) satisfies z.ZodType<SegmentBottlesRequest>;
const LabelTargetSchema = z.object({
  id: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(200),
  role: z.string().max(40),
  kit: z.boolean(),
  labels: z.array(z.string().max(100)).max(10),
  volumes: z.array(z.string().max(20)).max(10).optional(),
}) satisfies z.ZodType<LabelTarget>;
const LabelsSchema = z
  .object({
    crops: z.array(PhotoData).min(1).max(MAX_CROPS),
    components: z.array(LabelTargetSchema).min(1).max(30),
    views: z.array(z.int().min(1).max(6)).min(1).max(MAX_CROPS).optional(),
  })
  .refine(r => !r.views || r.views.reduce((n, v) => n + v, 0) === r.crops.length, { message: 'views must add up to the crops', path: ['views'] }) satisfies z.ZodType<ReadLabelsRequest>;

/** What the file's first bytes say it is: JPEG, PNG or WebP, else null. */
export function imageType(bytes: Uint8Array): Photo['type'] | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

class BadPhoto extends Error {}

/** A base64 photo from the body → Photo, typed by its own bytes. */
function toPhoto(data: z.infer<typeof PhotoData>, what: string): Photo {
  const bytes = new Uint8Array(Buffer.from(data.data.replace(/^data:[^,]*,/, ''), 'base64'));
  const type = imageType(bytes);
  if (!type) throw new BadPhoto(`${what} is not a JPEG, PNG or WebP picture`);
  return { type, data: bytes };
}

/** The /api/kit/* routes on `provider`. Returns the handler server/app.ts calls for every path under /api/kit/. */
export function createKitHandler(provider: AIProvider, wholes?: string) {
  const drawing = new Map<string, Promise<Photo>>();
  const keyOf = (photo: Photo) => createHash('sha256').update(photo.data).digest('hex').slice(0, 32);

  /** Which way the bottle's cap points: kept, or asked now (and kept). */
  async function cap(photo: Photo): Promise<CapSide | null> {
    const file = wholes ? resolve(wholes, `${keyOf(photo)}-cap.json`) : null;
    const kept = file ? await readFile(file, 'utf8').catch(() => null) : null;
    if (kept) return (JSON.parse(kept) as { cap: CapSide | null }).cap;
    const side = await provider.capSide!(photo);
    if (wholes && file) {
      await mkdir(wholes, { recursive: true });
      await writeFile(file, JSON.stringify({ cap: side }));
    }
    return side;
  }

  /** The bottle drawn whole: kept, being drawn, or drawn now (and kept). */
  async function whole(photo: Photo): Promise<Photo> {
    const key = keyOf(photo);
    const file = wholes ? resolve(wholes, `${key}.png`) : null;
    const kept = file ? await readFile(file).catch(() => null) : null;
    if (kept) return { type: 'image/png', data: new Uint8Array(kept) };
    let made = drawing.get(key);
    if (!made) {
      made = provider.wholeBottle!(photo).then(async drawn => {
        if (wholes && file) {
          await mkdir(wholes, { recursive: true });
          await writeFile(resolve(wholes, `${key}-crop.${photo.type.split('/')[1]}`), photo.data);
          await writeFile(file, drawn.data);
        }
        return drawn;
      });
      drawing.set(key, made);
      made.finally(() => drawing.delete(key)).catch(() => {});
    }
    return made;
  }

  /** POST /api/kit/track: SAM follows the bottles through the video sent as the body. */
  async function track(req: IncomingMessage, res: ServerResponse, type: string) {
    if (!provider.trackBottles) return json(res, 501, { error: 'This server cannot follow bottles through a video' });
    if (type !== 'video/mp4' && type !== 'video/quicktime') return json(res, 415, { error: 'Send an MP4 or MOV video (content-type: video/mp4 or video/quicktime)' });
    const body = await readBody(req, MAX_KIT_VIDEO);
    if (!body) return json(res, 413, { error: `Video too large (limit ${MAX_KIT_VIDEO / 1024 / 1024} MB)` });
    if (!VIDEO_BOXES.has(body.subarray(4, 8).toString('latin1'))) return json(res, 400, { error: 'The body is not an MP4 or MOV video' });
    const video = { type, data: new Uint8Array(body) } as const;
    // With accept: text/event-stream, each frame as SAM follows the bottles through it (TrackEvent).
    if (wantsEvents(req)) return streamTrack(res, live => provider.trackBottles!(video, live));
    return json(res, 200, await provider.trackBottles(video));
  }

  return async function kit(req: IncomingMessage, res: ServerResponse, path: string) {
    const route = path.slice('/api/kit/'.length);
    if (!['recognize', 'segment', 'packaging', 'track', 'labels', 'cap', 'whole'].includes(route)) return json(res, 404, { error: 'Not found' });
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      return json(res, 405, { error: 'Use POST' });
    }
    const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (route === 'track') return track(req, res, type);
    if (type !== 'application/json') return json(res, 415, { error: 'Send JSON (content-type: application/json)' });
    const body = await readBody(req, MAX_KIT_JSON);
    if (!body) return json(res, 413, { error: `Body too large (limit ${MAX_KIT_JSON / 1024 / 1024} MB)` });
    let raw: unknown;
    try {
      raw = JSON.parse(body.toString('utf8'));
    } catch {
      return json(res, 400, { error: 'The body is not valid JSON' });
    }
    const invalid = (error: z.ZodError) =>
      json(res, 400, { error: `Invalid request: ${error.issues.slice(0, 5).map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ')}` });

    try {
      if (route === 'recognize') {
        const parsed = RecognizeSchema.safeParse(raw);
        if (!parsed.success) return invalid(parsed.error);
        if (!provider.recognizeKit) return json(res, 501, { error: 'This server cannot read kit photos' });
        return json(res, 200, await provider.recognizeKit(toPhoto(parsed.data.photo, 'The photo')));
      }
      if (route === 'segment') {
        const parsed = SegmentSchema.safeParse(raw);
        if (!parsed.success) return invalid(parsed.error);
        if (!provider.segmentBottles) return json(res, 501, { error: 'This server cannot find bottles on photos' });
        const { photo, points, index, boxes } = parsed.data;
        return json(res, 200, await provider.segmentBottles(toPhoto(photo, 'The photo'), points, index, boxes));
      }
      if (route === 'packaging') {
        const parsed = PackagingSchema.safeParse(raw);
        if (!parsed.success) return invalid(parsed.error);
        if (!provider.findPackaging) return json(res, 501, { error: 'This server cannot find a kit’s packaging on photos' });
        return json(res, 200, await provider.findPackaging(toPhoto(parsed.data.photo, 'The photo'), parsed.data.what));
      }
      if (route === 'cap') {
        const parsed = CapSchema.safeParse(raw);
        if (!parsed.success) return invalid(parsed.error);
        if (!provider.capSide) return json(res, 501, { error: 'This server cannot tell which way a bottle stands' });
        return json(res, 200, { cap: await cap(toPhoto(parsed.data.photo, 'The photo')) });
      }
      if (route === 'whole') {
        const parsed = WholeSchema.safeParse(raw);
        if (!parsed.success) return invalid(parsed.error);
        if (!provider.wholeBottle) return json(res, 501, { error: 'This server cannot draw bottles' });
        const drawn = await whole(toPhoto(parsed.data.photo, 'The photo'));
        return json(res, 200, { photo: { type: drawn.type, data: Buffer.from(drawn.data).toString('base64') } });
      }
      const parsed = LabelsSchema.safeParse(raw);
      if (!parsed.success) return invalid(parsed.error);
      if (!provider.readLabels) return json(res, 501, { error: 'This server cannot read labels' });
      const crops = parsed.data.crops.map((c, i) => toPhoto(c, `Crop ${i + 1}`));
      return json(res, 200, await provider.readLabels(crops, parsed.data.components, parsed.data.views));
    } catch (error) {
      if (error instanceof BadPhoto) return json(res, 400, { error: error.message });
      throw error;
    }
  };
}
