/**
 * One real call to each Meta model Chapp depends on, so problems show up on day one.
 *
 *   npm run smoke                          # everything except SAM
 *   npm run smoke -- --image kit.jpg       # also segment a kit photo with SAM 3.1
 *
 * Reads MODEL_API_KEY from .env. Writes what it gets back to data/smoke/ (git-ignored).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { extname } from 'node:path';
import { tmpdir } from 'node:os';

const base = 'https://api.meta.ai/v1';
const key = process.env.MODEL_API_KEY;
if (!key) {
  console.error('MODEL_API_KEY is not set. Put it in .env (see .env.example), then run npm run smoke again.');
  process.exit(1);
}
const out = new URL('../data/smoke/', import.meta.url);
mkdirSync(out, { recursive: true });
const manual = new URL('../data/sources/pierce-bca/MAN0011430_Pierce_BCA_Protein_Asy_UG.pdf', import.meta.url);
const imageArg = process.argv.indexOf('--image');
const image = imageArg > 0 ? process.argv[imageArg + 1] : undefined;

type Json = Record<string, any>;
const auth = { authorization: `Bearer ${key}` };

async function post(path: string, body: Json): Promise<Json> {
  const res = await fetch(base + path, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

// Responses API: the text is in output_text, or in the message item's output_text parts.
const parts = (r: Json): Json[] => (r.output ?? []).flatMap((o: Json) => o.content ?? []).filter((c: Json) => c.type === 'output_text');
const textOf = (r: Json): string => r.output_text ?? parts(r).map(c => c.text).join('');
const dataUrl = (file: string | URL, type: string) => `data:${type};base64,${readFileSync(file).toString('base64')}`;
const short = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n)}…` : s).replace(/\s+/g, ' ');

const checks: [string, () => Promise<string>][] = [
  ['Muse Spark: answers', async () => {
    const r = await post('/responses', { model: 'muse-spark-1.3', input: 'Reply with exactly: ready' });
    const text = textOf(r);
    if (!text) throw new Error('empty reply');
    return short(text);
  }],

  ['Muse Spark: JSON that matches a schema', async () => {
    const r = await post('/chat/completions', {
      model: 'muse-spark-1.3',
      messages: [{ role: 'user', content: 'BCA working reagent is 50 parts reagent A to 1 part reagent B. Give the parts.' }],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'Ratio', strict: true,
          schema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'], additionalProperties: false },
        },
      },
    });
    const parsed = JSON.parse(r.choices[0].message.content);
    if (parsed.a !== 50 || parsed.b !== 1) throw new Error(`unexpected ${JSON.stringify(parsed)}`);
    return JSON.stringify(parsed);
  }],

  ['Muse Spark: reads the BCA manual PDF', async () => {
    if (!existsSync(manual)) throw new Error('data/sources/pierce-bca/ has no manual');
    const r = await post('/responses', {
      model: 'muse-spark-1.3',
      input: [{
        role: 'user',
        content: [
          { type: 'input_file', filename: 'bca-manual.pdf', file_data: dataUrl(manual, 'application/pdf') },
          { type: 'input_text', text: 'In the microplate procedure, how much working reagent goes into each well? Reply with just the volume.' },
        ],
      }],
    });
    const text = textOf(r);
    if (!/200\s*µ?u?L/i.test(text)) throw new Error(`expected 200 µL, got: ${short(text)}`);
    return short(text);
  }],

  ['Muse Spark: web search with citations', async () => {
    const r = await post('/responses', {
      model: 'muse-spark-1.3',
      tools: [{ type: 'web_search' }],
      input: 'Find the official Thermo Fisher user guide PDF for the Pierce BCA Protein Assay Kit (catalog 23225). Reply with its URL.',
    });
    const cited = parts(r).flatMap(c => c.annotations ?? []).filter((a: Json) => a.type === 'url_citation');
    if (!cited.length) throw new Error(`no url_citation in: ${short(textOf(r))}`);
    return `${cited.length} citation(s), first: ${cited[0].url}`;
  }],

  ['SAM 3.1: segments the kit photo', async () => {
    if (!image) return 'skipped (run with --image <photo of the kit>)';
    const type = extname(image).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
    const r = await post('/responses', {
      model: 'sam-3.1',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'bottle' }, { type: 'input_image', image_url: dataUrl(image, type) }] }],
    });
    const text = textOf(r);
    writeFileSync(new URL('sam-bottle.txt', out), text);
    const boxes = text.match(/<\|box;[^|]*\|>/g) ?? [];
    if (!boxes.length) throw new Error('no objects found for "bottle"');
    return `${boxes.length} bottle(s); first ${boxes[0]} (full output in data/smoke/sam-bottle.txt)`;
  }],

  ['Muse Voice Transcribe: file transcription', async () => {
    // macOS's own voice makes the test clip: mono 16-bit PCM at 16 kHz, the format the endpoint takes.
    const wav = `${tmpdir()}/chapp-smoke.wav`;
    execFileSync('say', ['-o', wav, '--file-format=WAVE', '--data-format=LEI16@16000', 'Next step. Make it triplicates.']);
    const form = new FormData();
    form.append('request', new Blob([JSON.stringify({ mode: 'DIARIZATION', model: 'muse-voice-transcribe-1.0', audioEncoding: 'WAV' })], { type: 'application/json' }));
    form.append('audio', new Blob([readFileSync(wav)], { type: 'audio/wav' }), 'chapp-smoke.wav');
    const res = await fetch(`${base}/asr/transcribe`, { method: 'POST', headers: auth, body: form });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 300)}`);
    const transcript = JSON.parse(text).transcript ?? '';
    if (!/triplicate/i.test(transcript)) throw new Error(`unexpected transcript: ${transcript}`);
    return transcript;
  }],

  ['Muse Image: draws an equipment icon ($0.01)', async () => {
    const r = await post('/images/generations', {
      model: 'muse-image-1.0',
      prompt: 'A single clean 3D icon of a clear 96-well microplate, soft studio light, plain light gray background, no text',
      n: 1,
      output_format: 'png',
    });
    const b64 = r.data?.[0]?.b64_json;
    if (!b64) throw new Error('no image in the reply');
    writeFileSync(new URL('icon-96-well-plate.png', out), Buffer.from(b64, 'base64'));
    return 'saved data/smoke/icon-96-well-plate.png';
  }],
];

let failed = 0;
for (const [name, run] of checks) {
  const started = Date.now();
  try {
    const detail = await run();
    console.log(`✓ ${name} (${((Date.now() - started) / 1000).toFixed(1)} s): ${detail}`);
  } catch (error) {
    failed++;
    console.log(`✗ ${name} (${((Date.now() - started) / 1000).toFixed(1)} s): ${error instanceof Error ? error.message : error}`);
  }
}
process.exit(failed ? 1 : 0);
