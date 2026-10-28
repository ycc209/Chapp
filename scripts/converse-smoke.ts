/**
 * Runs the storyboard's lines through the Meta provider's converse, with the context each screen sends, and prints
 * each reply's words, actions, pages and time. Every raw model reply goes to data/smoke/converse/ (git-ignored), where
 * tests/ai-meta.test.ts replays them without the network.
 *
 *   node --env-file-if-exists=.env scripts/converse-smoke.ts             # every line
 *   node --env-file-if-exists=.env scripts/converse-smoke.ts run plan    # only these screens' lines
 *   node --env-file-if-exists=.env scripts/converse-smoke.ts --effort minimal   # another reasoning effort
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { ConverseContext } from '../shared/ai.ts';
import { createMetaProvider, EFFORT, type Effort } from '../server/ai/meta.ts';

const key = process.env.MODEL_API_KEY;
if (!key) {
  console.error('MODEL_API_KEY is not set. Put it in .env (see .env.example), then run this again.');
  process.exit(1);
}

// The run as the app keeps it (src/state/run.ts): the storyboard's BCA plate, 12 samples in duplicate.
const run = { protocolId: 'pierce-bca', procedure: 'microplate', samples: 12, replicates: 2, standardReplicates: 2, standards: 'kit' as const };
const at = (screen: string, extra: Partial<ConverseContext> = {}): ConverseContext => ({ screen, ...run, ...extra });

export const LINES: { label: string; text: string; context: ConverseContext }[] = [
  { label: 'home-bca', text: 'I just got a Pierce BCA protein assay kit. Help me run it', context: at('home', { protocolId: null }) },
  // As the app sends it on a first run: the fresh run already names the BCA protocol.
  { label: 'home-fresh', text: 'I just got a Pierce BCA protein assay kit. Help me run it', context: at('home') },
  { label: 'home-zh', text: '我拿到一盒 Pierce BCA 蛋白定量 kit，帶我做', context: at('home') },
  { label: 'plan-samples', text: '12 samples, in duplicate', context: at('plan') },
  { label: 'plan-triplicates', text: 'make it triplicates', context: at('plan') },
  { label: 'run-cloudy', text: 'What if it turns cloudy when I add B?', context: at('run', { step: 3, stepTitle: 'Add working reagent and mix' }) },
  { label: 'run-next', text: 'next', context: at('run', { step: 1, stepTitle: 'Prepare the working reagent' }) },
  { label: 'run-timer', text: 'start the timer', context: at('run', { step: 4, stepTitle: 'Incubate' }) },
  { label: 'results-sample', text: 'Is this my real data?', context: at('results', { step: 6, readingsFrom: 'sample' }) },
  { label: 'results-blank', text: 'Why do I subtract the blank?', context: at('results', { step: 6, readingsFrom: 'sample' }) },
];

const args = process.argv.slice(2);
const flag = args.indexOf('--effort');
const effort = (flag >= 0 ? args.splice(flag, 2)[1] : EFFORT.converse) as Effort;
const only = args;
const lines = only.length ? LINES.filter(l => only.some(o => l.label.startsWith(o))) : LINES;

const out = new URL('../data/smoke/converse/', import.meta.url);
mkdirSync(out, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

// Keeps every raw reply (and how long it took) for the line in progress.
let raw: { seconds: number; status: number; body: unknown }[] = [];
const recording = (async (url: string, init: RequestInit) => {
  const started = Date.now();
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Keep the text.
  }
  raw.push({ seconds: (Date.now() - started) / 1000, status: res.status, body });
  return new Response(text, { status: res.status, headers: res.headers });
}) as typeof fetch;

const meta = createMetaProvider({ apiKey: key, fetch: recording, log: () => {}, effort: { converse: effort } });
const times: number[] = [];
for (const line of lines) {
  raw = [];
  const started = Date.now();
  let reply: unknown;
  try {
    reply = await meta.converse({ text: line.text, context: line.context });
  } catch (error) {
    reply = { error: error instanceof Error ? error.message : String(error) };
  }
  const seconds = (Date.now() - started) / 1000;
  times.push(seconds);
  writeFileSync(new URL(`${stamp}-${line.label}.json`, out), JSON.stringify({ ...line, effort, seconds, raw, reply }, null, 2));
  const r = reply as { say?: string; actions?: unknown[]; sources?: { page?: number }[]; error?: string };
  const usage = (raw.at(-1)?.body as { usage?: { completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } } })?.usage;
  console.log(`${line.label}  ${seconds.toFixed(1)} s  ${raw.length} call(s)  out ${usage?.completion_tokens ?? '?'} tok (reasoning ${usage?.completion_tokens_details?.reasoning_tokens ?? '?'})`);
  console.log(`  ${r.error ?? r.say}`);
  if (r.actions?.length) console.log(`  actions ${JSON.stringify(r.actions)}`);
  const pages = r.sources?.map(s => s.page).filter(Boolean);
  if (pages?.length) console.log(`  pages ${pages.join(', ')}`);
}
times.sort((a, b) => a - b);
console.log(`\n${times.length} line(s) at ${effort} effort: median ${times[Math.floor(times.length / 2)]?.toFixed(1)} s, max ${times.at(-1)?.toFixed(1)} s. Raw replies in data/smoke/converse/${stamp}-*.json`);
