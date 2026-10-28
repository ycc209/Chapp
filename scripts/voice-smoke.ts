/**
 * Says the storyboard's lines with macOS voices, converts each to the 16 kHz mono WAV the phone sends, and has the Meta
 * provider transcribe it (Muse Voice Transcribe, then the lab-word fixes). Prints what came back and how long it took;
 * saves the results to data/smoke/converse/ (git-ignored).
 *
 *   node --env-file-if-exists=.env scripts/voice-smoke.ts                 # every line, Samantha and Daniel
 *   node --env-file-if-exists=.env scripts/voice-smoke.ts --voice Samantha
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMetaProvider } from '../server/ai/meta.ts';

const key = process.env.MODEL_API_KEY;
if (!key) {
  console.error('MODEL_API_KEY is not set. Put it in .env (see .env.example), then run this again.');
  process.exit(1);
}

export const SAID = [
  'I just got a Pierce BCA protein assay kit. Help me run it.',
  '12 samples, in duplicate.',
  'Make it triplicates.',
  'What if it turns cloudy when I add B?',
  'Next.',
  'Start the timer.',
  'C is OK.',
  'Which samples are out of range?',
];

const at = process.argv.indexOf('--voice');
const voices = at > 0 ? [process.argv[at + 1]!] : ['Samantha', 'Daniel'];
const dir = mkdtempSync(join(tmpdir(), 'chapp-voice-'));
const out = new URL('../data/smoke/converse/', import.meta.url);
mkdirSync(out, { recursive: true });

// The raw transcript, before the lab-word fixes, from the provider's own request.
let heard = '';
const recording = (async (url: string, init: RequestInit) => {
  const res = await fetch(url, init);
  const text = await res.text();
  try {
    heard = JSON.parse(text).transcript ?? '';
  } catch {
    heard = '';
  }
  return new Response(text, { status: res.status, headers: res.headers });
}) as typeof fetch;
const meta = createMetaProvider({ apiKey: key, fetch: recording, log: () => {} });

const results: { voice: string; said: string; heard: string; transcript: string; seconds: number }[] = [];
for (const voice of voices) {
  for (const [i, said] of SAID.entries()) {
    const aiff = join(dir, `${i}.aiff`);
    const wav = join(dir, `${i}.wav`);
    execFileSync('say', ['-v', voice, '-o', aiff, said]);
    execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, wav]);
    const audio = new Uint8Array(readFileSync(wav));
    const started = Date.now();
    let transcript: string;
    try {
      transcript = (await meta.transcribe(audio)).transcript;
    } catch (error) {
      transcript = `(failed: ${error instanceof Error ? error.message : error})`;
    }
    const seconds = (Date.now() - started) / 1000;
    results.push({ voice, said, heard, transcript, seconds });
    console.log(`${voice.padEnd(9)} ${seconds.toFixed(1)} s  ${(audio.length / 32000).toFixed(1)} s audio`);
    console.log(`  said  ${said}\n  heard ${heard}${transcript !== heard ? `\n  fixed ${transcript}` : ''}`);
  }
}
const times = results.map(r => r.seconds).sort((a, b) => a - b);
console.log(`\n${times.length} clip(s): median ${times[Math.floor(times.length / 2)]?.toFixed(1)} s, max ${times.at(-1)?.toFixed(1)} s`);
writeFileSync(new URL(`voice-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, out), JSON.stringify(results, null, 2));
