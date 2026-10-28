/**
 * Turns the benchmark's runs (data/bench/runs/) into data/bench/results.json and data/bench/REPORT.md.
 *
 *   node scripts/bench/report.ts
 *
 * Per model: the original pipeline (all at medium, no intro: steps show when everything is done) against the current
 * one (intro at the lowest level beside the inventory at low, then the rest at the lowest, curves and notes on text:
 * steps show when the intro is back), and the uniform sweep, one row per effort level. Then one ranking across
 * vendors: the fastest and the cheapest configurations that still get at least 47 of the 49 BCA checks.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CallName } from '../../server/ai/import.ts';
import { compareProtocols } from '../../server/ai/import-check.ts';
import { BCA_PDF, BENCH_DIR, CALLS, loadGold, loadManual, type CallResult, type RunRecord } from './core.ts';
import { PLANS } from './plan.ts';
import { costOf, PRICES } from './prices.ts';

type Shape = 'original' | 'current';
type Stat = { mean: number; median: number; min: number; max: number; values: number[] } | null;

/** The hand-made protocol's own number of checks (49): a run whose dilution tables are missing produces fewer. */
const GOLD_CHECKS = compareProtocols(loadGold(), loadGold()).length;
const runsDir = join(BENCH_DIR, 'runs');
const runs: RunRecord[] = existsSync(runsDir)
  ? readdirSync(runsDir).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(runsDir, f), 'utf8')) as RunRecord)
  : [];
runs.sort((a, b) => a.startedAt.localeCompare(b.startedAt));

const r1 = (n: number) => Math.round(n * 10) / 10;
const stat = (values: (number | null | undefined)[]): Stat => {
  const v = values.filter((x): x is number => typeof x === 'number');
  const sorted = [...v].sort((a, b) => a - b);
  const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;
  return v.length ? { mean: v.reduce((a, b) => a + b, 0) / v.length, median, min: Math.min(...v), max: Math.max(...v), values: v } : null;
};

/** The calls a shape's pipeline uses: the original has no intro. */
const shapeCalls = (shape: Shape): CallName[] => (shape === 'original' ? CALLS.filter(c => c !== 'intro') : [...CALLS]);
const usable = (c: CallResult) => ['ok', 'reused', 'skipped'].includes(c.status);

function costFor(run: RunRecord, shape: Shape, field: 'costUsd' | 'reportedCostUsd'): number | null {
  let total = 0;
  for (const c of shapeCalls(shape)) {
    const call = run.calls[c];
    if (call.status === 'skipped') continue;
    // List prices are applied here, from today's table, so a price added to scripts/bench/prices.ts (Meta's, once
    // known) reaches every run without sending anything again.
    const v = field === 'costUsd' && call.usage ? costOf(run.model, call.usage) : call[field];
    if (typeof v !== 'number') return null;
    total += v;
  }
  return total;
}

function summarize(list: RunRecord[], shape: Shape) {
  const score = (r: RunRecord) => (shape === 'current' ? r.score.withIntro : r.score.withoutIntro);
  return {
    runs: list.map(r => r.key),
    status: list.map(r => r.status),
    /** The unit enums the schemas used: "micro-sign" (µL, µg/mL) before the 2026-10-28 fix, "ascii" (uL, ug/mL) after. */
    units: [...new Set(list.map(r => r.schemaUnits ?? 'micro-sign'))].join(' + '),
    stepsVisible: stat(list.map(r => r.pipeline.wall[shape].stepsVisible)),
    total: stat(list.map(r => r.pipeline.wall[shape].total)),
    apiStepsVisible: stat(list.map(r => r.pipeline.api[shape].stepsVisible)),
    apiTotal: stat(list.map(r => r.pipeline.api[shape].total)),
    accuracy: { passed: list.map(r => score(r).passed), total: GOLD_CHECKS, failed: list.map(r => score(r).failed) },
    costUsd: stat(list.map(r => costFor(r, shape, 'costUsd'))),
    reportedCostUsd: stat(list.map(r => costFor(r, shape, 'reportedCostUsd'))),
    tokens: {
      input: stat(list.map(r => shapeCalls(shape).reduce((a, c) => a + (r.calls[c].usage?.input ?? 0), 0))),
      output: stat(list.map(r => shapeCalls(shape).reduce((a, c) => a + (r.calls[c].usage?.output ?? 0), 0))),
      reasoning: stat(list.map(r => (shapeCalls(shape).every(c => r.calls[c].status === 'skipped' || r.calls[c].usage?.reasoning != null) ? shapeCalls(shape).reduce((a, c) => a + (r.calls[c].usage?.reasoning ?? 0), 0) : null))),
    },
    perCall: Object.fromEntries(CALLS.map(c => [c, stat(list.map(r => (usable(r.calls[c]) ? r.calls[c].seconds : null)))])) as Record<CallName, Stat>,
    perCallApi: Object.fromEntries(CALLS.map(c => [c, stat(list.map(r => (usable(r.calls[c]) ? r.calls[c].apiSeconds : null)))])) as Record<CallName, Stat>,
  };
}
type Summary = ReturnType<typeof summarize>;

const LEVEL_ORDER = ['none', 'minimal', 'low', 'low-nothink', 'medium', 'high', 'xhigh', 'max'];
const vendors = ['Meta', 'Anthropic', 'OpenAI'];
const models = [...new Map(runs.map(r => [`${r.provider}/${r.model}`, { provider: r.provider, vendor: r.vendor, model: r.model }])).values()];

/** "minimal" when every call has the same level, else "steps low, rest minimal". */
function describeLevels(e: Record<CallName, string>): string {
  const counts = new Map<string, number>();
  for (const c of CALLS) counts.set(e[c], (counts.get(e[c]) ?? 0) + 1);
  const most = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  const others = CALLS.filter(c => e[c] !== most);
  return others.length ? `${others.map(c => `${c} ${e[c]}`).join(', ')}, rest ${most}` : most;
}
const ascii = (s: { units: string }) => (s.units === 'ascii' ? ' (ASCII units)' : '');

const perModel = models.map(m => {
  const mine = runs.filter(r => r.provider === m.provider && r.model === m.model);
  const of = (kind: string, label?: string) => mine.filter(r => r.kind === kind && (!label || r.label === label));
  const original = of('original');
  const levels = [...new Set(mine.filter(r => r.kind === 'sweep' || r.kind === 'original').map(r => (r.kind === 'original' ? 'medium' : r.efforts.inventory)))];
  levels.sort((a, b) => LEVEL_ORDER.indexOf(a) - LEVEL_ORDER.indexOf(b));
  return {
    ...m,
    lowest: of('current', 'current')[0]?.efforts.intro ?? null,
    original: original.length ? summarize(original, 'original') : null,
    current: of('current', 'current').length ? summarize(of('current', 'current'), 'current') : null,
    /** The app's defaults after the ASCII-unit fix (imported from the lead's runs: scripts/bench/import-smoke.ts). */
    currentV2: of('current', 'current-v2').length ? summarize(of('current', 'current-v2'), 'current') : null,
    // The sweep at medium is the original run(s).
    sweep: levels.map(level => ({ level, ...summarize(level === 'medium' ? original : mine.filter(r => r.kind === 'sweep' && r.efforts.inventory === level), 'original') })),
    text: [...new Set(of('text').map(r => r.label))].map(label => {
      const list = of('text').filter(r => r.label === label);
      const e = list[0]!.efforts;
      return { level: describeLevels(e), ...summarize(list, 'original') };
    }),
  };
});

// ─── The ranking ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Times and accuracy are medians over the configuration's runs; `reliable` is how many runs got at least 47/49. */
type Entry = { vendor: string; provider: string; model: string; config: string; stepsVisible: number; total: number; wallTotal: number; accuracy: number; reliable: string; costUsd: number | null; runs: number };
const entries: Entry[] = [];
for (const m of perModel) {
  const add = (config: string, s: Summary | null, shape: Shape) => {
    if (!s || !s.apiTotal || !s.apiStepsVisible || !s.total) return;
    const accuracy = stat(s.accuracy.passed)!.median;
    const reliable = `${s.accuracy.passed.filter(p => p >= 47).length}/${s.accuracy.passed.length}`;
    entries.push({ vendor: m.vendor, provider: m.provider, model: m.model, config, stepsVisible: r1(s.apiStepsVisible.median), total: r1(s.apiTotal.median), wallTotal: r1(s.total.median), accuracy, reliable, costUsd: s.costUsd ? s.costUsd.median : null, runs: s.runs.length });
    void shape;
  };
  add('current', m.current, 'current');
  if (m.currentV2) add('current v2 (ASCII units)', m.currentV2, 'current');
  for (const s of m.sweep) add(s.level === 'medium' ? 'original (all medium)' : `all ${s.level}`, s, 'original');
  for (const s of m.text) add(`${s.level.includes(' ') ? `text only, ${s.level}` : `all ${s.level}, text only`}${ascii(s)}`, s, 'original');
}
const good = entries.filter(e => e.accuracy >= 47);
const fastestSteps = [...good].sort((a, b) => a.stepsVisible - b.stepsVisible);
const fastestTotal = [...good].sort((a, b) => a.total - b.total);
const cheapest = good.filter(e => e.costUsd !== null).sort((a, b) => a.costUsd! - b.costUsd!);

// ─── Notes: what went wrong, what was adapted, how much runs vary ────────────────────────────────────────────────

const incidents = runs.flatMap(r =>
  CALLS.filter(c => !usable(r.calls[c])).map(c => ({ run: r.key, call: c, status: r.calls[c].status, seconds: r.calls[c].seconds, error: r.calls[c].error ?? '' })),
);
const variance = perModel.flatMap(m =>
  (['original', 'current'] as const).flatMap(shape => {
    const s = m[shape];
    if (!s || s.runs.length < 2 || !s.apiTotal) return [];
    return [{ model: `${m.provider}/${m.model}`, shape, totals: s.apiTotal.values.map(r1), stepsVisible: s.apiStepsVisible?.values.map(r1) ?? [], accuracy: s.accuracy.passed, spread: r1(s.apiTotal.max - s.apiTotal.min), spreadPct: Math.round(((s.apiTotal.max - s.apiTotal.min) / s.apiTotal.mean) * 100) }];
  }),
);

/** Every configuration run more than once: how many runs reach 47/49, what the others missed, median and range of time. */
const repeated = [...new Set(runs.map(r => `${r.provider}/${r.model}/${r.label}`))].flatMap(id => {
  const list = runs.filter(r => `${r.provider}/${r.model}/${r.label}` === id).sort((a, b) => a.repeat - b.repeat);
  if (list.length < 2) return [];
  const shape: Shape = list[0]!.kind === 'current' ? 'current' : 'original';
  const score = (r: RunRecord) => (shape === 'current' ? r.score.withIntro : r.score.withoutIntro);
  const totals = stat(list.map(r => r.pipeline.api[shape].total));
  const steps = stat(list.map(r => r.pipeline.api[shape].stepsVisible));
  return [{
    model: `${list[0]!.provider}/${list[0]!.model}`,
    label: list[0]!.label,
    runs: list.length,
    reliable: `${list.filter(r => score(r).passed >= 47).length}/${list.length}`,
    accuracy: list.map(r => score(r).passed),
    totals: list.map(r => r.pipeline.api[shape].total),
    medianTotal: totals ? r1(totals.median) : null,
    range: totals ? `${r1(totals.min)}–${r1(totals.max)}` : '–',
    medianSteps: steps ? r1(steps.median) : null,
    bad: list.filter(r => score(r).passed < 47).map(r => ({ repeat: r.repeat, passed: score(r).passed, failed: score(r).failed })),
  }];
});

const manual = loadManual(BCA_PDF);
const results = {
  schema: 'chapp.bench/1',
  generatedAt: new Date().toISOString(),
  document: { path: 'data/sources/pierce-bca/MAN0011430_Pierce_BCA_Protein_Asy_UG.pdf', sha256: manual.sha256, pages: manual.pages, gold: 'data/protocols/pierce-bca.json', checks: GOLD_CHECKS },
  method: {
    calls: 'intro, inventory, steps, curves, notes: server/ai/import.ts prompts, schemas, assemble(); scored by server/ai/import-check.ts against the hand-made protocol',
    timing: 'each call alone, one after another; pipeline times computed from the per-call times',
    original: 'all calls at medium on the PDF, no intro; steps visible = total = inventory + max(steps, curves, notes)',
    current: 'intro at the lowest level, inventory at low, steps/curves/notes at the lowest, curves and notes on pdftotext text; steps visible = intro; total = max(intro, inventory) + max(steps, curves, notes)',
    sweep: 'all five calls at one level on the PDF, original shape (steps visible = total); the sweep at medium is the original run',
    text: 'all five calls at one level on pdftotext text (same input the Codex CLI gets)',
    apiTime: 'Meta: the HTTP call (wall = API). Claude Code: duration_api_ms. Codex: turn.started to turn.completed as the events arrive. Wall time for the CLIs includes their start-up.',
    accuracy: 'original-shaped configurations are assembled without the intro, current with it',
    cost: 'list price per manual from scripts/bench/prices.ts (null for Meta: no public price); original-shaped costs leave out the intro call',
  },
  prices: PRICES,
  models: perModel,
  ranking: { threshold: 47, fastestToSteps: fastestSteps, fastestTotal, cheapest },
  incidents,
  variance,
  repeated,
  // Runs saved before the schemaUnits field all used the micro sign: every one of them started before the 2026-10-28 fix.
  runs: runs.map(r => ({ ...r, schemaUnits: r.schemaUnits ?? 'micro-sign', calls: Object.fromEntries(CALLS.map(c => [c, { ...r.calls[c], json: undefined }])) })),
};
writeFileSync(join(BENCH_DIR, 'results.json'), JSON.stringify(results, null, 2));

// ─── REPORT.md ───────────────────────────────────────────────────────────────────────────────────────────────────

const s1 = (s: Stat) => (!s ? '–' : s.values.length > 1 ? `${r1(s.mean)} (${s.values.map(r1).join(', ')})` : `${r1(s.mean)}`);
const money = (s: Stat) => (!s ? 'n/a' : s.values.length > 1 ? `$${s.mean.toFixed(3)}` : `$${s.mean.toFixed(3)}`);
const acc = (s: Summary) => s.accuracy.passed.map(p => `${p}`).join(', ') + `/${s.accuracy.total}`;
const k = (s: Stat) => (!s ? '–' : `${(s.mean / 1000).toFixed(1)}k`);
const isCli = (provider: string) => provider.endsWith('-cli');

const lines: string[] = [];
const out = (line = '') => lines.push(line);
out('# Import benchmark: reading the BCA manual into a protocol');
out();
out(`Generated ${results.generatedAt.slice(0, 16).replace('T', ' ')} UTC from ${runs.length} runs in data/bench/runs/. Document: the Pierce BCA user guide (5 pages), scored against data/protocols/pierce-bca.json (49 checks).`);
out();
out('- **Original**: the five-call import before the speed work. All calls at medium on the PDF, no intro; steps show only when everything is done (inventory, then steps, curves and notes side by side).');
out('- **Current**: what the app does now. The intro runs at the lowest level beside the inventory at low, then steps, curves and notes at the lowest level. Curves and notes read the pdftotext text. Steps show as soon as the intro is back.');
out('- **Sweep**: all five calls at one level on the PDF, in the original shape, so time to steps = total. Medium is the original run.');
out('- Every call ran alone, one after another; the pipeline times add them up as the app runs them (`inventory + max(steps, curves, notes)`, and so on). Times are in seconds. A value with a list after it is the mean of two runs, followed by each run.');
out('- **Time**: for Meta, the HTTP call. For the CLIs, the model time (Claude Code `duration_api_ms`; Codex from turn start to turn end), with the wall time, which includes the CLI\'s start-up, in its own column.');
out('- **Cost** is per manual at list price (scripts/bench/prices.ts). Meta publishes no per-token price, so its cost is n/a. Original-shaped costs leave out the intro.');
out();

for (const vendor of vendors) {
  const ms = perModel.filter(m => m.vendor === vendor);
  if (!ms.length) continue;
  out(`## ${vendor}${ms[0] && isCli(ms[0].provider) ? ` (${ms[0].provider === 'codex-cli' ? 'Codex CLI, ChatGPT subscription' : 'Claude Code, subscription'})` : ''}`);
  out();
  const cli = ms.some(m => isCli(m.provider));
  out('### Original vs current');
  out();
  out(`| Model | Pipeline | Steps visible (s) | Total (s) |${cli ? ' Wall total (s) |' : ''} Accuracy | Cost / manual | Runs | Unit enums |`);
  out(`|---|---|---|---|${cli ? '---|' : ''}---|---|---|---|`);
  for (const m of ms) {
    for (const shape of ['original', 'current', 'currentV2'] as const) {
      const s = m[shape];
      if (!s) continue;
      const label = shape === 'original' ? 'original (all medium)'
        : shape === 'current' ? `current (${m.lowest}; inventory low; curves, notes on text)`
        : 'current v2 (ASCII units: intro minimal on PDF; inventory, curves, notes minimal and steps low, on text)';
      out(`| ${m.model} | ${label} | ${s1(s.apiStepsVisible)} | ${s1(s.apiTotal)} |${cli ? ` ${s1(s.total)} |` : ''} ${acc(s)} | ${money(s.costUsd)} | ${s.runs.length} | ${s.units} |`);
    }
  }
  out();
  for (const m of ms) {
    if (!m.sweep.length && !m.text.length) continue;
    out(`### ${m.model}: by effort level (all five calls at one level)`);
    out();
    out(`| Level | Input | Time to steps = total (s) |${cli ? ' Wall (s) |' : ''} Accuracy | Cost / manual | Output tokens (reasoning) | intro | inventory | steps | curves | notes |`);
    out(`|---|---|---|${cli ? '---|' : ''}---|---|---|---|---|---|---|---|`);
    for (const [input, rows] of [['PDF', m.sweep], ['text', m.text]] as const) {
      for (const s of rows) {
        const per = (c: CallName) => s1(s.perCallApi[c]);
        out(`| ${s.level}${ascii(s)} | ${input} | ${s1(s.apiTotal)} |${cli ? ` ${s1(s.total)} |` : ''} ${acc(s)} | ${money(s.costUsd)} | ${k(s.tokens.output)} (${k(s.tokens.reasoning)}) | ${per('intro')} | ${per('inventory')} | ${per('steps')} | ${per('curves')} | ${per('notes')} |`);
      }
    }
    out();
  }
}

out('## Ranking across vendors (median of at least 47 of 49 checks)');
out();
out('Medians over each configuration\'s runs. "Runs ≥ 47" says how many of its runs reached 47/49: one run is no evidence of reliability.');
out();
if (!good.length) out('Nothing reached 47/49 yet.');
else {
  out('### Fastest to steps on screen');
  out();
  out('| # | Vendor | Model | Configuration | Steps visible (s) | Total (s) | Accuracy | Runs ≥ 47 | Cost / manual |');
  out('|---|---|---|---|---|---|---|---|---|');
  fastestSteps.slice(0, 15).forEach((e, i) => out(`| ${i + 1} | ${e.vendor} | ${e.model} | ${e.config} | ${e.stepsVisible} | ${e.total} | ${e.accuracy}/49 | ${e.reliable} | ${e.costUsd === null ? 'n/a' : `$${e.costUsd.toFixed(3)}`} |`));
  out();
  out('### Fastest to the whole protocol');
  out();
  out('| # | Vendor | Model | Configuration | Total (s) | Steps visible (s) | Accuracy | Runs ≥ 47 | Cost / manual |');
  out('|---|---|---|---|---|---|---|---|---|');
  fastestTotal.slice(0, 15).forEach((e, i) => out(`| ${i + 1} | ${e.vendor} | ${e.model} | ${e.config} | ${e.total} | ${e.stepsVisible} | ${e.accuracy}/49 | ${e.reliable} | ${e.costUsd === null ? 'n/a' : `$${e.costUsd.toFixed(3)}`} |`));
  out();
  out('### Cheapest');
  out();
  if (!cheapest.length) out('No priced configuration reached 47/49 yet (Meta has no public price).');
  else {
    out('| # | Vendor | Model | Configuration | Cost / manual | Total (s) | Accuracy | Runs ≥ 47 |');
    out('|---|---|---|---|---|---|---|---|');
    cheapest.slice(0, 15).forEach((e, i) => out(`| ${i + 1} | ${e.vendor} | ${e.model} | ${e.config} | $${e.costUsd!.toFixed(4)} | ${e.total} | ${e.accuracy}/49 | ${e.reliable} |`));
  }
  out();
}

out('## Notes');
out();
out('### Refusals, timeouts and failed calls');
out();
if (!incidents.length) out('None: every call answered in the format asked for.');
else for (const i of incidents) out(`- ${i.run} ${i.call}: ${i.status} after ${r1(i.seconds)} s${i.error ? `: ${i.error.slice(0, 200)}` : ''}`);
out();
out('### How each provider was run');
out();
out('- **Meta**: `/responses` exactly as server/ai/import.ts sends it: the PDF as `input_file` (or the text as `input_text`), the rules as the system message, strict `text.format`, `reasoning.effort`. Muse Spark 1.3 and Muse Wonder 1.0 take minimal to max; Muse Spark 1.2 takes minimal to xhigh. Meta caches the PDF prefix, so a call right after another on the same PDF often reads most of it from cache (see `cachedInput` in results.json).');
out('- **OpenAI via Codex CLI** (`codex exec`, ChatGPT subscription): Codex takes no PDF, so every call gets the pdftotext text. Calls that read the PDF elsewhere also get the five pages as 100-dpi PNGs (`-i`). The rules, manual and task form one prompt, since Codex keeps its own instructions. The schema goes through `--output-schema`. The shell tool is off, the user config.toml is not loaded (`--ignore-user-config`), and nothing is kept (`--ephemeral`). Codex adds its own instructions and tool list, about 14k input tokens even on a one-line prompt; that overhead is in its token counts and cost. Model time runs from `turn.started` to `turn.completed`; wall time includes the CLI start-up, about 2 s. Codex also writes a one-line preamble ("I\'ll transcribe both dilution tables…") before the answer, which is a second model request on the same, mostly cached, prompt. Its time is included, as it is in any use of Codex; the API alone would be somewhat faster.');
out('- **Claude via Claude Code** (`claude -p`, subscription): the PDF as a base64 `document` block over `--input-format stream-json`; `--system-prompt` with the rules; `--json-schema`, answered through Claude Code\'s StructuredOutput tool; `--safe-mode`, no MCP and no other tools. Times come from `duration_api_ms` and `duration_ms`.');
out();
const pending = Object.entries(PLANS).flatMap(([name, plan]) => {
  const left = plan().filter(c => !runs.some(r => r.key === c.key));
  const started = plan().some(c => runs.some(r => r.key === c.key));
  return left.length && (started || name === 'claude') ? [`- plan \`${name}\`: ${left.length} configuration(s) not run yet${started ? '' : name === 'claude' ? ': Claude Code is not logged in from this session (the login keychain cannot be read here); it runs once CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) is in .env' : ''}`] : [];
});
if (pending.length) {
  out('### Not run yet');
  out();
  for (const line of pending) out(line);
  out();
}
const imported = runs.filter(r => r.source);
if (imported.length) {
  out('### Runs brought in from elsewhere');
  out();
  out(`${imported.length} runs were not sent by the benchmark but read from the raw replies the lead kept (scripts/bench/import-smoke.ts): ${[...new Set(imported.map(r => `${r.model} ${r.label}`))].join(', ')}. They ran as the app runs them, with the intro beside the inventory and then three calls at once, not one call at a time, so their per-call times carry a little concurrency. They were scored here with today\'s import.ts, which reads "Rev. D" as "D", so two text-steps-low-v2 runs score 48 here where the lead\'s compare said 47.`);
  out();
}
out('### Unit enums (micro sign or ASCII)');
out();
out('Until 2026-10-28 ~12:00 UTC the schemas\' unit enums used the micro sign ("µL", "µg/mL"). Muse Spark 1.3 at minimal and low often answered "mL" or "mg/mL" instead, in 8 of its 13 runs at those levels. That is every Spark 1.3 score of 25–29/49. One wrong range unit costs about 17 checks, because import-check matches the dilution tables by their range. The low scores of Muse Wonder 1.0 and Muse Spark 1.2 come from something else: the steps call returned empty `additions` and `alternatives` lists, and the curves call gave vial ids that were the curve\'s id, with concentration 0, so those rows were dropped. server/ai/import.ts now sends ASCII ("uL", "ug/mL") and reads it back as µ. Every run records which it used (`schemaUnits` in results.json). All Meta runs sent by the benchmark, and all Codex runs, used the micro sign. Codex never slipped on units with it. The *v2* rows and Claude runs, if any, use ASCII.');
out();
out('### Schema adaptations');
out();
out('None were needed. The import\'s schemas use only flat objects whose fields are all required, `additionalProperties: false`, string enums, string arrays and the plain types. Meta, OpenAI strict json_schema and Claude structured outputs all take that subset as it is. scripts/bench/schema.ts would drop the keywords Claude does not take (`minimum`, `maxLength`, `minItems` and similar), but the import uses none of them, and tests/bench-schema.test.ts checks that. Each provider gets the same schema in its own wrapper: Meta and OpenAI `text.format`, Codex `--output-schema`, Claude `output_config.format` / Claude Code `--json-schema`.');
out();
out('### Repeated configurations: variance and how often they slip');
out();
if (!repeated.length) out('No configuration has two runs yet.');
else {
  out('Total time is the configuration\'s own pipeline (current: intro beside the inventory; the rest: inventory then the three others). Accuracy is per run, in order.');
  out();
  out('| Model | Configuration | Runs | Runs ≥ 47 | Accuracy per run | Median total (s) | Range (s) | Steps visible, median (s) |');
  out('|---|---|---|---|---|---|---|---|');
  for (const g of repeated) out(`| ${g.model} | ${g.label} | ${g.runs} | ${g.reliable} | ${g.accuracy.join(', ')} | ${g.medianTotal ?? '–'} | ${g.range} | ${g.medianSteps ?? '–'} |`);
  out();
  const bad = repeated.flatMap(g => g.bad.map(b => ({ ...b, model: g.model, label: g.label })));
  if (bad.length) {
    out('Runs below 47/49 and what they missed:');
    out();
    const short = (f: string) => (f.length > 140 ? `${f.slice(0, 140)}…` : f);
    for (const b of bad) out(`- ${b.model} ${b.label} #${b.repeat}: ${b.passed}/49. ${b.failed.slice(0, 6).map(short).join('; ')}${b.failed.length > 6 ? `; and ${b.failed.length - 6} more` : ''}`);
    out();
  }
}
const missed = new Map<string, number>();
for (const r of runs) for (const f of (r.kind === 'current' ? r.score.withIntro : r.score.withoutIntro).failed) missed.set(f.replace(/, got .*/, ''), (missed.get(f.replace(/, got .*/, '')) ?? 0) + 1);
if (missed.size) {
  out('### Checks missed most often');
  out();
  for (const [what, n] of [...missed.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) out(`- ${n}× ${what}`);
  out();
}
writeFileSync(join(BENCH_DIR, 'REPORT.md'), lines.join('\n') + '\n');
console.log(`Wrote data/bench/results.json and data/bench/REPORT.md from ${runs.length} runs (${good.length} configurations at ≥ 47/49).`);
