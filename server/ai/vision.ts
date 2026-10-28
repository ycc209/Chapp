import { z } from 'zod';
import type { Box, KitVision, LabelMatch, LabelTarget, Photo, Point, ReadLabels, RecognizedKit, SegmentedBottles } from '../../shared/ai.ts';
import { area, boxAt, overlap, sampleLayout } from '../../shared/kit.ts';
import { UpstreamError } from './provider.ts';
import { bcaFacts, knownProtocols, localProtocolId } from './protocols.ts';

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
 * SAM 3.1's reply text → boxes as fractions of the photo. It answers /responses with one output_text like
 *   <0f>0<|box;x1=215;y1=318;x2=233;y2=391;w=500;h=461|><|mask;x=0;y=0;data=…|>,1<|box;…|><|mask;…|>
 * one box per object in pixels of the photo it was sent (w × h), each with its mask (run-length coded, unused here).
 * No scores.
 */
export function parseSam(text: string): Box[] {
  const boxes: Box[] = [];
  for (const m of text.matchAll(/<\|box;([^|>]*)\|>/g)) {
    const f: Record<string, number> = {};
    for (const pair of m[1].split(';')) {
      const [k, v] = pair.split('=');
      if (k && v !== undefined) f[k.trim()] = Number(v);
    }
    const { x1, y1, x2, y2, w, h } = f;
    if (![x1, y1, x2, y2, w, h].every(Number.isFinite) || w <= 0 || h <= 0) continue;
    const left = Math.max(0, Math.min(x1, x2)) / w;
    const top = Math.max(0, Math.min(y1, y2)) / h;
    const right = Math.min(w, Math.max(x1, x2)) / w;
    const bottom = Math.min(h, Math.max(y1, y2)) / h;
    if (right > left && bottom > top) boxes.push({ x: left, y: top, width: right - left, height: bottom - top });
  }
  return boxes;
}

/**
 * What the app shows of SAM's boxes: no specks, no box mostly inside a bigger one (the same bottle twice, or its cap),
 * the MAX_BOTTLES biggest, left to right.
 */
export function tidyBoxes(boxes: Box[], max = MAX_BOTTLES): Box[] {
  const kept: Box[] = [];
  for (const b of boxes.filter(b => area(b) >= MIN_AREA).sort((a, b) => area(b) - area(a))) {
    if (!kept.some(k => overlap(k, b) >= 0.85 * area(b))) kept.push(b);
  }
  return kept.slice(0, max).sort((a, b) => a.x - b.x || a.y - b.y);
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
    let componentId: string | null = null;
    let match: LabelMatch = 'none';
    // What the label says wins over what the model picked; a pick the words don't back is a guess.
    if (named.length === 1) [componentId, match] = [named[0].id, 'read'];
    else if (claimed && named.includes(claimed)) [componentId, match] = [claimed.id, 'read'];
    else if (claimed ?? guessed) [componentId, match] = [(claimed ?? guessed)!.id, 'guess'];
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
    log(`[meta] ${what} ${seconds()} s`);
    try {
      return JSON.parse(text);
    } catch {
      throw new UpstreamError(`Meta ${what} answered with something that is not JSON`);
    }
  }

  const spark = async (what: string, system: string, content: Json[], format: Json, timeoutMs: number) => {
    const body = await call(what, '/chat/completions', {
      model: VISION_MODEL,
      reasoning_effort: 'low',
      messages: [{ role: 'system', content: system }, { role: 'user', content }],
      response_format: format,
    }, timeoutMs);
    return body.choices?.[0]?.message?.content;
  };

  return {
    async recognizeKit(photo) {
      const content = [{ type: 'text', text: 'Which kit is this?' }, { type: 'image_url', image_url: { url: dataUrl(photo) } }];
      return parseRecognized(await spark('recognize-kit', kitInstructions, content, kitFormat, timeouts.recognize));
    },

    async segmentBottles(photo, points) {
      const body = await call('segment', '/responses', {
        model: SAM_MODEL,
        input: [{ role: 'user', content: [{ type: 'input_text', text: SAM_PROMPT }, { type: 'input_image', image_url: dataUrl(photo) }] }],
      }, timeouts.segment);
      if (body.status === 'failed' || body.error) throw new UpstreamError(`Meta segment failed: ${upstreamMessage(JSON.stringify(body.error ?? {}), apiKey) || 'no reason given'}`);
      const text = (Array.isArray(body.output) ? body.output : [])
        .flatMap((o: Json) => (Array.isArray(o.content) ? o.content : []))
        .filter((c: Json) => c.type === 'output_text' && typeof c.text === 'string')
        .map((c: Json) => c.text as string)
        .join('');
      const boxes = tidyBoxes(parseSam(text));
      return { bottles: (points?.length ? boxesAt(boxes, points) : boxes).map(box => ({ box })) };
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
