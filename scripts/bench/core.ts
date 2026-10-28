/**
 * The provider-neutral part of the import benchmark: the five calls of server/ai/import.ts with its own prompts,
 * schemas, assembly and the BCA check, one call at a time, so every provider gets the same work and each call is timed
 * alone. Adapters (scripts/bench/adapters/) only send one call and say what came back.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  CURVES, CURVES_TASK, INTRO, INTRO_TASK, INVENTORY, INVENTORY_TASK, NOTES, NOTES_TASK, RULES, STEPS, STEPS_TASK,
  assemble, countPages, formatOf, inventoryBrief, manualText, readWire, renameLegacy,
  type CallName, type Curves, type Intro, type Inventory, type Notes, type Spec, type Steps,
} from '../../server/ai/import.ts';
import { compareProtocols } from '../../server/ai/import-check.ts';
import { Protocol } from '../../shared/protocol.ts';

type Json = Record<string, any>;

export const CALLS: readonly CallName[] = ['intro', 'inventory', 'steps', 'curves', 'notes'];
export const SPECS: Record<CallName, Spec> = { intro: INTRO, inventory: INVENTORY, steps: STEPS, curves: CURVES, notes: NOTES };
export const schemaName = (call: CallName) => `Chapp${call[0]!.toUpperCase()}${call.slice(1)}`;
/** The strict schema of one call, exactly as server/ai/import.ts sends it to Meta. */
export const schemaOf = (call: CallName): Json => formatOf(schemaName(call), SPECS[call]).schema;

/**
 * How the unit enums go over the wire in the import this process loaded: with the micro sign ("µL", "µg/mL", before
 * 2026-10-28 ~12:15) or in ASCII ("uL", "ug/mL", read back as µ). Each run records it.
 */
export type SchemaUnits = 'micro-sign' | 'ascii';
export const schemaUnits = (): SchemaUnits => (JSON.stringify(schemaOf('inventory')).includes('"uL"') ? 'ascii' : 'micro-sign');
export const SYSTEM = RULES;

export const ROOT = new URL('../../', import.meta.url).pathname;
export const BENCH_DIR = join(ROOT, 'data/bench');

// ─── The manual ──────────────────────────────────────────────────────────────────────────────────────────────────

export type Manual = {
  path: string;
  filename: string;
  pdf: Uint8Array;
  base64: string;
  /** pdftotext -layout, page by page, as server/ai/import.ts manualText gives it. */
  text: string;
  sha256: string;
  pages: number | null;
};

export function loadManual(path: string): Manual {
  const pdf = new Uint8Array(readFileSync(path));
  const text = manualText(pdf);
  if (!text) throw new Error(`pdftotext could not read ${path}`);
  return {
    path,
    filename: basename(path).replace(/[^\w.-]+/g, '_'),
    pdf,
    base64: Buffer.from(pdf).toString('base64'),
    text,
    sha256: createHash('sha256').update(pdf).digest('hex'),
    pages: countPages(pdf),
  };
}

/** The text block a text-reading call gets in place of the PDF (server/ai/import.ts, `manual`). */
export const manualTextBlock = (manual: Manual) => `The manual, page by page:\n\n${manual.text}`;

/** The manual's pages as PNGs (pdftoppm), for providers that take images but not PDFs. Cached in data/bench/pages/. */
export function pageImages(manual: Manual, dpi = 100): string[] {
  const dir = join(BENCH_DIR, 'pages', `${manual.sha256.slice(0, 12)}-${dpi}`);
  if (!existsSync(dir) || !readdirSync(dir).some(f => f.endsWith('.png'))) {
    mkdirSync(dir, { recursive: true });
    execFileSync('pdftoppm', ['-png', '-r', String(dpi), manual.path, join(dir, 'page')], { stdio: 'ignore' });
  }
  return readdirSync(dir).filter(f => f.endsWith('.png')).sort().map(f => join(dir, f));
}

// ─── One call ────────────────────────────────────────────────────────────────────────────────────────────────────

/** How a call reads the manual: the PDF itself (or the closest a provider takes), or pdftotext's text. */
export type InputMode = 'pdf' | 'text';

export type CallRequest = {
  call: CallName;
  model: string;
  effort: string;
  input: InputMode;
  system: string;
  task: string;
  schemaName: string;
  /** The strict schema as the import sends it to Meta; adapters translate it (scripts/bench/schema.ts). */
  schema: Json;
};

export type Usage = {
  /** All input tokens, cached ones included. */
  input: number;
  cachedInput: number;
  cacheWrite: number;
  /** All output tokens, reasoning included. */
  output: number;
  /** Reasoning (thinking) tokens when the provider reports them; null when it does not. */
  reasoning: number | null;
};

export type CallStatus = 'ok' | 'error' | 'timeout' | 'refusal' | 'incomplete' | 'bad-json' | 'skipped' | 'reused';

export type CallOutcome = {
  status: CallStatus;
  /** Wall time, from sending to the whole reply (for a CLI: from launching it to its exit). */
  seconds: number;
  /** The model's own time where the provider says (Claude Code duration_api_ms, Codex turn events); else = seconds. */
  apiSeconds: number;
  usage: Usage | null;
  /** The provider's own cost figure (Claude Code total_cost_usd). */
  reportedCostUsd?: number | null;
  /** The parsed JSON reply (before it is read against its spec). */
  json?: unknown;
  error?: string;
  /** Anything else worth keeping: stop reason, turns, how the manual went in, the model that answered. */
  info?: Json;
};

export type CallResult = CallOutcome & {
  call: CallName;
  effort: string;
  input: InputMode;
  /** Cost from the price table (scripts/bench/prices.ts); null where there is no public price. */
  costUsd: number | null;
  /** The raw reply, in data/bench/raw/. */
  raw?: string;
  /** The run this call was copied from, when it was reused. */
  from?: string;
};

export type SendOptions = { timeoutMs: number; rawPath: string };

export interface Adapter {
  /** "meta", "claude-cli", "codex-cli", "anthropic-api", "openai-api". */
  provider: string;
  vendor: 'Meta' | 'Anthropic' | 'OpenAI';
  /** The request as it would go out, with the document elided, for --dry-run. */
  build(req: CallRequest, manual: Manual): unknown;
  send(req: CallRequest, manual: Manual, options: SendOptions): Promise<CallOutcome>;
}

// ─── A run: the five calls ───────────────────────────────────────────────────────────────────────────────────────

/** original: all at medium, PDF; current: the app's mix (lowest, inventory low, curves and notes on text); sweep: all at one level. */
export type Kind = 'original' | 'current' | 'sweep' | 'text';

export type RunConfig = {
  /** Stable id: "<provider>/<model>/<label>#<repeat>". */
  key: string;
  provider: string;
  model: string;
  kind: Kind;
  label: string;
  repeat: number;
  efforts: Record<CallName, string>;
  asText: CallName[];
  /** Calls copied from another run of the same model (identical requests), to spare quota; the rest are sent. */
  reuse?: { key: string; calls: CallName[] };
};

export type Score = { passed: number; total: number; failed: string[]; problems: number; error?: string };

export type Pipeline = {
  /** Original shape: no intro; inventory, then steps, curves and notes side by side. Steps show when all is done. */
  original: { stepsVisible: number | null; total: number | null };
  /** Current shape: intro beside the inventory; steps show when the intro is back. */
  current: { stepsVisible: number | null; total: number | null };
};

export type RunRecord = {
  key: string;
  provider: string;
  vendor: string;
  model: string;
  kind: Kind;
  label: string;
  repeat: number;
  efforts: Record<CallName, string>;
  asText: CallName[];
  /** The unit enums the schemas used (missing in runs saved before this field: those all used the micro sign). */
  schemaUnits?: SchemaUnits;
  /** Where a run came from when the benchmark did not send it itself (scripts/bench/import-smoke.ts). */
  source?: string;
  startedAt: string;
  finishedAt: string;
  status: 'ok' | 'partial' | 'failed';
  calls: Record<CallName, CallResult>;
  /** Pipeline times from the calls' wall times and from their API times (both the same for Meta). */
  pipeline: { wall: Pipeline; api: Pipeline };
  /** The 49 BCA checks, assembled without the intro (original shape) and with it (current shape). */
  score: { withoutIntro: Score; withIntro: Score };
  tokens: { input: number; cachedInput: number; output: number; reasoning: number | null };
  costUsd: number | null;
  reportedCostUsd: number | null;
  notes: string[];
};

const r1 = (n: number) => Math.round(n * 10) / 10;

/** Pipeline times from per-call seconds; null when a call it needs failed. */
export function pipelineOf(seconds: Partial<Record<CallName, number | null>>): Pipeline {
  const s = (c: CallName) => seconds[c] ?? null;
  const deep = [s('steps'), s('curves'), s('notes')];
  const deepMax = deep.every(x => x !== null) ? Math.max(...(deep as number[])) : null;
  const inv = s('inventory');
  const intro = s('intro');
  const original = inv !== null && deepMax !== null ? r1(inv + deepMax) : null;
  const current = inv !== null && deepMax !== null && intro !== null ? r1(Math.max(intro, inv) + deepMax) : null;
  return { original: { stepsVisible: original, total: original }, current: { stepsVisible: intro === null ? null : r1(intro), total: current } };
}

const empty = <S extends Spec>(spec: S) => readWire(spec, {});

export function scoreParts(
  parts: { inventory: Inventory | null; steps: Steps | null; curves: Curves | null; notes: Notes | null; intro: Intro | null },
  manual: Manual,
  gold: Protocol,
): Score {
  const total = compareProtocols(gold, gold).length;
  if (!parts.inventory) return { passed: 0, total, failed: ['no inventory'], problems: 0, error: 'no inventory' };
  try {
    const { protocol, problems } = assemble(
      { inventory: parts.inventory, steps: parts.steps ?? empty(STEPS), curves: parts.curves ?? empty(CURVES), notes: parts.notes ?? empty(NOTES), intro: parts.intro },
      { sha256: manual.sha256, pages: manual.pages, url: gold.source.url, fetchedAt: new Date().toISOString(), seconds: 0 },
    );
    const checks = compareProtocols(gold, protocol);
    // A missing dilution table is one failed check instead of one per vial, so the count can drop below 49: score
    // against the gold's own 49, with the vials of a missing table counted as missed.
    return { passed: checks.filter(c => c.ok).length, total: Math.max(total, checks.length), failed: checks.filter(c => !c.ok).map(c => `${c.what}: expected ${c.expected}, got ${c.got}`), problems: problems.length };
  } catch (error) {
    return { passed: 0, total, failed: ['did not assemble'], problems: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

export const runFile = (key: string) => join(BENCH_DIR, 'runs', `${key.replace(/[/#]/g, '__')}.json`);
export const readRun = (key: string): RunRecord | null => (existsSync(runFile(key)) ? JSON.parse(readFileSync(runFile(key), 'utf8')) : null);

export function requestFor(cfg: RunConfig, call: CallName, inventory: Inventory | null): CallRequest {
  const brief = inventory ? `\n\nThe inventory:\n${inventoryBrief(inventory)}` : '';
  const task = {
    intro: INTRO_TASK,
    inventory: INVENTORY_TASK,
    steps: STEPS_TASK + brief,
    curves: CURVES_TASK + `\n\nThe standard curves:\n${JSON.stringify((inventory?.curves ?? []).map(c => ({ id: c.id, name: c.name })))}`,
    notes: NOTES_TASK + brief,
  }[call];
  return {
    call,
    model: cfg.model,
    effort: cfg.efforts[call],
    input: cfg.asText.includes(call) ? 'text' : 'pdf',
    system: SYSTEM,
    task,
    schemaName: schemaName(call),
    schema: schemaOf(call),
  };
}

export type RunOptions = {
  manual: Manual;
  gold: Protocol;
  timeoutMs: number;
  prices: (model: string, usage: Usage) => number | null;
  log: (line: string) => void;
};

/** Runs one configuration's five calls in order (intro, inventory, steps, curves, notes), one at a time, and scores it. */
export async function runConfig(cfg: RunConfig, adapter: Adapter, o: RunOptions): Promise<RunRecord> {
  const startedAt = new Date().toISOString();
  const rawDir = join(BENCH_DIR, 'raw', cfg.key.replace(/[/#]/g, '__'));
  mkdirSync(rawDir, { recursive: true });
  const base = cfg.reuse ? readRun(cfg.reuse.key) : null;
  if (cfg.reuse && !base) throw new Error(`${cfg.key} reuses ${cfg.reuse.key}, which has not run yet`);
  const notes: string[] = [];
  const calls = {} as Record<CallName, CallResult>;
  const wire: { intro: Intro | null; inventory: Inventory | null; steps: Steps | null; curves: Curves | null; notes: Notes | null } = {
    intro: null, inventory: null, steps: null, curves: null, notes: null,
  };

  for (const call of CALLS) {
    const req = requestFor(cfg, call, wire.inventory);
    let result: CallResult;
    if (base && cfg.reuse!.calls.includes(call)) {
      result = { ...base.calls[call], status: base.calls[call].status === 'ok' ? 'reused' : base.calls[call].status, from: base.key };
    } else if (call !== 'intro' && call !== 'inventory' && !wire.inventory) {
      result = { call, effort: req.effort, input: req.input, status: 'skipped', seconds: 0, apiSeconds: 0, usage: null, costUsd: null, error: 'no inventory' };
    } else if (call === 'curves' && !wire.inventory!.curves.length) {
      // As server/ai/import.ts: no standard curve, no curves call.
      result = { call, effort: req.effort, input: req.input, status: 'skipped', seconds: 0, apiSeconds: 0, usage: null, costUsd: null, error: 'no curves in the inventory', json: { points: [] } };
    } else {
      const rawPath = join(rawDir, `${call}.json`);
      let outcome: CallOutcome;
      try {
        outcome = await adapter.send(req, o.manual, { timeoutMs: o.timeoutMs, rawPath });
      } catch (error) {
        outcome = { status: 'error', seconds: 0, apiSeconds: 0, usage: null, error: error instanceof Error ? error.message : String(error) };
      }
      result = { ...outcome, call, effort: req.effort, input: req.input, costUsd: outcome.usage ? o.prices(cfg.model, outcome.usage) : null, raw: existsSync(rawPath) ? rawPath.slice(ROOT.length) : undefined };
      if (result.status === 'ok' && result.json === undefined) result.status = 'bad-json';
    }
    calls[call] = result;
    const usable = (result.status === 'ok' || result.status === 'reused' || result.status === 'skipped') && result.json !== undefined;
    if (usable) {
      const value = readWire(SPECS[call], renameLegacy(call, result.json));
      (wire as Json)[call] = value;
    }
    const u = result.usage;
    o.log(`  ${call.padEnd(9)} ${result.effort.padEnd(7)} ${result.input.padEnd(4)} ${result.status.padEnd(8)} ${result.seconds.toFixed(1).padStart(6)} s` +
      (result.apiSeconds !== result.seconds ? ` (api ${result.apiSeconds.toFixed(1)} s)` : '') +
      (u ? `  in ${u.input} (cached ${u.cachedInput}) out ${u.output} (reasoning ${u.reasoning ?? '?'})` : '') +
      (result.costUsd !== null ? `  $${result.costUsd.toFixed(4)}` : '') +
      (result.error ? `  ${result.error.slice(0, 160)}` : ''));
  }

  const ok = (c: CallName) => ['ok', 'reused', 'skipped'].includes(calls[c].status);
  const secs = (pick: 'seconds' | 'apiSeconds') => Object.fromEntries(CALLS.map(c => [c, ok(c) ? calls[c][pick] : null]));
  const withIntro = scoreParts(wire, o.manual, o.gold);
  const withoutIntro = scoreParts({ ...wire, intro: null }, o.manual, o.gold);
  const sum = (f: (r: CallResult) => number | null | undefined) => {
    let total = 0;
    for (const c of CALLS) {
      const v = f(calls[c]);
      if (v === null || v === undefined) return null;
      total += v;
    }
    return total;
  };
  const used = CALLS.map(c => calls[c]).filter(r => r.usage);
  const failedCalls = CALLS.filter(c => !ok(c));
  if (failedCalls.length) notes.push(`failed: ${failedCalls.map(c => `${c} (${calls[c].status}${calls[c].error ? `: ${calls[c].error!.slice(0, 120)}` : ''})`).join('; ')}`);
  return {
    key: cfg.key,
    provider: cfg.provider,
    vendor: adapter.vendor,
    model: cfg.model,
    kind: cfg.kind,
    label: cfg.label,
    repeat: cfg.repeat,
    efforts: cfg.efforts,
    asText: cfg.asText,
    schemaUnits: schemaUnits(),
    startedAt,
    finishedAt: new Date().toISOString(),
    status: failedCalls.length === 0 ? 'ok' : ok('inventory') && ok('steps') ? 'partial' : 'failed',
    calls,
    pipeline: { wall: pipelineOf(secs('seconds')), api: pipelineOf(secs('apiSeconds')) },
    score: { withoutIntro, withIntro },
    tokens: {
      input: used.reduce((a, r) => a + r.usage!.input, 0),
      cachedInput: used.reduce((a, r) => a + r.usage!.cachedInput, 0),
      output: used.reduce((a, r) => a + r.usage!.output, 0),
      reasoning: used.every(r => r.usage!.reasoning !== null) ? used.reduce((a, r) => a + (r.usage!.reasoning ?? 0), 0) : null,
    },
    costUsd: sum(r => (r.status === 'skipped' ? 0 : r.costUsd)),
    reportedCostUsd: sum(r => (r.status === 'skipped' ? 0 : r.reportedCostUsd)),
    notes,
  };
}

export function saveRun(run: RunRecord) {
  mkdirSync(join(BENCH_DIR, 'runs'), { recursive: true });
  writeFileSync(runFile(run.key), JSON.stringify(run, null, 2));
}

export const loadGold = (path = join(ROOT, 'data/protocols/pierce-bca.json')) => Protocol.parse(JSON.parse(readFileSync(path, 'utf8')));
export const BCA_PDF = join(ROOT, 'data/sources/pierce-bca/MAN0011430_Pierce_BCA_Protein_Asy_UG.pdf');
