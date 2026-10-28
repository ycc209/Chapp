/**
 * The import benchmark's runner: one configuration at a time, one call at a time, each saved to data/bench/runs/.
 *
 *   node --env-file-if-exists=.env scripts/bench/run.ts --plan meta              # run what is not done yet
 *   node --env-file-if-exists=.env scripts/bench/run.ts --plan meta --list       # what it would run
 *   node --env-file-if-exists=.env scripts/bench/run.ts --plan claude --only opus --dry-run
 *   node --env-file-if-exists=.env scripts/bench/run.ts --plan meta --only muse-spark-1.3/current --force
 *
 * --dry-run builds each call's request (document elided) into data/bench/dry-run/ and checks the schema translation,
 * without sending anything. Keys are only checked for presence, never printed. Then scripts/bench/report.ts writes
 * data/bench/results.json and data/bench/REPORT.md.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { anthropicApiAdapter } from './adapters/anthropic-api.ts';
import { claudeCliAdapter, claudeLoggedIn } from './adapters/claude-cli.ts';
import { codexCliAdapter } from './adapters/codex-cli.ts';
import { metaAdapter } from './adapters/meta.ts';
import { openaiApiAdapter } from './adapters/openai-api.ts';
import type { CallName } from '../../server/ai/import.ts';
import { BCA_PDF, BENCH_DIR, CALLS, loadGold, loadManual, readRun, requestFor, runConfig, saveRun, type Adapter, type RunConfig, type RunRecord } from './core.ts';
import { PLANS } from './plan.ts';
import { costOf } from './prices.ts';
import { issues } from './schema.ts';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const planName = option('--plan') ?? 'meta';
const plan = PLANS[planName];
if (!plan) {
  console.error(`No plan "${planName}". Plans: ${Object.keys(PLANS).join(', ')}`);
  process.exit(1);
}
const only = option('--only');
const configs = plan().filter(c => !only || c.key.includes(only));
const timeoutMs = Number(option('--timeout') ?? 360) * 1000;

function adapterFor(provider: string): Adapter | null {
  switch (provider) {
    case 'meta':
      return process.env.MODEL_API_KEY ? metaAdapter(process.env.MODEL_API_KEY) : null;
    case 'claude-cli':
      return claudeCliAdapter();
    case 'codex-cli':
      return codexCliAdapter();
    case 'anthropic-api':
      return anthropicApiAdapter(process.env.ANTHROPIC_API_KEY);
    case 'openai-api':
      return openaiApiAdapter(process.env.OPENAI_API_KEY);
    default:
      return null;
  }
}

if (flag('--list')) {
  for (const c of configs) console.log(`${readRun(c.key) ? 'done' : '    '}  ${c.key}  ${CALLS.map(x => `${x}=${c.efforts[x]}${c.asText.includes(x) ? '(text)' : ''}`).join(' ')}${c.reuse ? `  reuses ${c.reuse.calls.join(',')} of ${c.reuse.key}` : ''}`);
  process.exit(0);
}

const manual = loadManual(BCA_PDF);
const gold = loadGold();

if (flag('--dry-run')) {
  // No inventory yet: the later calls' prompts lack its ids, which only makes them shorter than the real ones.
  for (const c of configs) {
    const adapter = adapterFor(c.provider);
    if (!adapter) {
      console.log(`${c.key}: no adapter (key missing?)`);
      continue;
    }
    const dir = join(BENCH_DIR, 'dry-run', c.key.replace(/[/#]/g, '__'));
    mkdirSync(dir, { recursive: true });
    for (const call of CALLS) {
      const req = requestFor(c, call, null);
      const built = adapter.build(req, manual);
      writeFileSync(join(dir, `${call}.json`), JSON.stringify(built, null, 2));
      const target = c.provider.startsWith('claude') || c.provider.startsWith('anthropic') ? 'claude' : 'strict';
      const problems = issues(req.schema, target);
      console.log(`${c.key} ${call}: built (${JSON.stringify(built).length} chars), schema ${problems.length ? `PROBLEMS: ${problems.join('; ')}` : 'ok'}`);
    }
  }
  process.exit(0);
}

const log = (line: string) => console.log(line);
if (configs.some(c => c.provider === 'claude-cli' && !readRun(c.key)) && !claudeLoggedIn()) {
  log('Claude Code is not logged in here (claude auth status): run `claude setup-token` and put CLAUDE_CODE_OAUTH_TOKEN in .env, or log in where the keychain can be read.');
  process.exit(2);
}
/** A call that failed on the provider's side (a 5xx, a dropped connection) is worth one more try; a timeout, refusal or limit is a result. */
const transient = (r: RunRecord, call: CallName) => r.calls[call].status === 'error' && /^5\d\d|internal server error|could not connect|fetch failed|ECONN|socket/i.test(r.calls[call].error ?? '');

for (const original of configs as RunConfig[]) {
  let c = original;
  const done = readRun(c.key);
  let retried: string[] = [];
  if (done && !flag('--force')) {
    // Send again only what failed for a transient reason (and what came after an inventory that failed), once.
    const failed = CALLS.filter(x => transient(done, x));
    if (!failed.length || done.notes.some(n => n.startsWith('retried'))) continue;
    const resend = new Set<CallName>(failed.includes('inventory') ? ['inventory', 'steps', 'curves', 'notes', ...failed] : failed);
    c = { ...c, reuse: { key: c.key, calls: CALLS.filter(x => !resend.has(x)) } };
    retried = failed.map(x => `${x} (first try: ${done.calls[x].error?.slice(0, 80)} after ${done.calls[x].seconds} s)`);
  }
  if (c.reuse && !readRun(c.reuse.key)) {
    log(`skip ${c.key}: needs ${c.reuse.key} first`);
    continue;
  }
  const adapter = adapterFor(c.provider);
  if (!adapter) {
    log(`skip ${c.key}: no adapter or key for ${c.provider}`);
    continue;
  }
  log(`${new Date().toISOString().slice(11, 19)} ${c.key}`);
  const run = await runConfig(c, adapter, { manual, gold, timeoutMs, prices: costOf, log });
  if (retried.length) {
    run.notes.unshift(`retried ${retried.join('; ')}`);
    // The calls kept from the first try are this run's own, not copies of another run.
    for (const x of CALLS) if (run.calls[x].from === c.key) run.calls[x] = { ...done!.calls[x] };
    run.startedAt = done!.startedAt;
  }
  saveRun(run);
  const p = c.kind === 'current' ? run.pipeline.wall.current : run.pipeline.wall.original;
  const score = c.kind === 'current' ? run.score.withIntro : run.score.withoutIntro;
  log(`  → ${run.status}: steps visible ${p.stepsVisible ?? '–'} s, total ${p.total ?? '–'} s, ${score.passed}/${score.total} checks` +
    (run.costUsd !== null ? `, $${run.costUsd.toFixed(3)}` : '') + (run.reportedCostUsd !== null && run.reportedCostUsd !== undefined ? ` (reported $${run.reportedCostUsd.toFixed(3)})` : ''));
  if (run.notes.length) log(`  notes: ${run.notes.join(' | ')}`);
  // A usage limit stops this provider: nothing after it would get through.
  const limited = CALLS.some(x => /usage limit|rate limit|quota|limit reached|429/i.test(run.calls[x].error ?? ''));
  if (limited) {
    log(`stopping ${c.provider}: it reported a usage limit`);
    break;
  }
}
