/**
 * The kit-photo models on any photo, the way the app uses them: Muse Spark reads the kit's box, SAM 3.1 finds the
 * bottles, Muse Spark reads each bottle's crop. Prints timings and what came back, scores it against truth.json when
 * the photo is listed there, and draws everything into data/smoke/kit/report.html.
 *
 *   node --env-file-if-exists=.env scripts/kit-vision.ts                     # every photo in data/smoke/kit/
 *   node --env-file-if-exists=.env scripts/kit-vision.ts ~/Desktop/kit.heic  # any photo (JPEG, PNG, HEIC…)
 *     --only segment,labels    skip recognizing the box (each photo costs 3 calls, 2 without it)
 *     --protocol pierce-bca    the protocol whose bottles the labels are matched to
 *     --fresh                  ask again even if this photo was asked before (replies are kept by the photo's hash)
 *     --mock                   the mock provider: no network, no cost
 *
 * macOS only: sips makes the photo the app's size (ANALYZE_MAX) and cuts the crops. Replies are kept under
 * data/smoke/kit/raw/ (git-ignored); the key and the photos are never printed.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Box, KitVision, LabelTarget, Photo, ReadLabels, RecognizedKit } from '../shared/ai.ts';
import { ANALYZE_MAX, labelCrop } from '../shared/kit.ts';
import { loadProtocol } from '../server/ai/protocols.ts';
import { createKitVision, createMockKitVision } from '../server/ai/vision.ts';
import { labelTargets } from '../src/screens/kit/found.ts';

const root = fileURLToPath(new URL('../data/smoke/kit/', import.meta.url));
const rawDir = join(root, 'raw');
mkdirSync(join(rawDir, 'cache'), { recursive: true });

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const only = new Set((option('only') ?? 'recognize,segment,labels').split(','));
const protocolId = option('protocol') ?? 'pierce-bca';
const valued = new Set([option('only'), option('protocol')].filter(Boolean));
const inputs = args.filter(a => !a.startsWith('--') && !valued.has(a));
const images = (inputs.length ? inputs : [root]).flatMap(p =>
  statSync(p).isDirectory() ? readdirSync(p).filter(f => /\.(jpe?g|png|heic|webp)$/i.test(f)).sort().map(f => join(p, f)) : [resolve(p)]);

const protocol = loadProtocol(protocolId);
if (!protocol) throw new Error(`No protocol ${protocolId} in data/protocols/`);
const targets: LabelTarget[] = labelTargets(protocol);

type Truth = { kit?: string | null; components?: Record<string, number> };
const truthFile = join(root, 'truth.json');
const truth: Record<string, Truth> = existsSync(truthFile) ? JSON.parse(readFileSync(truthFile, 'utf8')) : {};

// Every reply is kept, by the photo's hash and the call, and asked again only with --fresh.
let calls = 0;
let current = '';
const recordingFetch: typeof fetch = async (url, init) => {
  const body = String(init?.body ?? '');
  const key = createHash('sha256').update(String(url)).update(body).digest('hex').slice(0, 20);
  const cached = join(rawDir, 'cache', `${key}.json`);
  if (!flag('fresh') && existsSync(cached)) return new Response(readFileSync(cached, 'utf8'), { status: 200 });
  calls++;
  const res = await fetch(url, init);
  const text = await res.text();
  if (res.ok) {
    writeFileSync(cached, text);
    writeFileSync(join(rawDir, `${current}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), text);
  }
  return new Response(text, { status: res.status });
};

const timings: string[] = [];
const vision: KitVision = flag('mock')
  ? createMockKitVision()
  : createKitVision({ apiKey: process.env.MODEL_API_KEY ?? '', fetch: recordingFetch, log: line => timings.push(line) });

const work = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'chapp-kit-'));
const size = (file: string) => {
  const out = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file], { encoding: 'utf8' });
  return { width: Number(/pixelWidth: (\d+)/.exec(out)?.[1]), height: Number(/pixelHeight: (\d+)/.exec(out)?.[1]) };
};

/** The photo as the app sends it: JPEG, at most ANALYZE_MAX on its long side. */
function prepare(file: string): { path: string; width: number; height: number } {
  const out = join(work, `${basename(file, extname(file))}.jpg`);
  const { width, height } = size(file);
  const resize = Math.max(width, height) > ANALYZE_MAX ? ['-Z', String(ANALYZE_MAX)] : [];
  execFileSync('sips', [...resize, '-s', 'format', 'jpeg', '-s', 'formatOptions', '85', file, '--out', out], { stdio: 'ignore' });
  return { path: out, ...size(out) };
}

function crop(photo: { path: string; width: number; height: number }, box: Box, i: number): Photo {
  const c = labelCrop(box, photo.width, photo.height);
  const out = join(work, `crop-${i}.jpg`);
  execFileSync('sips', ['-c', String(c.sh), String(c.sw), '--cropOffset', String(c.sy), String(c.sx), photo.path, '--out', out], { stdio: 'ignore' });
  execFileSync('sips', ['-z', String(c.height), String(c.width), out], { stdio: 'ignore' });
  return { type: 'image/jpeg', data: new Uint8Array(readFileSync(out)) };
}

const timed = async <T>(run: () => Promise<T>): Promise<[T, number]> => {
  const started = Date.now();
  const value = await run();
  return [value, (Date.now() - started) / 1000];
};

type Result = { file: string; width: number; height: number; kit?: RecognizedKit; boxes: Box[]; labels: ReadLabels['labels']; seconds: Record<string, number>; score: string[] };
const results: Result[] = [];

for (const file of images) {
  const name = basename(file);
  current = basename(file, extname(file));
  const photo = prepare(file);
  const sent: Photo = { type: 'image/jpeg', data: new Uint8Array(readFileSync(photo.path)) };
  const result: Result = { file, width: photo.width, height: photo.height, boxes: [], labels: [], seconds: {}, score: [] };
  console.log(`\n${name} (${photo.width}×${photo.height})`);
  try {
    if (only.has('recognize')) {
      const [kit, s] = await timed(() => vision.recognizeKit(sent));
      result.kit = kit;
      result.seconds.recognize = s;
      console.log(`  kit       ${s.toFixed(1)} s  ${kit.found ? `${kit.kit?.vendor} · ${kit.kit?.name} · ${kit.kit?.catalog || 'no catalog'} → ${kit.protocolId ?? `find "${kit.query}"`}` : 'no kit box read'}`);
    }
    if (only.has('segment') || only.has('labels')) {
      const [seg, s] = await timed(() => vision.segmentBottles(sent));
      result.boxes = seg.bottles.map(b => b.box);
      result.seconds.segment = s;
      console.log(`  bottles   ${s.toFixed(1)} s  ${result.boxes.length} found`);
    }
    if (only.has('labels') && result.boxes.length) {
      const crops = result.boxes.map((b, i) => crop(photo, b, i));
      const [read, s] = await timed(() => vision.readLabels(crops, targets));
      result.labels = read.labels;
      result.seconds.labels = s;
      console.log(`  labels    ${s.toFixed(1)} s  ${crops.length} crops`);
      read.labels.forEach((l, i) => console.log(`    ${String(i + 1).padStart(2)} ${l.match.padEnd(5)} ${(l.componentId ?? '-').padEnd(10)} ${l.looks}${l.text ? ` · "${l.text}"` : ''}`));
    }
  } catch (error) {
    console.log(`  failed: ${error instanceof Error ? error.message : error}`);
  }

  // Scored against truth.json: { "<file>": { "kit": "23225" | null, "components": { "<id>": how many are in the photo } } }.
  const t = truth[name];
  if (t) {
    if (result.kit) {
      const want = t.kit ?? null;
      const got = result.kit.found ? result.kit.kit?.catalog || null : null;
      result.score.push(`kit ${got === want ? 'right' : `wrong (${got ?? 'none'}, not ${want ?? 'none'})`}`);
    }
    if (result.labels.length && t.components) {
      const objects = Object.values(t.components).reduce((a, b) => a + b, 0);
      result.score.push(`bottles ${result.boxes.length}/${objects}`);
      for (const match of ['read', 'guess'] as const) {
        const by: Record<string, number> = {};
        for (const l of result.labels) if (l.match === match && l.componentId) by[l.componentId] = (by[l.componentId] ?? 0) + 1;
        const right = Object.entries(by).reduce((n, [id, k]) => n + Math.min(k, t.components![id] ?? 0), 0);
        const wrong = Object.values(by).reduce((a, b) => a + b, 0) - right;
        result.score.push(`${match} ${right} right${wrong ? `, ${wrong} WRONG` : ''}`);
      }
      result.score.push(`other ${result.labels.filter(l => l.match === 'other').length}, none ${result.labels.filter(l => l.match === 'none').length}`);
    }
    console.log(`  score     ${result.score.join(' · ')}`);
  }
  results.push(result);
}

console.log(`\n${calls} paid call${calls === 1 ? '' : 's'} (others from data/smoke/kit/raw/cache/)`);
for (const line of timings) console.log(`  ${line}`);

// The report: each photo with its boxes, coloured by how sure the label is, and what was read.
const tone: Record<string, string> = { read: '#568dfa', guess: '#ffe863', other: '#a7a7ad', none: '#ffffff' };
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const report = `<!doctype html><meta charset="utf-8"><title>Kit photos</title>
<style>body{font:14px -apple-system,system-ui,sans-serif;margin:24px;background:#f4f4f2;color:#111}section{margin:0 0 32px}
.photo{position:relative;display:inline-block}.photo img{display:block;max-width:560px;max-height:560px}
.box{position:absolute;box-sizing:border-box;border:2px solid;border-radius:4px}.box span{position:absolute;top:-2px;left:-2px;background:inherit;font:700 11px system-ui;padding:0 3px;color:#111}
ol{margin:8px 0 0;padding-left:22px}small{color:#555}</style>
<h1>Kit photos <small>${new Date().toISOString().slice(0, 16).replace('T', ' ')}</small></h1>
${results.map(r => `<section><h2>${esc(basename(r.file))} <small>${r.width}×${r.height} · ${Object.entries(r.seconds).map(([k, s]) => `${k} ${s.toFixed(1)} s`).join(' · ')}</small></h2>
${r.kit ? `<p>Kit: ${r.kit.found ? esc(`${r.kit.kit?.vendor} · ${r.kit.kit?.name} · ${r.kit.kit?.catalog} → ${r.kit.protocolId ?? `find "${r.kit.query}"`}`) : 'not read'}</p>` : ''}
${r.score.length ? `<p>${esc(r.score.join(' · '))}</p>` : ''}
<div class="photo"><img src="${esc(r.file)}">${r.boxes.map((b, i) => {
  const l = r.labels[i];
  const color = tone[l?.match ?? 'none'];
  return `<div class="box" style="left:${b.x * 100}%;top:${b.y * 100}%;width:${b.width * 100}%;height:${b.height * 100}%;border-color:${color};background:${color}"><span>${i + 1}</span></div>`;
}).join('')}</div>
<ol>${r.labels.map(l => `<li><b>${l.match}</b> ${esc(l.componentId ?? '–')} · ${esc(l.looks)}${l.text ? ` · “${esc(l.text)}”` : ''}</li>`).join('')}</ol></section>`).join('\n')}
<style>.box{background:transparent!important}.box span{background:#fff}</style>`;
writeFileSync(join(root, 'report.html'), report);
writeFileSync(join(root, `run-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify(results.map(r => ({ ...r, file: basename(r.file) })), null, 1));
console.log(`\nReport: data/smoke/kit/report.html`);
