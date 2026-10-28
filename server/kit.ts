import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { AIProvider, LabelTarget, Photo, ReadLabelsRequest, RecognizeKitRequest, SegmentBottlesRequest } from '../shared/ai.ts';

/**
 * Kit photos (KitVision in shared/ai.ts, server/ai/vision.ts):
 *
 *   POST /api/kit/recognize   RecognizeKitRequest   → RecognizedKit      Muse Spark reads the kit's box
 *   POST /api/kit/segment     SegmentBottlesRequest → SegmentedBottles   SAM 3.1 finds the bottles
 *   POST /api/kit/labels      ReadLabelsRequest     → ReadLabels         Muse Spark reads each bottle's crop
 *
 * JSON up to 8 MB, photos as base64 JPEG, PNG or WebP. Errors are { error } with 400 (not a photo, bad fields), 404,
 * 405, 413, 415, 501 (this provider cannot look at photos); a model that fails throws UpstreamError, which app.ts
 * answers with 502.
 */

export const MAX_KIT_JSON = 8 * 1024 * 1024;
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
const SegmentSchema = z.object({
  photo: PhotoData,
  points: z.array(PointSchema).max(20).optional(),
  index: z.int().min(0).max(1000).optional(),
}) satisfies z.ZodType<SegmentBottlesRequest>;
const LabelTargetSchema = z.object({
  id: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(200),
  role: z.string().max(40),
  kit: z.boolean(),
  labels: z.array(z.string().max(100)).max(10),
}) satisfies z.ZodType<LabelTarget>;
const LabelsSchema = z.object({
  crops: z.array(PhotoData).min(1).max(MAX_CROPS),
  components: z.array(LabelTargetSchema).min(1).max(30),
}) satisfies z.ZodType<ReadLabelsRequest>;

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
export function createKitHandler(provider: AIProvider) {
  return async function kit(req: IncomingMessage, res: ServerResponse, path: string) {
    const route = path.slice('/api/kit/'.length);
    if (!['recognize', 'segment', 'labels'].includes(route)) return json(res, 404, { error: 'Not found' });
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      return json(res, 405, { error: 'Use POST' });
    }
    const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
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
        const { photo, points, index } = parsed.data;
        return json(res, 200, await provider.segmentBottles(toPhoto(photo, 'The photo'), points, index));
      }
      const parsed = LabelsSchema.safeParse(raw);
      if (!parsed.success) return invalid(parsed.error);
      if (!provider.readLabels) return json(res, 501, { error: 'This server cannot read labels' });
      const crops = parsed.data.crops.map((c, i) => toPhoto(c, `Crop ${i + 1}`));
      return json(res, 200, await provider.readLabels(crops, parsed.data.components));
    } catch (error) {
      if (error instanceof BadPhoto) return json(res, 400, { error: error.message });
      throw error;
    }
  };
}
