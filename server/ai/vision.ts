import { z } from 'zod';
import type { Box, CapSide, KitVision, LabelMatch, LabelTarget, Photo, Point, ReadLabel, ReadLabels, RecognizedKit, SegmentedBottles, Sighting as Seen, TrackedBottles, Video } from '../../shared/ai.ts';
import { area, boxAt, overlap, sampleLayout } from '../../shared/kit.ts';
import { finished, UpstreamError } from './provider.ts';
import { bcaFacts, knownProtocols, localProtocolId } from './protocols.ts';
import { samOutline, type SamMask } from './samMask.ts';
import { costOf, meter, PER, usageLine } from './usage.ts';
import { videoFrameTimes } from './videoFrames.ts';
import { smallVideo } from './videoSmall.ts';

/**
 * Kit photos behind KitVision (shared/ai.ts): Muse Spark reads a kit's box (recognizeKit) and each bottle's label
 * (readLabels), SAM 3.1 finds the bottles (segmentBottles). The call shapes and replies were checked against the live
 * API on 2026-10-28; scripts/kit-vision.ts runs all three on any photo and keeps the raw replies in data/smoke/kit/.
 * Nothing here logs the key, a prompt or a photo: only timings.
 *
 * A label only counts as read when the words the model read name the component (namedBy): a match the model picked
 * without those words comes back as a guess, and one the evidence disagrees on as a mismatch, which the app asks the
 * user to confirm or settle. A video goes to SAM made small (videoSmall.ts): a third of the time.
 */

export const VISION_MODEL = 'muse-spark-1.3';
export const SAM_MODEL = 'sam-3.1';
export const IMAGE_MODEL = 'muse-image-1.0';

/**
 * What Muse Image is asked for a bottle's crop: the same bottle, whole, where it is in the frame. On the BCA kit's
 * Reagent B, held in a gloved hand that hid its cap, it drew the cap and neck and kept the bottle's place and label.
 * The background is dark so a pale bottle's outline can be told from it.
 */
export const WHOLE_PROMPT =
  'This photo shows a reagent bottle standing upright in the middle, partly hidden by other things (a hand, a box) or cut off at the edge of the photo. Show the same bottle alone and whole: complete every part of it that is hidden or cut off, such as its cap and neck. Keep the bottle exactly where it is in the frame, at the same size, with its exact shape, colours, and every word on its label unchanged. Remove everything that is not the bottle. Plain solid dark grey background, no shadow.';
/** What SAM is asked to find. It finds bottles, vials and ampules alike, and leaves the kit's box out. */
export const SAM_PROMPT = 'bottle';
/**
 * …and the kit's own packaging, asked apart, so a photo of it can be the kit's cover and its thumbnail show it
 * (src/screens/kit/cover.ts). SAM is asked first for what Muse Spark says it is (RecognizedKit's `packaging`), then
 * for this: it knows some words and not others. On the BCA kit's product shots "box" found the box behind the bottles
 * (0.43 of the photo); on the same shot with a foil pouch instead, "pouch" and "foil bag" found nothing where "bag"
 * and "package" found it. "package" found the box, the Albumin Standard's box and the pouch, and nothing on photos of
 * a bottle alone (where it does catch bottles, it is less sure of them than of the packaging).
 */
export const PACKAGING_PROMPT = 'package';
/** Packaging smaller than this share of the photo is something else on the bench, not the kit photographed. */
export const MIN_PACKAGING_AREA = 0.1;
/** At most this many bottles a photo: the biggest. */
export const MAX_BOTTLES = 16;
/** Smaller than this share of the photo is a speck, not a bottle (an ampule in a 500 px product shot is 0.6 %). */
const MIN_AREA = 0.0005;

type Json = Record<string, any>;

// ---------------------------------------------------------------------------------------------------------------
// SAM 3.1

/**
 * One object SAM found: its box as fractions of the photo, its mask as it came (for samMask.ts to decode), the id it
 * came under (a prompted object keeps the id the prompt gave it) and, when asked for, how sure SAM is (0–1).
 */
export type SamRecord = { box: Box; mask?: SamMask; id?: number; score?: number };

/** "x1=215;y1=318;c=0.96" → each field by its key, so a token reads the same with or without the confidence. */
function fieldsOf(text: string): Record<string, string> {
  const f: Record<string, string> = {};
  for (const pair of text.split(';')) {
    const at = pair.indexOf('=');
    if (at > 0) f[pair.slice(0, at).trim()] = pair.slice(at + 1);
  }
  return f;
}

/**
 * SAM 3.1's reply text → each object's box as fractions of the photo, with its mask. It answers /responses with one
 * output_text like
 *   <0f>0<|box;x1=215;y1=318;x2=233;y2=391;w=500;h=461;c=0.96|><|mask;x=0;y=0;c=0.96;data=74,19,~…|>,1<|box;…|><|mask;…|>
 * one box per object in pixels of the photo it was sent (w × h), then its mask: the raster's height and width (the
 * box's), one character saying how it is coded (~ lossless, ! one-bit) and the payload, read to the token's end since
 * the payload's alphabet has ">" in it. `c` comes only when asked for (dev.meta.ai/docs/sam/reading-segmentation).
 */
export function parseSamRecords(text: string): SamRecord[] {
  const records: SamRecord[] = [];
  for (const m of text.matchAll(/(?:<\d+f>)?(\d+)?<\|box;([^|>]*)\|>(?:<\|mask;(.*?)\|>)?/g)) {
    const b = fieldsOf(m[2]);
    const [x1, y1, x2, y2, w, h] = ['x1', 'y1', 'x2', 'y2', 'w', 'h'].map(k => Number(b[k]));
    if (![x1, y1, x2, y2, w, h].every(Number.isFinite) || w <= 0 || h <= 0) continue;
    const left = Math.max(0, Math.min(x1, x2)) / w;
    const top = Math.max(0, Math.min(y1, y2)) / h;
    const right = Math.min(w, Math.max(x1, x2)) / w;
    const bottom = Math.min(h, Math.max(y1, y2)) / h;
    if (!(right > left && bottom > top)) continue;
    const record: SamRecord = { box: { x: left, y: top, width: right - left, height: bottom - top } };
    if (m[1] !== undefined) record.id = Number(m[1]);
    const score = Number(b.c);
    if (b.c !== undefined && Number.isFinite(score)) record.score = score;
    const raster = m[3] !== undefined ? /^(\d+),(\d+),(.+)$/s.exec(fieldsOf(m[3]).data ?? '') : null;
    if (raster) {
      const [height, width, data] = [Number(raster[1]), Number(raster[2]), raster[3]];
      if (height > 0 && width > 0 && data.length > 1) {
        record.mask = { encoding: data[0] === '!' ? 'one_bit' : 'lossless', width, height, payload: data.slice(1), left: Math.max(0, Math.min(x1, x2)), top: Math.max(0, Math.min(y1, y2)), frameWidth: w, frameHeight: h };
      }
    }
    records.push(record);
  }
  return records;
}

/**
 * Where the user tapped, as SAM's point prompt: one object per tap, in the photo's own pixels
 * (dev.meta.ai/docs/sam/segmenting): <0f>1<|point;x=120;y=300;w=500;h=461|>,2<|point;…|>
 */
export function samPointPrompt(points: Point[], size: { width: number; height: number }): string {
  const { width: w, height: h } = size;
  const at = (v: number, max: number) => Math.min(max - 1, Math.max(0, Math.round(v * max)));
  return `<0f>${points.map((p, i) => `${i + 1}<|point;x=${at(p.x, w)};y=${at(p.y, h)};w=${w};h=${h}|>`).join(',')}`;
}

/**
 * Bottles known to be on a photo, as SAM's box prompt: each outlined whole within its box, in the photo's own pixels
 * (dev.meta.ai/docs/sam/segmenting): <0f>1<|box;x1=…;y1=…;x2=…;y2=…;w=…;h=…|>,2<|box;…|>. A point at a bottle's middle
 * lands on its label, and SAM may outline only a word of it (a 25 mL bottle: 0.003 of the photo by a point, 0.126 by
 * its box).
 */
export function samBoxPrompt(boxes: Box[], size: { width: number; height: number }): string {
  const { width: w, height: h } = size;
  const at = (v: number, max: number) => Math.min(max, Math.max(0, Math.round(v * max)));
  return `<0f>${boxes.map((b, i) => `${i + 1}<|box;x1=${at(b.x, w)};y1=${at(b.y, h)};x2=${at(b.x + b.width, w)};y2=${at(b.y + b.height, h)};w=${w};h=${h}|>`).join(',')}`;
}

/** A JPEG's, PNG's or WebP's size in pixels, read from its header; null when it cannot be read. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const b = bytes;
  const u16 = (i: number) => (b[i]! << 8) | b[i + 1]!;
  const le16 = (i: number) => b[i]! | (b[i + 1]! << 8);
  const le24 = (i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
  const ok = (width: number, height: number) => (width > 0 && height > 0 ? { width, height } : null);
  // PNG: the IHDR chunk's width and height.
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return ok(((b[16]! << 24) | (b[17]! << 16) | (b[18]! << 8) | b[19]!) >>> 0, ((b[20]! << 24) | (b[21]! << 16) | (b[22]! << 8) | b[23]!) >>> 0);
  }
  // JPEG: the first start-of-frame marker (C0–CF, but not the C4, C8 and CC tables).
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length; ) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1]!;
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return ok(u16(i + 7), u16(i + 5));
      if (marker === 0xd9 || marker === 0xda) return null;
      i += 2 + u16(i + 2);
    }
    return null;
  }
  // WebP: lossy (VP8 ), lossless (VP8L) or extended (VP8X).
  if (b.length >= 30 && String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...b.subarray(8, 12)) === 'WEBP') {
    const chunk = String.fromCharCode(...b.subarray(12, 16));
    if (chunk === 'VP8 ') return ok(le16(26) & 0x3fff, le16(28) & 0x3fff);
    if (chunk === 'VP8L') {
      const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
      return ok((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
    }
    if (chunk === 'VP8X') return ok(le24(24) + 1, le24(27) + 1);
  }
  return null;
}

/** SAM 3.1's reply text → the boxes alone. */
export function parseSam(text: string): Box[] {
  return parseSamRecords(text).map(r => r.box);
}

/**
 * What the app shows of SAM's boxes: no specks, no box mostly inside a bigger one (the same bottle twice, or its cap),
 * the MAX_BOTTLES biggest, left to right.
 */
export function tidyBoxes(boxes: Box[], max = MAX_BOTTLES): Box[] {
  return tidyBottles(boxes.map(box => ({ box })), max).map(b => b.box);
}

/** The same, for anything carrying its box (a record with its mask). */
export function tidyBottles<T extends { box: Box }>(items: T[], max = MAX_BOTTLES): T[] {
  const kept: T[] = [];
  for (const it of items.filter(it => area(it.box) >= MIN_AREA).sort((a, b) => area(b.box) - area(a.box))) {
    if (!kept.some(k => overlap(k.box, it.box) >= 0.85 * area(it.box))) kept.push(it);
  }
  return kept.slice(0, max).sort((a, b) => a.box.x - b.box.x || a.box.y - b.box.y);
}

/** What SAM is asked for to find the packaging Muse Spark named: its word or two, else PACKAGING_PROMPT. */
export function packagingPrompt(what: string): string {
  const said = what.toLowerCase().replace(/[^a-z\s-]/g, ' ').replace(/\s+/g, ' ').trim();
  return said && said.length <= 30 ? said : PACKAGING_PROMPT;
}

/** The kit's packaging among what SAM found for it: of those big enough, the one it is surest of, then the biggest. */
export function packagingOf(found: { box: Box; score?: number }[]): Box | null {
  const big = found.filter(r => area(r.box) >= MIN_PACKAGING_AREA);
  return big.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || area(b.box) - area(a.box))[0]?.box ?? null;
}

/** The text of a /responses reply: SAM's tokens. */
function outputText(body: Json): string {
  return (Array.isArray(body.output) ? body.output : [])
    .flatMap((o: Json) => (Array.isArray(o.content) ? o.content : []))
    .filter((c: Json) => c.type === 'output_text' && typeof c.text === 'string')
    .map((c: Json) => c.text as string)
    .join('');
}

/** For each point, the smallest box holding it, once each. */
export function boxesAt(boxes: Box[], points: Point[]): Box[] {
  const hits = points.map(p => boxAt(boxes, p)).filter((b): b is Box => b !== null);
  return hits.filter((b, i) => hits.indexOf(b) === i);
}

// ---------------------------------------------------------------------------------------------------------------
// SAM 3.1 on a video

/**
 * A video goes to SAM in the request up to this size, and through Meta's file store beyond it. The docs give requests
 * 50 MB, but a 16 MB MOV (21 MB of base64) came back 413, "too large … to persist": a request that does is sent again
 * through the store.
 */
export const INLINE_VIDEO_MAX = 8 * 1024 * 1024;
/** A followed video's frames the phone takes at most for the bottles' main pictures to share: each is one more photo. */
export const MAX_PICKS = 8;
/** …and in all, the frames its other views come from too: each is one more picture to take and cut. */
export const MAX_FRAMES = 14;
/** Each bottle is read from this many views at most: the label one blurs, cuts off or turns away, another may show. */
export const VIEWS_PER_BOTTLE = 3;
/** Something SAM followed through fewer frames than this is a flicker, not a bottle. */
const MIN_SIGHTINGS = 3;
/** …or that SAM was never this sure of (0–1): a cloth or a shadow it took for a bottle. */
const MIN_SURE = 0.5;
/** A frame shows a bottle well enough to be its main picture at this share of its best view… */
const MAIN_VIEW = 0.8;
/** …and well enough to be read too at this share. */
const GOOD_VIEW = 0.4;
/**
 * How far a bottle's middle moves from frame to frame (in fractions of the frame) for its view to count half: a blur.
 * At 30 frames a second, a phone's own; a video SAM follows at fewer (videoSmall.ts) moves as much more a frame.
 */
const BLUR_STEP = 0.004;
const BLUR_FPS = 30;

/**
 * One object on one frame of a video SAM followed: the frame, SAM's id for the object (the same on every frame), its
 * box, its outline once its mask is decoded, and how sure SAM is (0–1) when asked.
 */
export type Sighting = Seen & { score?: number };

/** SAM 3.1's line for one frame of a video, "<12f>3<|box;…|><|mask;…|>,5<|box;…|>…" → the frame and its objects. */
export function parseSamFrame(line: string): { frame: number; records: (SamRecord & { id: number })[] } | null {
  const frame = /^<(\d+)f>/.exec(line)?.[1];
  if (frame === undefined) return null;
  return { frame: Number(frame), records: parseSamRecords(line).filter((r): r is SamRecord & { id: number } => r.id !== undefined) };
}

/**
 * SAM 3.1's reply for a video: one line per frame where it saw anything, the frames not always in order
 * (dev.meta.ai/docs/sam/reading-segmentation) → every object on every frame.
 */
export function parseSamVideo(text: string): Sighting[] {
  return text.split('\n').flatMap(line => {
    const on = parseSamFrame(line);
    return on ? on.records.map(r => ({ frame: on.frame, id: r.id, box: r.box, ...(r.score !== undefined ? { score: r.score } : {}) })) : [];
  });
}

/** Whether SAM was sure enough of a sighting to draw it: a cloth or a shadow it took for a bottle is not. */
const sure = (s: { score?: number }) => s.score === undefined || s.score >= MIN_SURE;

const touchesEdge = (b: Box) => b.x <= 0.005 || b.y <= 0.005 || b.x + b.width >= 0.995 || b.y + b.height >= 0.995;
const middle = (b: Box) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

/**
 * How well each sighting of one bottle shows its label: its size; a tenth of it where it touches the frame's edge
 * (cut off there); less the faster it moves between the frames around it (the phone moving, a blur). Best first.
 */
function viewsOf(track: Sighting[], fps = BLUR_FPS): { s: Sighting; view: number }[] {
  const inOrder = [...track].sort((a, b) => a.frame - b.frame);
  const blur = (BLUR_STEP * BLUR_FPS) / fps;
  const close = Math.max(1, Math.round((3 * fps) / BLUR_FPS));
  return inOrder
    .map((s, i) => {
      const near = [inOrder[i - 1], inOrder[i + 1]].filter((n): n is Sighting => !!n && Math.abs(n.frame - s.frame) <= close);
      const at = middle(s.box);
      // With no frame close by its motion is unknown: as fast as a blur.
      const step = near.length ? Math.max(...near.map(n => Math.hypot(middle(n.box).x - at.x, middle(n.box).y - at.y) / Math.max(1, Math.abs(n.frame - s.frame)))) : blur;
      return { s, view: (area(s.box) * (touchesEdge(s.box) ? 0.1 : 1)) / (1 + step / blur) };
    })
    .sort((a, b) => b.view - a.view);
}

/** Whether SAM followed `a` inside `b` (a cap apart from its bottle): mostly inside it on most frames they share. */
function followedInside(a: Sighting[], b: Sighting[]): boolean {
  const there = new Map(b.map(s => [s.frame, s.box]));
  const shared = a.filter(s => there.has(s.frame));
  const within = shared.filter(s => {
    const o = there.get(s.frame)!;
    return area(o) > area(s.box) && overlap(o, s.box) >= 0.85 * area(s.box);
  });
  return shared.length > 0 && within.length >= 0.6 * shared.length;
}

/**
 * The frames to take from a followed video and the bottles to read on each. Every bottle once as its main picture (its
 * photo, its cut-out): again and again the frame where the most bottles not yet placed show nearly at their best
 * (MAIN_VIEW), up to `max` frames, any still left where each shows best. Then up to VIEWS_PER_BOTTLE views of each in
 * all, from other moments (apart in time, so from other angles too), good enough to read (GOOD_VIEW), on frames already
 * taken where they can be, up to MAX_FRAMES. A view's worth is its size, cut off at the edge or blurred by motion less
 * (viewsOf), the motion by the video's frames a second (`fps`). Flickers, specks, what SAM was never sure of and a cap
 * followed apart from its bottle are no bottles. Pure, so it is tested.
 */
export function framesToRead(seen: Sighting[], max = MAX_PICKS, views = VIEWS_PER_BOTTLE, fps = BLUR_FPS): TrackedBottles['picks'] {
  const tracks = new Map<number, Sighting[]>();
  for (const s of seen) if (area(s.box) >= MIN_AREA) tracks.set(s.id, [...(tracks.get(s.id) ?? []), s]);
  for (const [id, track] of [...tracks]) {
    if (track.length < MIN_SIGHTINGS || Math.max(...track.map(s => s.score ?? 1)) < MIN_SURE) tracks.delete(id);
  }
  for (const [id, track] of [...tracks]) if ([...tracks].some(([other, t]) => other !== id && followedInside(track, t))) tracks.delete(id);
  const ranked = new Map([...tracks].map(([id, track]) => [id, viewsOf(track, fps)]));
  const viewAt = (id: number, frame: number) => ranked.get(id)!.find(v => v.s.frame === frame);

  // Main pictures: few frames, each bottle nearly at its best.
  const frames = new Map<number, { id: number; box: Box; main?: true }[]>();
  const main = new Map<number, number>();
  const left = new Set(ranked.keys());
  const candidates = [...new Set(seen.map(s => s.frame))];
  while (left.size && frames.size < max) {
    let pick: { frame: number; ids: number[]; view: number } | null = null;
    for (const frame of candidates) {
      if (frames.has(frame)) continue;
      const ids = [...left].filter(id => (viewAt(id, frame)?.view ?? 0) >= MAIN_VIEW * ranked.get(id)![0]!.view);
      const view = ids.reduce((n, id) => n + viewAt(id, frame)!.view, 0);
      if (ids.length && (!pick || ids.length > pick.ids.length || (ids.length === pick.ids.length && view > pick.view))) pick = { frame, ids, view };
    }
    if (!pick) break;
    frames.set(pick.frame, pick.ids.map(id => ({ id, box: viewAt(id, pick!.frame)!.s.box, main: true as const })));
    for (const id of pick.ids) (main.set(id, pick.frame), left.delete(id));
  }
  for (const id of left) {
    const best = ranked.get(id)![0]!.s;
    frames.set(best.frame, [...(frames.get(best.frame) ?? []), { id, box: best.box, main: true }]);
    main.set(id, best.frame);
  }

  // Other views: apart in time, good enough, on frames already taken where they can be.
  for (const [id, list] of ranked) {
    const best = list[0]!.view;
    const span = list.reduce((n, v) => Math.max(n, v.s.frame), 0) - list.reduce((n, v) => Math.min(n, v.s.frame), Infinity);
    const apart = Math.max(6, span / (views * 2));
    const chosen = [main.get(id)!];
    const worth = (v: { s: Sighting; view: number }) => v.view * (frames.has(v.s.frame) ? 1.2 : 1);
    for (const v of [...list].sort((a, b) => worth(b) - worth(a))) {
      if (chosen.length >= views) break;
      if (v.view < GOOD_VIEW * best || chosen.some(f => Math.abs(f - v.s.frame) < apart)) continue;
      if (!frames.has(v.s.frame) && frames.size >= MAX_FRAMES) continue;
      chosen.push(v.s.frame);
      frames.set(v.s.frame, [...(frames.get(v.s.frame) ?? []), { id, box: v.s.box }]);
    }
  }
  return [...frames]
    .sort(([a], [b]) => a - b)
    .map(([frame, bottles]) => ({ frame, bottles: bottles.sort((a, b) => a.box.x - b.box.x || a.box.y - b.box.y) }));
}

// ---------------------------------------------------------------------------------------------------------------
// Which way a bottle's cap points

const capInstructions = `You look at a photo of lab bottles, vials or tubes. Find the one in the middle of the picture and say which side of the picture its cap or lid points to: "up", "down", "left" or "right". Judge by the cap itself (a screw cap, a snap lid, a stopper, a crimp seal), not by which end is narrower: a vial's cap is often wider than its rounded foot. The label's printing helps: it reads the right way up, or runs from the foot towards the cap, when the bottle stands on its foot. "none" only when you cannot tell.
- look: in a few words, the cap you see and where it is.`;

export const capFormat = {
  type: 'json_schema',
  json_schema: {
    name: 'Cap',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['look', 'cap'],
      properties: { look: { type: 'string' }, cap: { type: 'string', enum: ['up', 'down', 'left', 'right', 'none'] } },
    },
  },
};

/** Muse Spark's answer about a cap → the side it points to, or null. */
export function parseCap(content: unknown): CapSide | null {
  try {
    const cap = z.object({ cap: z.string() }).parse(JSON.parse(String(content))).cap;
    return cap === 'up' || cap === 'down' || cap === 'left' || cap === 'right' ? cap : null;
  } catch {
    throw new UpstreamError('Muse Spark answered about the cap in a shape Chapp does not know');
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The kit's box

const kitInstructions = `You identify lab kits from a photo of the kit: its packaging (a box, a bag or pouch, a case, a carton, a tin) or its bottles. Report only what is printed and you can actually read; never fill anything in from memory.
- found: true when a kit's packaging or its product name is readable.
- vendor: the brand as printed (for example "Thermo Scientific").
- name: the kit's name as printed (for example "Pierce BCA Protein Assay Kit").
- catalog: the kit's catalog or product number as printed on its packaging (not a bottle's), letters and digits only.
- packaging: when the name is printed on packaging the kit or one of its parts came in, what that packaging is, in one or two plain words ("box", "bag", "pouch", "case"); "" when you read it only on a bottle's, vial's or tube's own label, or see no packaging.
- read: the words you read, briefly.
Unused fields "".`;

export const kitFormat = {
  type: 'json_schema',
  json_schema: {
    name: 'Kit',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['found', 'vendor', 'name', 'catalog', 'packaging', 'read'],
      properties: { found: { type: 'boolean' }, vendor: { type: 'string' }, name: { type: 'string' }, catalog: { type: 'string' }, packaging: { type: 'string' }, read: { type: 'string' } },
    },
  },
};

const KitWire = z.object({ found: z.boolean(), vendor: z.string().default(''), name: z.string().default(''), catalog: z.string().default(''), packaging: z.string().default('') });

const plain = (s: string) => s.toLowerCase().replace(/[™®©]/g, '').replace(/[^a-z0-9µ]+/g, ' ').trim();

/** Muse Spark's answer about a kit's box → RecognizedKit, with the protocol this machine has for it when there is one. */
export function parseRecognized(content: unknown): RecognizedKit {
  let wire: z.infer<typeof KitWire>;
  try {
    wire = KitWire.parse(JSON.parse(String(content)));
  } catch {
    throw new UpstreamError('Muse Spark answered about the kit in a shape Chapp does not know');
  }
  const vendor = wire.vendor.trim();
  const name = wire.name.replace(/\s+/g, ' ').trim();
  const catalog = wire.catalog.replace(/^(prod(uct)?|cat(alog)?|no|#|\.|\s)+/i, '').replace(/\s+/g, '').trim();
  if (!wire.found || !name) return { found: false };
  const kit = { vendor, catalog, name };
  // By catalog number; else a protocol whose kit has exactly this name, the vendor's name in front or not.
  const sameName = knownProtocols().find(p => [plain(name), plain(name).replace(plain(vendor), '').trim()].includes(plain(p.kit.name)));
  const protocolId = localProtocolId({ kit }) ?? sameName?.id ?? null;
  const packaging = wire.packaging.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 30);
  return { found: true, kit, protocolId, ...(protocolId ? {} : { query: [vendor, name, catalog].filter(Boolean).join(' ') }), ...(packaging ? { packaging } : {}) };
}

// ---------------------------------------------------------------------------------------------------------------
// Labels

export function labelsInstructions(targets: LabelTarget[], grouped = false): string {
  const list = targets.map(t => {
    const says = t.labels.filter(Boolean);
    const label = says.length ? `label says ${says.map(l => `"${l}"`).join(' or ')}` : t.kit ? 'no label words known' : "the user's own bottle, no kit label";
    const volumes = t.volumes?.length ? `; comes as ${t.volumes.join(' or ')}` : '';
    return `- ${t.id}: ${t.name} (${t.role}; ${label}${volumes})`;
  });
  const each = grouped ? 'bottle' : 'picture';
  return `You read the labels of bottles in photos of a lab kit. Each picture is one object cut out of a photo of the bench.${grouped ? '\nThe pictures come in groups, one group per bottle: the same bottle at different moments of a video. Read its label from all of its pictures together (one may show the words another blurs, cuts off or turns away) and answer once per bottle.' : ''}
For every ${each}, in order:
- crop: its number.
- bottle: false when it is not a bottle, vial, tube, jar or box at all (a cloth, a hand, a shelf, the bench); else true.
- name: the product name printed on its label, word for word, only as far as you can actually read it (for example "Pierce BCA Protein Assay Reagent A"). "" when you cannot read the label. Never fill in words you cannot see.
- volume: the volume printed on its label, as printed ("25 ml", "500 mL"). "" when you cannot read one.
- looks: what it is, in two or three plain lowercase words ("tall bottle", "small blue bottle", "glass ampule").
- component: the id of the component below that the label you read names. "" when the label names none of them, or you could not read it.
- guess: when you could not read the label, the component it most likely is from its shape, size, colour and the other ${grouped ? 'bottles' : 'pictures'}. "" when you cannot tell, or you read the label.
- seen: ${grouped ? 'how many of its pictures show the words you put in name' : '1 when you read words on its label, else 0'}.
- differs: words you read on ${grouped ? 'any of its pictures' : 'it'} that name a different product or bottle than name does, word for word. "" when nothing you read disagrees.
Components of this run:
${list.join('\n')}`;
}

export function labelsFormat(targets: LabelTarget[]) {
  const ids = ['', ...targets.map(t => t.id)];
  return {
    type: 'json_schema',
    json_schema: {
      name: 'Labels',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['items'],
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['crop', 'bottle', 'name', 'volume', 'looks', 'component', 'guess', 'seen', 'differs'],
              properties: {
                crop: { type: 'integer' },
                bottle: { type: 'boolean' },
                name: { type: 'string' },
                volume: { type: 'string' },
                looks: { type: 'string' },
                component: { type: 'string', enum: ids },
                guess: { type: 'string', enum: ids },
                seen: { type: 'integer' },
                differs: { type: 'string' },
              },
            },
          },
        },
      },
    },
  };
}

const LabelsWire = z.object({
  items: z.array(
    z.object({
      crop: z.number().optional(),
      bottle: z.boolean().default(true),
      name: z.string().default(''),
      volume: z.string().default(''),
      looks: z.string().default(''),
      component: z.string().default(''),
      guess: z.string().default(''),
      seen: z.number().optional(),
      differs: z.string().default(''),
    }),
  ),
});

const spaced = (s: string) => ` ${plain(s.normalize('NFKC'))} `;

/** The components whose label words are in `text` ("Pierce BCA Protein Assay Reagent A" names Reagent A). */
export function namedBy(text: string, targets: LabelTarget[]): LabelTarget[] {
  const said = spaced(text);
  return targets.filter(t => t.labels.some(l => plain(l) !== '' && said.includes(spaced(l))));
}

/**
 * The components a label still names where the photo cuts it off: the words read are a run of one of its names' words,
 * the first and last perhaps cut short where the label turns out of sight ("Converter M" on a tube is "Converter Mix
 * B"), with at least one word of three letters or more read whole.
 */
export function partlyNamedBy(text: string, targets: LabelTarget[]): LabelTarget[] {
  const words = (s: string) => plain(s.normalize('NFKC')).split(' ').filter(Boolean);
  const read = words(text);
  if (!read.length) return [];
  const within = (name: string[]) => {
    for (let at = 0; at + read.length <= name.length; at++) {
      let whole = false;
      const fits = read.every((w, i) => {
        const n = name[at + i]!;
        if (w === n) {
          whole ||= w.length >= 3;
          return true;
        }
        return (i === read.length - 1 && n.startsWith(w)) || (i === 0 && n.endsWith(w));
      });
      if (fits && whole) return true;
    }
    return false;
  };
  return targets.filter(t => t.labels.some(l => within(words(l))));
}

/** A volume as printed ("25 ml", "2,5 mL", "500μL") in mL; null when there is none. */
export function millilitres(text: string): number | null {
  const m = /(\d+(?:[.,]\d+)?)\s*(ml|l|µl|μl|ul)\b/i.exec(text.normalize('NFKC'));
  if (!m) return null;
  const value = Number(m[1]!.replace(',', '.'));
  const unit = m[2]!.toLowerCase();
  return unit === 'l' ? value * 1000 : unit === 'ml' ? value : value / 1000;
}

/**
 * The components a label's volume names: those the kit has in exactly that volume ("25 ml" is Reagent B where Reagent
 * A comes as 500 mL), when the words read are that component's too (a word of three letters or more of its name or
 * label: "BCA", "Reagent"), so another product's 25 mL bottle is not one.
 */
export function volumeNames(volume: string, text: string, targets: LabelTarget[]): LabelTarget[] {
  const ml = millilitres(volume);
  if (ml === null) return [];
  const words = new Set(plain(text.normalize('NFKC')).split(' ').filter(w => w.length >= 3));
  return targets.filter(t => {
    const sized = (t.volumes ?? []).some(v => Math.abs((millilitres(v) ?? -1) - ml) < 1e-6);
    const own = [t.name, ...t.labels].some(n => plain(n).split(' ').some(w => words.has(w)));
    return sized && own;
  });
}

/** "glass ampule": two or three plain words, never empty. */
const looksOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9µ\- ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || 'bottle';

/**
 * How sure Chapp is of a label's match (0–1), by what backs it: a name read whole (0.9) or what shows of one, or its
 * volume (0.75), each more picture that showed those words a little more; evidence that disagrees (0.4); a guess from
 * shape and colour (0.25); nothing named (0). Pure, so it is tested.
 */
export function labelConfidence(match: LabelMatch, whole: boolean, seen: number): number {
  if (match === 'read') return Math.min(0.98, (whole ? 0.9 : 0.75) + 0.05 * Math.max(0, seen - 1));
  return match === 'mismatch' ? 0.4 : match === 'guess' ? 0.25 : 0;
}

/** Words that say nothing of which product it is: every kit's labels have them. */
const LABEL_GENERIC = new Set(['protein', 'assay', 'assays', 'reagent', 'reagents', 'kit', 'buffer', 'solution', 'standard', 'standards', 'store', 'for', 'research', 'use', 'only', 'the', 'and', 'with']);

/** Whether words read share a word that tells products apart with this run's bottles' names ("BCA"). */
export function ofThisRun(text: string, targets: LabelTarget[]): boolean {
  const words = (s: string) => plain(s.normalize('NFKC')).split(' ').filter(w => w.length >= 3 && !LABEL_GENERIC.has(w));
  const theirs = new Set(targets.flatMap(t => [t.name, ...t.labels].flatMap(words)));
  return words(text).some(w => theirs.has(w));
}

/** The components words name: by a name whole, else by what shows of one, when that fits one alone. */
function wordsName(text: string, targets: LabelTarget[]): LabelTarget[] {
  const named = namedBy(text, targets);
  if (named.length) return named;
  const partly = partlyNamedBy(text, targets);
  return partly.length === 1 ? partly : [];
}

/**
 * Muse Spark's reading of `count` crops (or bottles, read from several crops each: `views`) → ReadLabels, each match
 * checked against the words read. What the label says wins over what the model picked; a pick the words don't back is
 * a guess. Where the evidence disagrees (the words name one bottle and the model picked another, the words name two,
 * or another of its pictures shows another's name) it is a mismatch, every bottle named a candidate, for the user to
 * settle: never one of them made to fit.
 */
export function parseLabels(content: unknown, targets: LabelTarget[], count: number, views?: number[]): ReadLabels {
  let wire: z.infer<typeof LabelsWire>;
  try {
    wire = LabelsWire.parse(JSON.parse(String(content)));
  } catch {
    throw new UpstreamError('Muse Spark answered about the labels in a shape Chapp does not know');
  }
  const byCrop = (i: number) => wire.items.find(it => it.crop === i + 1) ?? (wire.items.every(it => it.crop === undefined) ? wire.items[i] : undefined);
  const labels = Array.from({ length: count }, (_, i): ReadLabel => {
    const of = views?.[i] ?? 1;
    const item = byCrop(i);
    if (!item) return { text: '', volume: '', looks: 'bottle', componentId: null, match: 'none', confidence: 0, views: { read: 0, of } };
    const text = item.name.replace(/\s+/g, ' ').trim();
    const volume = item.volume.replace(/\s+/g, ' ').trim();
    const seen = Math.max(0, Math.min(of, Math.round(item.seen ?? (text ? 1 : 0)), text ? of : 0));
    // Not a bottle at all: nothing to match, nothing to ask about.
    if (!item.bottle) return { text, volume, looks: looksOf(item.looks), componentId: null, match: 'other', bottle: false, confidence: 0, views: { read: seen, of } };
    const claimed = targets.find(t => t.id === item.component);
    const guessed = targets.find(t => t.id === item.guess);
    const named = text ? namedBy(text, targets) : [];
    // A label cut off by the photo: read when what shows fits one bottle of this run alone and the model picked it.
    const partly = !named.length && text ? partlyNamedBy(text, targets) : [];
    // …or when its volume is one bottle of this run's alone, the words read that bottle's too.
    const sized = !named.length && text ? volumeNames(volume, text, targets) : [];
    const picked = claimed ?? guessed;
    let componentId: string | null = null;
    let match: LabelMatch = 'none';
    let whole = false;
    if (named.length === 1) [componentId, match, whole] = [named[0].id, 'read', true];
    else if (claimed && named.includes(claimed)) [componentId, match, whole] = [claimed.id, 'read', true];
    else if (picked && partly.length === 1 && partly[0] === picked) [componentId, match] = [picked.id, 'read'];
    else if (sized.length === 1) [componentId, match] = [sized[0]!.id, 'read'];
    else if (picked) [componentId, match] = [picked.id, 'guess'];
    // Words of this kit that say no one bottle ("Pierce BCA Protein Assay"): nobody can tell which; else another product.
    else if (text) match = ofThisRun(text, targets) ? 'none' : 'other';
    // What else the evidence names: the model's pick where the words name another, every bottle words naming two name,
    // and what another of its pictures shows.
    const also = new Set<string>();
    if (match === 'read' && claimed) also.add(claimed.id);
    if (named.length > 1) for (const t of named) also.add(t.id);
    for (const t of item.differs.trim() ? wordsName(item.differs, targets) : []) also.add(t.id);
    if (componentId) also.delete(componentId);
    if (also.size) {
      const candidates = [...(componentId ? [componentId] : []), ...also];
      return { text, volume, looks: looksOf(item.looks), componentId: candidates[0]!, match: 'mismatch', candidates, confidence: labelConfidence('mismatch', whole, seen), views: { read: seen, of } };
    }
    return { text, volume, looks: looksOf(item.looks), componentId, match, confidence: labelConfidence(match, whole, seen), views: { read: seen, of } };
  });
  return { labels };
}

// ---------------------------------------------------------------------------------------------------------------

export type VisionOptions = {
  apiKey: string;
  baseUrl?: string;
  /** Injected by tests; the global fetch otherwise. */
  fetch?: typeof fetch;
  log?: (line: string) => void;
  /** Milliseconds per call. */
  timeouts?: { recognize?: number; segment?: number; labels?: number; whole?: number; cap?: number; track?: number };
  /** Videos bigger than this go through Meta's file store (INLINE_VIDEO_MAX). */
  inlineVideoMax?: number;
  /** A video made small for SAM before it is sent (videoSmall.ts); null sends it as it is. */
  smallVideo?: ((video: Video) => Promise<Video | null>) | null;
  /** How hard Muse Spark thinks about photos (VISION_EFFORT unless set): scripts/kit-vision.ts --effort compares them. */
  effort?: 'minimal' | 'low' | 'medium' | 'high';
};

/**
 * How hard Muse Spark thinks about a kit's photos. On 2026-11-03, minimal read the 8 bottles of the user's BCA video
 * as low did, in 6.2–7.0 s against 11.4–13.7 s, and the kit on 7 photos the same in 2.7–5.4 s against 4.9–15.5 s; on
 * the tiniest print (an ampule's) it more often reads only part of a word, which leaves a guess to confirm.
 */
export const VISION_EFFORT = 'minimal';
/**
 * …but harder about which way a cap points, asked in the background for the step pictures (no one waits on it): on
 * three of the video's bottles turned four ways, low answered 12 of 12, minimal 11 (one ampule upside down, which
 * asking it turned over too caught).
 */
export const CAP_EFFORT = 'low';

/** The upstream's own error message, short, with the key scrubbed in case it was echoed. */
function upstreamMessage(text: string, apiKey: string): string {
  let message = text;
  try {
    const body = JSON.parse(text);
    message = body?.error?.message ?? body?.message ?? body?.detail ?? (typeof body?.error === 'string' ? body.error : text);
  } catch {
    // Not JSON: keep the text.
  }
  return String(message).split(apiKey).join('***').replace(/\s+/g, ' ').trim().slice(0, 200);
}

const dataUrl = (photo: Photo) => `data:${photo.type};base64,${Buffer.from(photo.data).toString('base64')}`;

/** Meta's models behind KitVision. Spark thinks at minimal effort here (VISION_EFFORT): the same answers, in half the time. */
export function createKitVision(options: VisionOptions): KitVision {
  const { apiKey, baseUrl = 'https://api.meta.ai/v1', log = (line: string) => console.log(line) } = options;
  if (!apiKey) throw new Error('Kit photos need MODEL_API_KEY in .env (see .env.example).');
  const fetchFn = options.fetch ?? globalThis.fetch;
  const timeouts = { recognize: 30_000, segment: 20_000, labels: 45_000, whole: 90_000, cap: 20_000, track: 150_000, ...options.timeouts };
  const inlineVideo = options.inlineVideoMax ?? INLINE_VIDEO_MAX;
  const shrink = options.smallVideo === undefined ? smallVideo : options.smallVideo;
  const effort = options.effort ?? VISION_EFFORT;

  /**
   * One call to the Model API, metered. With `stream`, the reply is asked for as server-sent events, each handed to
   * `onEvent` as it comes, and the call ends with the finished response; the caller giving up (`signal`) drops it.
   */
  async function call(what: string, path: string, body: Json, timeoutMs: number, stream?: { onEvent: (event: Json) => void; signal?: AbortSignal }): Promise<Json> {
    meter.check();
    const started = Date.now();
    const seconds = () => ((Date.now() - started) / 1000).toFixed(1);
    let text = '';
    let streamed: Json | undefined;
    try {
      const timeout = AbortSignal.timeout(timeoutMs);
      const res = await fetchFn(baseUrl + path, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', ...(stream ? { accept: 'text/event-stream' } : {}) },
        body: JSON.stringify(stream ? { ...body, stream: true } : body),
        signal: stream?.signal ? AbortSignal.any([timeout, stream.signal]) : timeout,
      });
      // A stream is read as it comes; an error, or a plain JSON answer to a streamed request, is read whole.
      if (res.ok && stream && res.body && (res.headers.get('content-type') ?? '').includes('text/event-stream')) streamed = await finished(res.body, stream.onEvent);
      else text = await res.text();
      if (!res.ok) {
        log(`[meta] ${what} failed after ${seconds()} s: ${res.status}`);
        throw new UpstreamError(`Meta ${what} failed (${res.status}): ${upstreamMessage(text, apiKey)}`);
      }
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      if (stream?.signal?.aborted) {
        log(`[meta] ${what} cancelled after ${seconds()} s`);
        throw new UpstreamError(`Meta ${what} was cancelled`);
      }
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      log(`[meta] ${what} ${timedOut ? 'timed out' : 'could not connect'} after ${seconds()} s`);
      throw new UpstreamError(timedOut ? `Meta ${what} timed out after ${Math.round(timeoutMs / 1000)} s` : `Could not reach the Meta API for ${what}`);
    }
    let reply: Json;
    try {
      reply = streamed ?? JSON.parse(text);
    } catch {
      log(`[meta] ${what} ${seconds()} s`);
      throw new UpstreamError(`Meta ${what} answered with something that is not JSON`);
    }
    // SAM is paid by the image, or by the frames of a video it followed (50 at least); Muse Image by the image; Muse
    // Spark by its tokens.
    const frames = Number(reply?.usage?.video_frames_processed) || 0;
    const byImage = body.model === SAM_MODEL ? (frames ? Math.max(50, frames) * PER.samFrame : PER.samImage) : body.model === IMAGE_MODEL ? PER.image : null;
    const cost = byImage ?? costOf(String(body.model), reply);
    meter.spend(cost);
    const used = byImage !== null ? `$${cost.toFixed(4)}` : usageLine(String(body.model), reply);
    log(`[meta] ${what} ${seconds()} s${used ? ` · ${used}` : ''}`);
    return reply;
  }

  /** A video into Meta's file store for an hour (POST /v1/files): its file id. */
  async function upload(video: Video, signal?: AbortSignal): Promise<string> {
    meter.check();
    const form = new FormData();
    form.append('purpose', 'user_data');
    form.append('expires_after[anchor]', 'created_at');
    form.append('expires_after[seconds]', '3600');
    form.append('file', new Blob([new Uint8Array(video.data)], { type: video.type }), video.type === 'video/quicktime' ? 'kit.mov' : 'kit.mp4');
    let text: string;
    try {
      const timeout = AbortSignal.timeout(timeouts.track);
      const res = await fetchFn(`${baseUrl}/files`, { method: 'POST', headers: { authorization: `Bearer ${apiKey}` }, body: form, signal: signal ? AbortSignal.any([timeout, signal]) : timeout });
      text = await res.text();
      if (!res.ok) throw new UpstreamError(`Meta upload failed (${res.status}): ${upstreamMessage(text, apiKey)}`);
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      throw new UpstreamError('Could not upload the video to the Meta API');
    }
    const id = (JSON.parse(text) as { id?: unknown }).id;
    if (typeof id !== 'string' || !id) throw new UpstreamError('Meta upload answered without a file id');
    return id;
  }

  const spark = async (what: string, system: string, content: Json[], format: Json, timeoutMs: number, level: string = effort) => {
    const body = await call(what, '/chat/completions', {
      model: VISION_MODEL,
      reasoning_effort: level,
      messages: [{ role: 'system', content: system }, { role: 'user', content }],
      response_format: format,
      prompt_cache_key: `chapp-${what}`,
    }, timeoutMs);
    return body.choices?.[0]?.message?.content;
  };

  return {
    async recognizeKit(photo) {
      const content = [{ type: 'text', text: 'Which kit is this?' }, { type: 'image_url', image_url: { url: dataUrl(photo) } }];
      return parseRecognized(await spark('recognize-kit', kitInstructions, content, kitFormat, timeouts.recognize));
    },

    async segmentBottles(photo, points, _index, boxes) {
      // A tap is a point prompt: SAM outlines the thing under the finger, whatever it is (a tube, an ampule, a bottle
      // the word "bottle" missed). Bottles known to be there are box prompts. Without either, or when the photo's size
      // cannot be read, the noun finds every bottle.
      const size = points?.length || boxes?.length ? imageSize(photo.data) : null;
      const prompt = size && boxes?.length ? samBoxPrompt(boxes.slice(0, MAX_BOTTLES), size) : size && points?.length ? samPointPrompt(points.slice(0, MAX_BOTTLES), size) : SAM_PROMPT;
      const body = await call(size ? 'segment-at' : 'segment', '/responses', {
        model: SAM_MODEL,
        input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }, { type: 'input_image', image_url: dataUrl(photo) }] }],
        metadata: { include_confidence: 'true' },
      }, timeouts.segment);
      if (body.status === 'failed' || body.error) throw new UpstreamError(`Meta segment failed: ${upstreamMessage(JSON.stringify(body.error ?? {}), apiKey) || 'no reason given'}`);
      const found = parseSamRecords(outputText(body));
      // Prompted objects come back under the ids the prompt gave them (1, 2, … in tap order); a tap on nothing, not at all.
      const chosen = size
        ? found.filter(r => r.id !== undefined).sort((a, b) => a.id! - b.id!).filter((r, i, all) => all.findIndex(o => o.id === r.id) === i)
        : points?.length
          ? boxesAt(tidyBottles(found).map(r => r.box), points).map(box => found.find(r => r.box === box)!)
          : tidyBottles(found);
      // Each mask as an outline the phone draws and cuts along (samMask.ts); none when it cannot be decoded.
      const bottles = await Promise.all(chosen.map(async r => {
        const outline = r.mask ? await samOutline(r.mask) : undefined;
        return { box: r.box, ...(r.score !== undefined ? { score: r.score } : {}), ...(outline ? { outline } : {}), ...(size && r.id !== undefined ? { id: r.id } : {}) };
      }));
      return { bottles };
    },

    async trackBottles(original, live) {
      // SAM follows the video made small (fewer, smaller frames: a third of the time), else the video as it came.
      const shrinking = Date.now();
      const small = shrink ? await shrink(original).catch(() => null) : null;
      if (small) log(`[meta] small video ${((Date.now() - shrinking) / 1000).toFixed(1)} s · ${(original.data.length / 1e6).toFixed(1)} → ${(small.data.length / 1e6).toFixed(1)} MB`);
      const video = small ?? original;
      // When each frame starts, read from the video itself before SAM is asked (a few milliseconds).
      const times = await videoFrameTimes(video);
      live?.onVideo?.(times ? { times } : {});
      // Each frame as SAM is done with it (one line, one delta, in frame order): its masks outlined at once, so the phone
      // draws them as they come and cuts each bottle's photo along its outline on the frame it is taken from.
      const seen: Sighting[] = [];
      let pending = '';
      let outlined: Promise<unknown> = Promise.resolve();
      const frameDone = async (line: string) => {
        const on = parseSamFrame(line);
        if (!on) return;
        const bottles = await Promise.all(
          on.records.map(async r => ({ id: r.id, box: r.box, score: r.score, outline: r.mask && sure(r) ? await samOutline(r.mask) : undefined })),
        );
        for (const b of bottles) seen.push({ frame: on.frame, id: b.id, box: b.box, ...(b.outline ? { outline: b.outline } : {}), ...(b.score !== undefined ? { score: b.score } : {}) });
        live?.onFrame?.({ frame: on.frame, bottles: bottles.filter(sure).map(({ id, box, outline }) => ({ id, box, ...(outline ? { outline } : {}) })) });
      };
      const lines = (more: string) => {
        pending += more;
        let at: number;
        while ((at = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, at);
          pending = pending.slice(at + 1);
          outlined = outlined.then(() => frameDone(line));
        }
      };
      let deltas = false;
      let started = false;
      const onEvent = (event: Json) => {
        // SAM has the video once its reply begins.
        if (!started) {
          started = true;
          live?.onStage?.('started');
        }
        if (event.type !== 'response.output_text.delta' || typeof event.delta !== 'string') return;
        deltas = true;
        lines(event.delta);
      };
      const follow = (source: Json) =>
        call('track', '/responses', {
          model: SAM_MODEL,
          input: [{ role: 'user', content: [{ type: 'input_text', text: SAM_PROMPT }, { type: 'input_video', ...source }] }],
          // One-bit masks: several times smaller than the lossless ones (dev.meta.ai/docs/sam/segmenting), the same
          // outlines. How sure SAM is tells a cloth it took for a bottle from one.
          metadata: { mask_encoding: 'one_bit', include_confidence: 'true' },
        }, timeouts.track, { onEvent, signal: live?.signal });
      const inStore = async () => follow({ file_id: await upload(video, live?.signal) });
      // On its way to SAM: in the request itself, or through Meta's file store.
      live?.onStage?.('sending');
      const body =
        video.data.length <= inlineVideo
          ? await follow({ video_url: `data:${video.type};base64,${Buffer.from(video.data).toString('base64')}` }).catch(error => {
              if (error instanceof UpstreamError && error.message.includes('(413)')) return inStore();
              throw error;
            })
          : await inStore();
      if (body.status === 'failed' || body.error) throw new UpstreamError(`Meta track failed: ${upstreamMessage(JSON.stringify(body.error ?? {}), apiKey) || 'no reason given'}`);
      // A reply that came whole (not streamed) is read the same way, line by line; so is a last line without its end.
      if (!deltas) lines(outputText(body));
      lines('\n');
      await outlined;
      // Every frame is followed (the usage counts them, 50 at least); a video shorter than that, up to the last frame
      // seen. Its own count of frames, when it could be read, is the one its times go by.
      const counted = Number(body.usage?.video_frames_processed) || 0;
      const last = seen.reduce((n, s) => Math.max(n, s.frame + 1), 0);
      return {
        frames: times ? Math.max(times.length, last) : counted > 50 ? Math.max(counted, last) : last,
        ...(times ? { times } : {}),
        picks: framesToRead(seen, MAX_PICKS, VIEWS_PER_BOTTLE, times && times.length > 1 && times.at(-1)! > 0 ? (times.length - 1) / times.at(-1)! : BLUR_FPS),
        seen: seen.filter(sure).map(({ frame, id, box, outline }) => ({ frame, id, box, ...(outline ? { outline } : {}) })),
      };
    },

    async findPackaging(photo, what) {
      // Muse Spark's word first ("box", "bag"), then PACKAGING_PROMPT, which finds boxes and bags alike.
      for (const prompt of new Set([packagingPrompt(what), PACKAGING_PROMPT])) {
        const body = await call('find-packaging', '/responses', {
          model: SAM_MODEL,
          input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }, { type: 'input_image', image_url: dataUrl(photo) }] }],
          metadata: { include_confidence: 'true' },
        }, timeouts.segment);
        if (body.status === 'failed' || body.error) throw new UpstreamError(`Meta find-packaging failed: ${upstreamMessage(JSON.stringify(body.error ?? {}), apiKey) || 'no reason given'}`);
        const box = packagingOf(parseSamRecords(outputText(body)));
        if (box) return { box };
      }
      return { box: null };
    },

    async readLabels(crops, components, views) {
      if (!crops.length) return { labels: [] };
      const image = (crop: Photo) => ({ type: 'image_url', image_url: { url: dataUrl(crop) } });
      const content: Json[] = [];
      if (views?.length) {
        // Several views of each bottle: its pictures together, under its number.
        content.push({ type: 'text', text: `${views.length} bottle${views.length === 1 ? '' : 's'}:` });
        let at = 0;
        views.forEach((n, i) => {
          content.push({ type: 'text', text: `Bottle ${i + 1} (${n} picture${n === 1 ? '' : 's'}):` }, ...crops.slice(at, at + n).map(image));
          at += n;
        });
      } else {
        content.push({ type: 'text', text: `${crops.length} picture${crops.length === 1 ? '' : 's'}:` });
        crops.forEach((crop, i) => content.push({ type: 'text', text: `Picture ${i + 1}:` }, image(crop)));
      }
      const answer = await spark('read-labels', labelsInstructions(components, !!views?.length), content, labelsFormat(components), timeouts.labels);
      return parseLabels(answer, components, views?.length || crops.length, views);
    },

    async capSide(photo) {
      const content = [{ type: 'text', text: 'Which way does its cap point?' }, { type: 'image_url', image_url: { url: dataUrl(photo) } }];
      return parseCap(await spark('cap-side', capInstructions, content, capFormat, timeouts.cap, options.effort ?? CAP_EFFORT));
    },

    async wholeBottle(photo) {
      const body = await call('whole-bottle', '/images/edits', { model: IMAGE_MODEL, prompt: WHOLE_PROMPT, images: [{ image_url: dataUrl(photo) }], n: 1, output_format: 'png' }, timeouts.whole);
      const b64 = Array.isArray(body.data) ? body.data[0]?.b64_json : undefined;
      if (typeof b64 !== 'string' || !b64) throw new UpstreamError('Muse Image sent no picture back');
      return { type: 'image/png', data: new Uint8Array(Buffer.from(b64, 'base64')) };
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Mock: the drawn sample photos' bottles (shared/kit.ts), as the storyboard's Recognized artboard has them.

/** The BCA kit's bottles in the order the app lists them: Reagent A, Reagent B, the standard, the diluent. */
const SAMPLE_ROLES = ['reagent', 'reagent', 'standard', 'diluent'];

/**
 * Fixed answers, no network: the kit is the Pierce BCA; photo n's bottles are where the nth sample photo draws them;
 * crops are taken to be the run's bottles in order, the reagents read, the standard a guess ("small vial"), the
 * user's own bottle not told ("tall bottle"): "I found 4 things in 3 photos. I'm not sure about 2."
 */
export function createMockKitVision(): KitVision {
  const layout = sampleLayout(SAMPLE_ROLES);
  return {
    async recognizeKit() {
      const bca = bcaFacts();
      const kit = { vendor: bca.vendor, catalog: bca.catalogs[0], name: bca.name };
      return { found: true, kit, protocolId: localProtocolId({ kit }) ?? bca.id };
    },
    async segmentBottles(_photo, points, index = 0) {
      const boxes = layout[index % layout.length].map(b => b.box);
      return { bottles: (points?.length ? boxesAt(boxes, points) : boxes).map(box => ({ box })) };
    },
    // The drawn sample photos show bottles on a bench, no packaging.
    async findPackaging() {
      return { box: null };
    },
    // No video here: the phone reads the frames it kept, as photos.
    async trackBottles() {
      return { frames: 0, picks: [], seen: [] };
    },
    async readLabels(crops, components, views) {
      return {
        labels: Array.from({ length: views?.length || crops.length }, (_, i): ReadLabels['labels'][number] => {
          const t = components[i];
          const blank = { volume: '', looks: 'bottle', componentId: null, match: 'none' as const, confidence: 0 };
          if (!t) return { ...blank, text: '' };
          if (t.role === 'standard') return { ...blank, text: '', looks: 'small vial', componentId: t.id, match: 'guess', confidence: labelConfidence('guess', false, 0) };
          if (!t.kit || !t.labels.length) return { ...blank, text: '', looks: 'tall bottle' };
          return { ...blank, text: t.labels[0], componentId: t.id, match: 'read', confidence: labelConfidence('read', true, 1) };
        }),
      };
    },
  };
}
