import type { IncomingMessage, ServerResponse } from 'node:http';
import { inflateRawSync } from 'node:zlib';
import { z } from 'zod';
import type { AIProvider, Photo, PlateInput, PlateReading, ReadPlateRequest } from '../../shared/ai.ts';
import { decodeText, parsePlateText, readingOf, wellId } from '../../shared/plate.ts';
import { UpstreamError } from './provider.ts';
import { costOf, meter, usageLine } from './usage.ts';

/**
 * Plate-reader values into the app (POST /api/read-plate):
 *
 *   an export file   parsed here without a model (shared/plate.ts: Gen5, SoftMax Pro, Tecan, BMG, "Well,Value"…);
 *                    .xlsx is unzipped to text first. Only a file with no plate the parser can find goes to the model.
 *   a photo          of the reader's screen or a printout: Muse Spark transcribes the grid (meta), or the mock says
 *                    "use the sample readings" (sampleData), which the app labels Sample data.
 *
 * Model-read values come back with by: 'model'; the app has the user confirm them before Results treats them as
 * theirs. Nothing here logs the key, the picture or the numbers: only timings.
 */

export const MAX_PLATE_BODY = 12 * 1024 * 1024;
/** The most text of an odd file sent to the model. */
const MAX_MODEL_TEXT = 60_000;
const MODEL = 'muse-spark-1.3';

type Json = Record<string, any>;

export const ReadPlateRequestSchema = z
  .object({
    photo: z.string().regex(/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/, 'a JPEG, PNG or WebP data URL').optional(),
    file: z.object({ name: z.string().max(300), text: z.string().max(4_000_000).optional(), base64: z.string().max(MAX_PLATE_BODY).optional() }).optional(),
    rows: z.int().min(1).max(16).optional(),
    cols: z.int().min(1).max(24).optional(),
    wavelength: z.number().min(200).max(1100).optional(),
  })
  .refine(b => Boolean(b.photo) !== Boolean(b.file), 'send a photo or a file')
  .refine(b => !b.file || b.file.text !== undefined || b.file.base64 !== undefined, 'the file has no content') satisfies z.ZodType<ReadPlateRequest>;

// ─── .xlsx ───────────────────────────────────────────────────────────────────────────────────────────────────────

export const isZip = (b: Uint8Array) => b.length > 22 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 3 && b[3] === 4;

/** The entries of a zip file this reader needs, by name (stored or deflated; nothing else is used by .xlsx). */
function unzip(buf: Buffer, want: (name: string) => boolean): Map<string, Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let n = 0; n < count && p + 46 <= buf.length && buf.readUInt32LE(p) === 0x02014b50; n++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLength = buf.readUInt16LE(p + 28);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLength);
    const local = buf.readUInt32LE(p + 42);
    p += 46 + nameLength + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    if (!want(name) || local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    if (method === 0) out.set(name, data);
    else if (method === 8) out.set(name, inflateRawSync(data, { maxOutputLength: 32 * 1024 * 1024 }));
  }
  return out;
}

const unescapeXml = (s: string) =>
  s.replace(/&(?:lt|gt|amp|quot|apos|#(\d+)|#x([0-9a-fA-F]+));/g, (m, dec?: string, hex?: string) =>
    dec ? String.fromCodePoint(Number(dec)) : hex ? String.fromCodePoint(parseInt(hex, 16)) : ({ '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&apos;': "'" })[m]!,
  );
const textRuns = (xml: string) => [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(m => unescapeXml(m[1]!)).join('');
const columnIndex = (ref: string) => [...(/^[A-Z]+/.exec(ref)?.[0] ?? 'A')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

/**
 * The first worksheet of an .xlsx as tab-separated text, a line per row (empty rows kept, so the blank line between
 * two reads stays), ready for parsePlateText. Throws when the file is not a workbook.
 */
export function xlsxText(buf: Buffer): string {
  const parts = unzip(buf, n => n === 'xl/workbook.xml' || n === 'xl/_rels/workbook.xml.rels' || n === 'xl/sharedStrings.xml' || /^xl\/worksheets\/[^/]+\.xml$/.test(n));
  const workbook = parts.get('xl/workbook.xml')?.toString('utf8') ?? '';
  const rels = parts.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '';
  const firstId = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(workbook)?.[1];
  const target = firstId ? new RegExp(`<Relationship\\b[^>]*Id="${firstId}"[^>]*Target="([^"]+)"`).exec(rels)?.[1] ?? new RegExp(`<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${firstId}"`).exec(rels)?.[1] : undefined;
  const path = target ? (target.startsWith('/') ? target.slice(1) : `xl/${target}`) : undefined;
  const sheets = [...parts.keys()].filter(n => n.startsWith('xl/worksheets/')).sort();
  const sheet = parts.get(path && parts.has(path) ? path : (sheets[0] ?? ''))?.toString('utf8');
  if (!sheet) throw new Error('no worksheet');
  const shared = [...(parts.get('xl/sharedStrings.xml')?.toString('utf8') ?? '').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(m => textRuns(m[1]!));

  const lines: string[] = [];
  for (const row of sheet.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const r = Number(/\br="(\d+)"/.exec(row[1]!)?.[1] ?? lines.length + 1);
    while (lines.length < r - 1) lines.push('');
    const cells: string[] = [];
    for (const c of (row[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1]!;
      const body = c[2] ?? '';
      const ref = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1];
      const at = ref ? columnIndex(ref) : cells.length;
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let text = '';
      if (type === 's' && v !== undefined) text = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') text = textRuns(/<is>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? '');
      else if (type === 'b') text = v === '1' ? 'TRUE' : 'FALSE';
      else if (v !== undefined) text = unescapeXml(v);
      while (cells.length < at) cells.push('');
      cells[at] = text.replace(/[\t\r\n]+/g, ' ');
    }
    lines[r - 1] = cells.join('\t');
  }
  return lines.join('\n');
}

// ─── What a model read ───────────────────────────────────────────────────────────────────────────────────────────

/** The wire format Muse Spark fills: the plate row by row, the values as written, and the wells it could not read. */
export const plateFormat = {
  type: 'json_schema',
  json_schema: {
    name: 'PlateRead',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['found', 'wavelength', 'rows', 'unclear', 'note'],
      properties: {
        found: { type: 'boolean' },
        wavelength: { type: 'string' },
        rows: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['row', 'values'],
            properties: { row: { type: 'string' }, values: { type: 'array', items: { type: 'string' } } },
          },
        },
        unclear: { type: 'array', items: { type: 'string' } },
        note: { type: 'string' },
      },
    },
  },
};

const Wire = z.object({
  found: z.boolean(),
  wavelength: z.string().default(''),
  rows: z.array(z.object({ row: z.string(), values: z.array(z.union([z.string(), z.number()]).transform(String)) })).default([]),
  unclear: z.array(z.string()).default([]),
  note: z.string().default(''),
});

export function platePrompt(input: PlateInput): string {
  const rows = 'ABCDEFGHIJKLMNOP'.slice(0, input.rows);
  const what = 'photo' in input ? 'a photo of a microplate reader’s result: its screen, or a printout of it' : `a plate reader’s export file named “${input.file.name}”`;
  return `This is ${what}. Transcribe the plate's readings, rows ${rows[0]}–${rows.at(-1)} and columns 1–${input.cols}.
- Give every row ${rows[0]}–${rows.at(-1)}, each with exactly ${input.cols} values in column order 1–${input.cols}.
- Copy each number exactly as shown, every digit and the decimal point; never round, guess or compute.
- "" for a well that is empty, blank or not visible. Text shown instead of a number (OVRFLW, OVER, *, ?) copied as text.
- If several tables are shown, use the raw absorbance${input.wavelength ? ` at ${input.wavelength} nm` : ''}, not a layout, concentrations, or blank-corrected values. Put that wavelength in "wavelength" ("" if not shown).
- unclear: the well ids (like "B7") whose digits you cannot read with certainty.
- found: false, with rows [], if no plate table is visible.
- note: one short sentence for the user, only when something is wrong (cut off, glare, a different plate size); else "".`;
}

/** The model's raw content → PlateReading (by: 'model'), keeping only wells on a plate of this size. */
export function plateFromModel(content: unknown, input: Pick<PlateInput, 'rows' | 'cols'>): PlateReading {
  if (typeof content !== 'string') throw new UpstreamError('Meta read-plate returned no content');
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new UpstreamError('Meta read-plate answered with something that is not JSON');
  }
  const wire = Wire.safeParse(parsed);
  if (!wire.success) throw new UpstreamError('Meta read-plate answered in the wrong format');
  const readings: Record<string, number> = {};
  const odd: Record<string, string> = {};
  if (wire.data.found) {
    for (const row of wire.data.rows) {
      const letter = row.row.trim().toUpperCase().slice(0, 1);
      row.values.slice(0, input.cols).forEach((raw, c) => {
        const well = wellId(`${letter}${c + 1}`, input.rows, input.cols);
        const s = raw.trim();
        if (!well || !s) return;
        const n = readingOf(s, true);
        if (n !== null) readings[well] = n;
        else if (!/^(?:-|—|n\/?a)$/i.test(s)) odd[well] = s.slice(0, 12);
      });
    }
  }
  const unsure = [...new Set(wire.data.unclear.map(w => wellId(w, input.rows, input.cols)).filter((w): w is string => w !== null))];
  const note = wire.data.note.trim() || (!wire.data.found || !Object.keys(readings).length ? 'No plate table found.' : '');
  return { readings, odd, unsure, sampleData: false, by: 'model', ...(note ? { note: note.slice(0, 200) } : {}) };
}

export type MetaPlateOptions = { apiKey: string; baseUrl?: string; fetch?: typeof fetch; log?: (line: string) => void; timeoutMs?: number };

const dataUrl = (photo: Photo) => `data:${photo.type};base64,${Buffer.from(photo.data).toString('base64')}`;

/** Muse Spark reads the plate: a vision call for a photo, a text call for an odd file, both in plateFormat's schema. */
export function metaReadPlate(options: MetaPlateOptions): (input: PlateInput) => Promise<PlateReading> {
  const { apiKey, baseUrl = 'https://api.meta.ai/v1', log = (line: string) => console.log(line), timeoutMs = 90_000 } = options;
  const fetchFn = options.fetch ?? globalThis.fetch;
  return async input => {
    const prompt = platePrompt(input);
    const content: Json[] | string =
      'photo' in input
        ? [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: dataUrl(input.photo) } }]
        : `${prompt}\n\n--- ${input.file.name} ---\n${input.file.text.slice(0, MAX_MODEL_TEXT)}`;
    meter.check();
    const started = Date.now();
    const seconds = () => ((Date.now() - started) / 1000).toFixed(1);
    let text: string;
    try {
      const res = await fetchFn(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content }], response_format: plateFormat, prompt_cache_key: 'chapp-read-plate' }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await res.text();
      if (!res.ok) {
        log(`[meta] read-plate failed after ${seconds()} s: ${res.status}`);
        let message = text;
        try {
          const body = JSON.parse(text);
          message = body?.error?.message ?? body?.message ?? text;
        } catch {
          // Not JSON: keep the text.
        }
        throw new UpstreamError(`Meta read-plate failed (${res.status}): ${String(message).split(apiKey).join('***').replace(/\s+/g, ' ').trim().slice(0, 200)}`);
      }
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      log(`[meta] read-plate ${timedOut ? 'timed out' : 'could not connect'} after ${seconds()} s`);
      throw new UpstreamError(timedOut ? `Meta read-plate timed out after ${Math.round(timeoutMs / 1000)} s` : 'Could not reach the Meta API to read the plate');
    }
    let body: Json;
    try {
      body = JSON.parse(text);
    } catch {
      throw new UpstreamError('Meta read-plate answered with something that is not JSON');
    }
    meter.spend(costOf(MODEL, body));
    const used = usageLine(MODEL, body);
    log(`[meta] read-plate (${'photo' in input ? 'photo' : 'file'}) ${seconds()} s${used ? ` · ${used}` : ''}`);
    return plateFromModel(body.choices?.[0]?.message?.content, input);
  };
}

/**
 * The mock reads no pictures: a photo gets "use the sample readings" (the app fills them in for its own plate and
 * labels them Sample data), and a file the parser could not read gets nothing found.
 */
export async function mockReadPlate(input: PlateInput): Promise<PlateReading> {
  if ('photo' in input) return { readings: {}, sampleData: true, by: 'sample', note: 'The mock AI reads no photos.' };
  return { readings: {}, sampleData: false, by: 'model', note: 'No plate table found.' };
}

// ─── The route ───────────────────────────────────────────────────────────────────────────────────────────────────

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
};

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

function photoOf(url: string): Photo {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.*)$/.exec(url)!;
  return { type: m[1] as Photo['type'], data: new Uint8Array(Buffer.from(m[2]!, 'base64')) };
}

/** An export's text: an .xlsx unzipped, other bytes decoded (UTF-16 included), or the text as sent. */
function fileText(file: NonNullable<ReadPlateRequest['file']>): string {
  if (file.base64 === undefined) return file.text ?? '';
  const bytes = Buffer.from(file.base64, 'base64');
  if (isZip(bytes)) return xlsxText(bytes);
  return decodeText(new Uint8Array(bytes));
}

/** POST /api/read-plate, answered with `provider` (its readPlate for photos and odd files). */
export function createPlateHandler(provider: AIProvider) {
  return async function plate(req: IncomingMessage, res: ServerResponse) {
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      return json(res, 405, { error: 'Use POST' });
    }
    const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (type !== 'application/json') return json(res, 415, { error: 'Send JSON (content-type: application/json)' });
    const raw = await readBody(req, MAX_PLATE_BODY);
    if (!raw) return json(res, 413, { error: `Too large (limit ${MAX_PLATE_BODY / 1024 / 1024} MB)` });
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      return json(res, 400, { error: 'The body is not valid JSON' });
    }
    const parsed = ReadPlateRequestSchema.safeParse(body);
    if (!parsed.success) return json(res, 400, { error: `Invalid request: ${parsed.error.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ')}` });
    const request = parsed.data;
    const hints = { rows: request.rows ?? 8, cols: request.cols ?? 12, ...(request.wavelength ? { wavelength: request.wavelength } : {}) };

    try {
      if (request.file) {
        let text: string;
        try {
          text = fileText(request.file);
        } catch {
          return json(res, 400, { error: `${request.file.name} could not be opened. Save it from the reader as CSV or XLSX.` });
        }
        const read = parsePlateText(text, hints);
        if (read) {
          const reading: PlateReading = { readings: read.values, odd: read.odd, sampleData: false, by: 'file', ...(read.reads > 1 && read.label ? { note: read.label } : {}) };
          return json(res, 200, reading);
        }
        if (!provider.readPlate || !text.trim()) return json(res, 200, { readings: {}, sampleData: false, by: 'file', note: 'No plate table found.' } satisfies PlateReading);
        return json(res, 200, await provider.readPlate({ file: { name: request.file.name, text }, ...hints }));
      }
      if (!provider.readPlate) return json(res, 501, { error: 'This server cannot read photos.' });
      return json(res, 200, await provider.readPlate({ photo: photoOf(request.photo!), ...hints }));
    } catch (error) {
      if (error instanceof UpstreamError) {
        console.error(`[api] /api/read-plate: ${error.message}`);
        return json(res, 502, { error: error.message });
      }
      throw error;
    }
  };
}
