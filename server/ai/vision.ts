import { z } from 'zod';
import type { Box, KitVision, LabelMatch, LabelTarget, Photo, Point, ReadLabels, RecognizedKit, SegmentedBottles } from '../../shared/ai.ts';
import { area, boxAt, overlap, sampleLayout } from '../../shared/kit.ts';
import { UpstreamError } from './provider.ts';
import { bcaFacts, knownProtocols, localProtocolId } from './protocols.ts';
import { samOutline, type SamMask } from './samMask.ts';
import { costOf, meter, PER, usageLine } from './usage.ts';

/**
 * Kit photos behind KitVision (shared/ai.ts): Muse Spark reads a kit's box (recognizeKit) and each bottle's label
 * (readLabels), SAM 3.1 finds the bottles (segmentBottles). The call shapes and replies were checked against the live
 * API on 2026-10-28; scripts/kit-vision.ts runs all three on any photo and keeps the raw replies in data/smoke/kit/.
 * Nothing here logs the key, a prompt or a photo: only timings.
 *
 * A label only counts as read when the words the model read name the component (namedBy): a match the model picked
 * without those words comes back as a guess, which the app asks the user to confirm.
 */

export const VISION_MODEL = 'muse-spark-1.3';
export const SAM_MODEL = 'sam-3.1';
/** What SAM is asked to find. It finds bottles, vials and ampules alike, and leaves the kit's box out. */
export const SAM_PROMPT = 'bottle';
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

/** For each point, the smallest box holding it, once each. */
export function boxesAt(boxes: Box[], points: Point[]): Box[] {
  const hits = points.map(p => boxAt(boxes, p)).filter((b): b is Box => b !== null);
  return hits.filter((b, i) => hits.indexOf(b) === i);
}

// ---------------------------------------------------------------------------------------------------------------
// The kit's box

const kitInstructions = `You identify lab kits from a photo of the kit's box. Report only what is printed on the box and you can actually read; never fill anything in from memory.
- found: true when a kit's box or its product name is readable.
- vendor: the brand as printed (for example "Thermo Scientific").
- name: the kit's name as printed (for example "Pierce BCA Protein Assay Kit").
- catalog: the kit's catalog or product number as printed on the box (not a bottle's), letters and digits only.
- read: the words you read on the box, briefly.
Unused fields "".`;

export const kitFormat = {
  type: 'json_schema',
  json_schema: {
    name: 'Kit',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['found', 'vendor', 'name', 'catalog', 'read'],
      properties: { found: { type: 'boolean' }, vendor: { type: 'string' }, name: { type: 'string' }, catalog: { type: 'string' }, read: { type: 'string' } },
    },
  },
};

const KitWire = z.object({ found: z.boolean(), vendor: z.string().default(''), name: z.string().default(''), catalog: z.string().default('') });

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
  return { found: true, kit, protocolId, ...(protocolId ? {} : { query: [vendor, name, catalog].filter(Boolean).join(' ') }) };
}

// ---------------------------------------------------------------------------------------------------------------
// Labels

export function labelsInstructions(targets: LabelTarget[]): string {
  const list = targets.map(t => {
    const says = t.labels.filter(Boolean);
    const label = says.length ? `label says ${says.map(l => `"${l}"`).join(' or ')}` : t.kit ? 'no label words known' : "the user's own bottle, no kit label";
    return `- ${t.id}: ${t.name} (${t.role}; ${label})`;
  });
  return `You read the labels of bottles in photos of a lab kit. Each picture is one object cut out of a photo of the bench.
For every picture, in order:
- crop: its number.
- name: the product name printed on its label, word for word, only as far as you can actually read it (for example "Pierce BCA Protein Assay Reagent A"). "" when you cannot read the label. Never fill in words you cannot see.
- looks: what it is, in two or three plain lowercase words ("tall bottle", "small blue bottle", "glass ampule").
- component: the id of the component below that the label you read names. "" when the label names none of them, or you could not read it.
- guess: when you could not read the label, the component it most likely is from its shape, size, colour and the other pictures. "" when you cannot tell, or you read the label.
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
              required: ['crop', 'name', 'looks', 'component', 'guess'],
              properties: {
                crop: { type: 'integer' },
                name: { type: 'string' },
                looks: { type: 'string' },
                component: { type: 'string', enum: ids },
                guess: { type: 'string', enum: ids },
              },
            },
          },
        },
      },
    },
  };
}

const LabelsWire = z.object({
  items: z.array(z.object({ crop: z.number().optional(), name: z.string().default(''), looks: z.string().default(''), component: z.string().default(''), guess: z.string().default('') })),
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

/** "glass ampule": two or three plain words, never empty. */
const looksOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9µ\- ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || 'bottle';

/** Muse Spark's reading of `count` crops → ReadLabels, each match checked against the words read. */
export function parseLabels(content: unknown, targets: LabelTarget[], count: number): ReadLabels {
  let wire: z.infer<typeof LabelsWire>;
  try {
    wire = LabelsWire.parse(JSON.parse(String(content)));
  } catch {
    throw new UpstreamError('Muse Spark answered about the labels in a shape Chapp does not know');
  }
  const byCrop = (i: number) => wire.items.find(it => it.crop === i + 1) ?? (wire.items.every(it => it.crop === undefined) ? wire.items[i] : undefined);
  const labels = Array.from({ length: count }, (_, i): ReadLabels['labels'][number] => {
    const item = byCrop(i);
    if (!item) return { text: '', looks: 'bottle', componentId: null, match: 'none' };
    const text = item.name.replace(/\s+/g, ' ').trim();
    const claimed = targets.find(t => t.id === item.component);
    const guessed = targets.find(t => t.id === item.guess);
    const named = text ? namedBy(text, targets) : [];
    // A label cut off by the photo: read when what shows fits one bottle of this run alone and the model picked it.
    const partly = !named.length && text ? partlyNamedBy(text, targets) : [];
    const picked = claimed ?? guessed;
    let componentId: string | null = null;
    let match: LabelMatch = 'none';
    // What the label says wins over what the model picked; a pick the words don't back is a guess.
    if (named.length === 1) [componentId, match] = [named[0].id, 'read'];
    else if (claimed && named.includes(claimed)) [componentId, match] = [claimed.id, 'read'];
    else if (picked && partly.length === 1 && partly[0] === picked) [componentId, match] = [picked.id, 'read'];
    else if (picked) [componentId, match] = [picked.id, 'guess'];
    else if (text) match = 'other';
    return { text, looks: looksOf(item.looks), componentId, match };
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
  timeouts?: { recognize?: number; segment?: number; labels?: number };
};

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

/** Meta's models behind KitVision. Spark thinks at low effort here: the same answers on the test photos, in half the time. */
export function createKitVision(options: VisionOptions): KitVision {
  const { apiKey, baseUrl = 'https://api.meta.ai/v1', log = (line: string) => console.log(line) } = options;
  if (!apiKey) throw new Error('Kit photos need MODEL_API_KEY in .env (see .env.example).');
  const fetchFn = options.fetch ?? globalThis.fetch;
  const timeouts = { recognize: 30_000, segment: 20_000, labels: 45_000, ...options.timeouts };

  async function call(what: string, path: string, body: Json, timeoutMs: number): Promise<Json> {
    meter.check();
    const started = Date.now();
    const seconds = () => ((Date.now() - started) / 1000).toFixed(1);
    let text: string;
    try {
      const res = await fetchFn(baseUrl + path, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await res.text();
      if (!res.ok) {
        log(`[meta] ${what} failed after ${seconds()} s: ${res.status}`);
        throw new UpstreamError(`Meta ${what} failed (${res.status}): ${upstreamMessage(text, apiKey)}`);
      }
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      log(`[meta] ${what} ${timedOut ? 'timed out' : 'could not connect'} after ${seconds()} s`);
      throw new UpstreamError(timedOut ? `Meta ${what} timed out after ${Math.round(timeoutMs / 1000)} s` : `Could not reach the Meta API for ${what}`);
    }
    let reply: Json;
    try {
      reply = JSON.parse(text);
    } catch {
      log(`[meta] ${what} ${seconds()} s`);
      throw new UpstreamError(`Meta ${what} answered with something that is not JSON`);
    }
    // SAM is paid by the image; Muse Spark by its tokens.
    const cost = body.model === SAM_MODEL ? PER.samImage : costOf(String(body.model), reply);
    meter.spend(cost);
    const used = body.model === SAM_MODEL ? `$${cost.toFixed(4)}` : usageLine(String(body.model), reply);
    log(`[meta] ${what} ${seconds()} s${used ? ` · ${used}` : ''}`);
    return reply;
  }

  const spark = async (what: string, system: string, content: Json[], format: Json, timeoutMs: number) => {
    const body = await call(what, '/chat/completions', {
      model: VISION_MODEL,
      reasoning_effort: 'low',
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

    async segmentBottles(photo, points) {
      // A tap is a point prompt: SAM outlines the thing under the finger, whatever it is (a tube, an ampule, a bottle
      // the word "bottle" missed). Without taps, or when the photo's size cannot be read, the noun finds every bottle.
      const size = points?.length ? imageSize(photo.data) : null;
      const prompt = size && points?.length ? samPointPrompt(points.slice(0, MAX_BOTTLES), size) : SAM_PROMPT;
      const body = await call(size ? 'segment-at' : 'segment', '/responses', {
        model: SAM_MODEL,
        input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }, { type: 'input_image', image_url: dataUrl(photo) }] }],
        metadata: { include_confidence: 'true' },
      }, timeouts.segment);
      if (body.status === 'failed' || body.error) throw new UpstreamError(`Meta segment failed: ${upstreamMessage(JSON.stringify(body.error ?? {}), apiKey) || 'no reason given'}`);
      const text = (Array.isArray(body.output) ? body.output : [])
        .flatMap((o: Json) => (Array.isArray(o.content) ? o.content : []))
        .filter((c: Json) => c.type === 'output_text' && typeof c.text === 'string')
        .map((c: Json) => c.text as string)
        .join('');
      const found = parseSamRecords(text);
      // Prompted objects come back under the ids the prompt gave them (1, 2, … in tap order); a tap on nothing, not at all.
      const chosen = size
        ? found.filter(r => r.id !== undefined).sort((a, b) => a.id! - b.id!).filter((r, i, all) => all.findIndex(o => o.id === r.id) === i)
        : points?.length
          ? boxesAt(tidyBottles(found).map(r => r.box), points).map(box => found.find(r => r.box === box)!)
          : tidyBottles(found);
      // Each mask as an outline the phone draws and cuts along (samMask.ts); none when it cannot be decoded.
      const bottles = await Promise.all(chosen.map(async r => {
        const outline = r.mask ? await samOutline(r.mask) : undefined;
        return { box: r.box, ...(r.score !== undefined ? { score: r.score } : {}), ...(outline ? { outline } : {}) };
      }));
      return { bottles };
    },

    async readLabels(crops, components) {
      if (!crops.length) return { labels: [] };
      const content: Json[] = [{ type: 'text', text: `${crops.length} picture${crops.length === 1 ? '' : 's'}:` }];
      crops.forEach((crop, i) => content.push({ type: 'text', text: `Picture ${i + 1}:` }, { type: 'image_url', image_url: { url: dataUrl(crop) } }));
      const answer = await spark('read-labels', labelsInstructions(components), content, labelsFormat(components), timeouts.labels);
      return parseLabels(answer, components, crops.length);
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
    async readLabels(crops, components) {
      return {
        labels: crops.map((_, i): ReadLabels['labels'][number] => {
          const t = components[i];
          if (!t) return { text: '', looks: 'bottle', componentId: null, match: 'none' };
          if (t.role === 'standard') return { text: '', looks: 'small vial', componentId: t.id, match: 'guess' };
          if (!t.kit || !t.labels.length) return { text: '', looks: 'tall bottle', componentId: null, match: 'none' };
          return { text: t.labels[0], looks: 'bottle', componentId: t.id, match: 'read' };
        }),
      };
    },
  };
}
