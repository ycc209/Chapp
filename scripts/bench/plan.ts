import type { CallName } from '../../server/ai/import.ts';
import { CALLS, type Kind, type RunConfig } from './core.ts';

/**
 * What the benchmark runs, in priority order: original against current for every model first, then the same-input
 * (text) comparison, then the effort sweeps. The runner goes down the list one configuration at a time and skips
 * what is already in data/bench/runs/, so a plan can be stopped and resumed.
 */

const uniform = (level: string) => Object.fromEntries(CALLS.map(c => [c, level])) as Record<CallName, string>;

type Model = { provider: string; model: string; lowest: string; levels: string[] };

function config(m: Model, kind: Kind, label: string, efforts: Record<CallName, string>, asText: CallName[], repeat = 1): RunConfig {
  return { key: `${m.provider}/${m.model}/${label}#${repeat}`, provider: m.provider, model: m.model, kind, label, repeat, efforts, asText };
}

/** All five calls at medium on the PDF, intro left out of the pipeline: the import before the speed work. */
export const original = (m: Model, repeat = 1) => config(m, 'original', 'original', uniform('medium'), [], repeat);

/** What the app does now (server/ai/import.ts EFFORTS and TEXT_CALLS): the lowest level, the inventory at low, curves and notes on text. */
export const current = (m: Model, repeat = 1) =>
  config(m, 'current', 'current', { intro: m.lowest, inventory: 'low', steps: m.lowest, curves: m.lowest, notes: m.lowest }, ['curves', 'notes'], repeat);

/** All five calls at one level on the PDF; medium is the original run. */
export const sweep = (m: Model, level: string, repeat = 1) => (level === 'medium' ? original(m, repeat) : config(m, 'sweep', `sweep-${level}`, uniform(level), [], repeat));

/** All five calls at one level on the manual's text: the same input the CLI providers without PDF support get. */
export const text = (m: Model, level: string, repeat = 1) => config(m, 'text', `text-${level}`, uniform(level), [...CALLS], repeat);

/** Every call on the text, the inventory at low and the rest at the lowest level: does low on the inventory alone stop the unit slips? */
export const textInventoryLow = (m: Model, repeat = 1) =>
  config(m, 'text', 'text-inventory-low', { intro: m.lowest, inventory: 'low', steps: m.lowest, curves: m.lowest, notes: m.lowest }, [...CALLS], repeat);

const repeats = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

/**
 * A sweep run that asks exactly what an earlier run of the same model asked (same level and input) copies those calls
 * instead of sending them again: the intro and inventory when they match, and the calls after the inventory only when
 * the inventory itself was copied (their prompts carry it).
 */
export function withReuse(cfg: RunConfig, from: RunConfig): RunConfig {
  if (cfg.key === from.key || cfg.model !== from.model || cfg.provider !== from.provider) return cfg;
  const same = (c: CallName) => cfg.efforts[c] === from.efforts[c] && cfg.asText.includes(c) === from.asText.includes(c);
  const calls = CALLS.filter(c => same(c) && (c === 'intro' || c === 'inventory' || same('inventory')));
  return calls.length ? { ...cfg, reuse: { key: from.key, calls } } : cfg;
}

// ─── Meta ────────────────────────────────────────────────────────────────────────────────────────────────────────

const META_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const META: Model[] = [
  // Probed 2026-10-28 with a one-line request: muse-spark-1.3 and muse-wonder-1.0 take minimal…max (default high and
  // max); muse-spark-1.2 takes minimal…xhigh (default high).
  { provider: 'meta', model: 'muse-spark-1.3', lowest: 'minimal', levels: META_LEVELS },
  { provider: 'meta', model: 'muse-wonder-1.0', lowest: 'minimal', levels: META_LEVELS },
  { provider: 'meta', model: 'muse-spark-1.2', lowest: 'minimal', levels: ['minimal', 'high'] },
];

export function metaPlan(): RunConfig[] {
  const [spark, wonder, spark12] = META as [Model, Model, Model];
  return [
    current(spark), original(spark), current(spark, 2), original(spark, 2),
    current(wonder), original(wonder), current(wonder, 2), original(wonder, 2),
    current(spark12), original(spark12),
    text(spark, 'minimal'), text(spark, 'medium'),
    ...spark.levels.filter(l => l !== 'medium').map(l => sweep(spark, l)),
    ...wonder.levels.filter(l => l !== 'medium').map(l => sweep(wonder, l)),
    ...spark12.levels.map(l => sweep(spark12, l)),
    // Repeats asked for after the first pass (2026-10-28): the fast all-minimal reads and the current mix, to see how
    // often each slips on units (µL/mL, µg/mL/mg/mL) before Chapp picks one.
    ...repeats(2, 5).map(n => text(spark, 'minimal', n)),
    ...repeats(2, 3).map(n => sweep(spark, 'minimal', n)),
    ...repeats(3, 4).map(n => current(wonder, n)),
    ...repeats(1, 3).map(n => textInventoryLow(spark, n)),
  ];
}

// ─── Claude and OpenAI through the CLIs on the user's subscriptions ──────────────────────────────────────────────

/**
 * The subscriptions' limits are shared with the user's own work, so: original and current for every model, a second
 * run of both for the flagship only, the full effort ladder on the flagship, and low and high on the rest (medium is
 * the original run). The lowest level the CLIs offer is low, so a sweep at low copies the current run's intro,
 * inventory and steps (the same requests) and sends only curves and notes on the PDF.
 */
function cliPlan(provider: string, models: string[], ladder: string[], extra: (m: Model) => RunConfig[] = () => []): RunConfig[] {
  const ms: Model[] = models.map(model => ({ provider, model, lowest: 'low', levels: ladder }));
  const [flagship, ...rest] = ms as [Model, ...Model[]];
  const low = (m: Model) => withReuse(sweep(m, 'low'), current(m));
  return [
    ...ms.flatMap(m => [current(m), original(m)]),
    current(flagship, 2), original(flagship, 2),
    low(flagship), ...ladder.filter(l => l !== 'low' && l !== 'medium').map(l => sweep(flagship, l)),
    ...rest.flatMap(m => [low(m), sweep(m, 'high'), ...extra(m)]),
  ];
}

const CLAUDE_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'];
const CLAUDE_LADDER = ['low', 'medium', 'high', 'xhigh', 'max'];
/** Claude Sonnet 5.5 can also turn thinking off (between_tools) at low. */
const nothink = (m: Model) => (m.model === 'claude-sonnet-5-5' ? [config(m, 'sweep', 'sweep-low-nothink', uniform('low-nothink'), [])] : []);

/** Codex lists low…max (and "ultra", which delegates to sub-agents: left out). gpt-6-astra is the flagship and the user's default. */
const CODEX_MODELS = ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna'];
const CODEX_LADDER = ['low', 'medium', 'high', 'xhigh', 'max'];

// ─── Claude and OpenAI through their APIs (when ANTHROPIC_API_KEY / OPENAI_API_KEY are set) ──────────────────────

function apiPlan(provider: string, models: { model: string; lowest: string; levels: string[] }[]): RunConfig[] {
  const ms: Model[] = models.map(m => ({ provider, ...m }));
  return [
    ...ms.flatMap(m => [current(m), original(m), current(m, 2), original(m, 2)]),
    ...ms.flatMap(m => m.levels.filter(l => l !== 'medium').map(l => (l === m.lowest ? withReuse(sweep(m, l), current(m)) : sweep(m, l)))),
  ];
}

export const PLANS: Record<string, () => RunConfig[]> = {
  meta: metaPlan,
  codex: () => cliPlan('codex-cli', CODEX_MODELS, CODEX_LADDER),
  claude: () => cliPlan('claude-cli', CLAUDE_MODELS, CLAUDE_LADDER, nothink),
  'anthropic-api': () => apiPlan('anthropic-api', [
    ...CLAUDE_MODELS.map(model => ({ model, lowest: 'low', levels: CLAUDE_LADDER })),
  ]).concat(nothink({ provider: 'anthropic-api', model: 'claude-sonnet-5-5', lowest: 'low', levels: CLAUDE_LADDER })),
  // From developers.openai.com/api/docs/models (2026-10-28): gpt-6-astra and gpt-6.1-sol take low…max; gpt-6.1-terra
  // and gpt-6-luna also take none.
  'openai-api': () => apiPlan('openai-api', [
    { model: 'gpt-6-astra', lowest: 'low', levels: CODEX_LADDER },
    { model: 'gpt-6.1-sol', lowest: 'low', levels: CODEX_LADDER },
    { model: 'gpt-6.1-terra', lowest: 'none', levels: ['none', ...CODEX_LADDER] },
    { model: 'gpt-6-luna', lowest: 'none', levels: ['none', ...CODEX_LADDER] },
  ]),
};
