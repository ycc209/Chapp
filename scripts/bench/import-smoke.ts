/**
 * Brings runs made outside the benchmark into it, without sending anything: the raw replies scripts/import-protocol.ts
 * kept in data/smoke/import/<name>/<call>.json (each with its seconds), read and scored the benchmark's way.
 *
 *   node scripts/bench/import-smoke.ts
 *
 * Today: muse-spark-1.3 after the switch to ASCII unit enums (2026-10-28), "current v2" being the app's new defaults
 * (intro minimal on the PDF, inventory minimal, steps low, curves and notes minimal, all four on text). These ran as the
 * app runs them (intro beside the inventory, then three at once), not one call at a time, so their per-call times
 * carry a little concurrency; the pipeline times are computed from them the same way as for every other run.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readWire, renameLegacy, replyText, type CallName } from '../../server/ai/import.ts';
import {
  BCA_PDF, CALLS, ROOT, SPECS, loadGold, loadManual, pipelineOf, saveRun, scoreParts, schemaUnits,
  type CallResult, type Kind, type RunRecord,
} from './core.ts';

type Json = Record<string, any>;

const SETS: { dir: string; label: string; kind: Kind; repeat: number }[] = [
  ...[1, 2, 3, 4, 5].map(n => ({ dir: `ascii-text-min-${n}`, label: 'text-minimal-v2', kind: 'text' as Kind, repeat: n })),
  ...[1, 2, 3, 4].map(n => ({ dir: `ascii-text-stepslow-${n}`, label: 'text-steps-low-v2', kind: 'text' as Kind, repeat: n })),
  { dir: 'final-bca', label: 'current-v2', kind: 'current', repeat: 1 },
];

const manual = loadManual(BCA_PDF);
const gold = loadGold();

for (const set of SETS) {
  const dir = join(ROOT, 'data/smoke/import', set.dir);
  if (!CALLS.every(c => existsSync(join(dir, `${c}.json`)))) {
    console.log(`skip ${set.dir}: not all five replies are there`);
    continue;
  }
  const calls = {} as Record<CallName, CallResult>;
  const wire: Json = { intro: null, inventory: null, steps: null, curves: null, notes: null };
  let model = '';
  let started = Infinity;
  let finished = 0;
  for (const call of CALLS) {
    const { seconds, reply } = JSON.parse(readFileSync(join(dir, `${call}.json`), 'utf8')) as { seconds: number; reply: Json };
    model = reply.model ?? model;
    started = Math.min(started, (reply.created_at ?? Infinity) * 1000);
    finished = Math.max(finished, (reply.completed_at ?? 0) * 1000);
    const u = reply.usage ?? {};
    let json: unknown;
    try {
      json = JSON.parse(replyText(reply));
      wire[call] = readWire(SPECS[call], renameLegacy(call, json));
    } catch {
      json = undefined;
    }
    calls[call] = {
      call,
      effort: reply.reasoning?.effort ?? '?',
      // The reply does not say what it read; the PDF is ~18k tokens of input, the text ~5–6k.
      input: (u.input_tokens ?? 0) > 12_000 ? 'pdf' : 'text',
      status: json === undefined ? 'bad-json' : 'ok',
      seconds,
      apiSeconds: seconds,
      usage: { input: u.input_tokens ?? 0, cachedInput: u.input_tokens_details?.cached_tokens ?? 0, cacheWrite: 0, output: u.output_tokens ?? 0, reasoning: u.output_tokens_details?.reasoning_tokens ?? null },
      costUsd: null,
      json,
      raw: join('data/smoke/import', set.dir, `${call}.json`),
    };
  }
  const secs = Object.fromEntries(CALLS.map(c => [c, calls[c].status === 'ok' ? calls[c].seconds : null]));
  const used = CALLS.map(c => calls[c]);
  const run: RunRecord = {
    key: `meta/${model}/${set.label}#${set.repeat}`,
    provider: 'meta',
    vendor: 'Meta',
    model,
    kind: set.kind,
    label: set.label,
    repeat: set.repeat,
    efforts: Object.fromEntries(CALLS.map(c => [c, calls[c].effort])) as Record<CallName, string>,
    asText: CALLS.filter(c => calls[c].input === 'text'),
    schemaUnits: schemaUnits(),
    source: `data/smoke/import/${set.dir}: run by the lead with scripts/import-protocol.ts as the app runs it (calls side by side, not one at a time); scored here`,
    startedAt: new Date(Number.isFinite(started) ? started : 0).toISOString(),
    finishedAt: new Date(finished).toISOString(),
    status: used.every(c => c.status === 'ok') ? 'ok' : 'partial',
    calls,
    pipeline: { wall: pipelineOf(secs), api: pipelineOf(secs) },
    score: { withoutIntro: scoreParts({ ...wire, intro: null } as never, manual, gold), withIntro: scoreParts(wire as never, manual, gold) },
    tokens: {
      input: used.reduce((a, c) => a + (c.usage?.input ?? 0), 0),
      cachedInput: used.reduce((a, c) => a + (c.usage?.cachedInput ?? 0), 0),
      output: used.reduce((a, c) => a + (c.usage?.output ?? 0), 0),
      reasoning: used.reduce((a, c) => a + (c.usage?.reasoning ?? 0), 0),
    },
    costUsd: null,
    reportedCostUsd: null,
    notes: [],
  };
  saveRun(run);
  const compare = existsSync(join(dir, 'compare.json')) ? JSON.parse(readFileSync(join(dir, 'compare.json'), 'utf8')) : null;
  const shape = set.kind === 'current' ? 'current' : 'original';
  const score = set.kind === 'current' ? run.score.withIntro : run.score.withoutIntro;
  console.log(`${run.key}: ${CALLS.map(c => `${c} ${calls[c].effort}/${calls[c].input} ${calls[c].seconds.toFixed(1)} s`).join(', ')}; ` +
    `steps visible ${run.pipeline.wall[shape].stepsVisible} s, total ${run.pipeline.wall[shape].total} s; ${score.passed}/49 (with intro ${run.score.withIntro.passed}; the lead's compare: ${compare?.passed ?? '?'}/${compare?.total ?? '?'} in ${compare?.seconds ?? '?'} s)`);
}
