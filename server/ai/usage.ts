import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { UpstreamError } from './provider.ts';

/**
 * What Chapp spends on Meta's models, worked out from each reply's own `usage`, and the day's cap.
 *
 * Every call logs its tokens, how many of them the API had cached (it caches the longest identical start of a prompt
 * on its own; `prompt_cache_key` keeps calls that share one together), and what the call cost. With CHAPP_DAILY_USD
 * set, a call is refused once the day's spending reaches it, and reading a manual is refused before it starts when
 * the manual's counted tokens would take the day past it.
 *
 * Prices from dev.meta.ai/docs/pricing-rate-limits, read 2026-10-30, in dollars.
 */

type Json = Record<string, any>;

/** Per million tokens: uncached input, cached input, output (reasoning is output). */
const TOKENS: Record<string, { input: number; cached: number; output: number }> = {
  'muse-spark-1.3': { input: 1.25, cached: 0.15, output: 4.25 },
  'muse-spark-1.2': { input: 1.25, cached: 0.15, output: 4.25 },
  'muse-spark-1.1': { input: 1.25, cached: 0.15, output: 4.25 },
  'muse-wonder-1.0': { input: 4, cached: 0.2, output: 20 },
};
/**
 * Per web search the model runs, per image SAM segments, per video frame SAM follows (at least 50 a video), per hour of
 * speech, per image Muse Image draws.
 */
export const PER = { search: 2.5 / 1000, samImage: 2.5 / 1000, samFrame: 0.2 / 1000, speechHour: 0.18, image: 0.01 };

export type Usage = { input: number; cached: number; output: number; reasoning: number };

/** A reply's tokens, from the Responses API's `usage` or Chat Completions'; null when it reports none. */
export function usageOf(body: Json | null | undefined): Usage | null {
  const u = body?.usage;
  if (!u || typeof u !== 'object') return null;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    input: n(u.input_tokens ?? u.prompt_tokens),
    cached: n((u.input_tokens_details ?? u.prompt_tokens_details)?.cached_tokens),
    output: n(u.output_tokens ?? u.completion_tokens),
    reasoning: n((u.output_tokens_details ?? u.completion_tokens_details)?.reasoning_tokens),
  };
}

/** The web searches a Responses reply ran. */
const searchesOf = (body: Json | null | undefined) => (Array.isArray(body?.output) ? body.output.filter((o: Json) => o?.type === 'web_search_call').length : 0);

/** What a model reply cost: its tokens at the model's prices, plus its web searches. */
export function costOf(model: string, body: Json | null | undefined): number {
  const price = TOKENS[model];
  const u = usageOf(body);
  const tokens = price && u ? ((u.input - u.cached) * price.input + u.cached * price.cached + u.output * price.output) / 1e6 : 0;
  return tokens + searchesOf(body) * PER.search;
}

/** What `tokens` of input would cost uncached, for checking a call against the cap before it is made. */
export const inputCost = (model: string, tokens: number) => (tokens * (TOKENS[model]?.input ?? 0)) / 1e6;
/** What `tokens` of output would cost. */
export const outputCost = (model: string, tokens: number) => (tokens * (TOKENS[model]?.output ?? 0)) / 1e6;

const thousands = (n: number) => n.toLocaleString('en-US');

/** "in 7,625 (cached 7,104) · out 2,084 · $0.0091": the line each call logs; '' when the reply reports nothing. */
export function usageLine(model: string, body: Json | null | undefined): string {
  const u = usageOf(body);
  if (!u) return '';
  return `in ${thousands(u.input)}${u.cached ? ` (cached ${thousands(u.cached)})` : ''} · out ${thousands(u.output)} · $${costOf(model, body).toFixed(4)}`;
}

export type Meter = {
  /** Adds a call's cost to today's. */
  spend(dollars: number): void;
  /** Today's spending so far. */
  spent(): number;
  /** The daily cap in dollars; 0 is none. */
  cap(): number;
  setCap(dollars: number): void;
  /** Keeps today's total in `file` (data/, git-ignored), so a restart does not reset it; reads what is there. */
  keepIn(file: string): void;
  /** Throws when today's spending, plus `estimate` for the call about to be made, would pass the cap. */
  check(estimate?: number): void;
  /** Reserve an estimate while concurrent requests are in flight; release exactly once when settled. */
  reserve(estimate: number): () => void;
};

/** The day's spending and its cap. */
export function createMeter(options: { cap?: number; file?: string; now?: () => Date } = {}): Meter {
  const now = options.now ?? (() => new Date());
  const today = () => now().toISOString().slice(0, 10);
  let cap = 0;
  let file: string | undefined;
  let day = today();
  let dollars = 0;
  let reserved = 0;
  const roll = () => {
    if (today() !== day) {
      day = today();
      dollars = 0;
    }
  };
  const meter: Meter = {
    spend(cost) {
      roll();
      if (!(cost > 0)) return;
      dollars += cost;
      if (!file) return;
      try {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify({ day, dollars }));
      } catch {
        // Keeping the total is a convenience: the cap still holds until a restart.
      }
    },
    spent() {
      roll();
      return dollars;
    },
    cap: () => cap,
    setCap(value) {
      cap = Number.isFinite(value) && value > 0 ? value : 0;
    },
    keepIn(path) {
      file = path;
      try {
        const saved = JSON.parse(readFileSync(path, 'utf8'));
        roll();
        if (saved.day === day && typeof saved.dollars === 'number') dollars = Math.max(dollars, saved.dollars);
      } catch {
        // Nothing kept yet.
      }
    },
    check(estimate = 0) {
      roll();
      if (!cap || dollars + reserved + estimate <= cap) return;
      throw new UpstreamError(
        dollars >= cap
          ? `Chapp has used today's allowance for Meta's models ($${cap.toFixed(2)}). It starts again tomorrow.`
          : `That would take Chapp past today's allowance for Meta's models ($${cap.toFixed(2)}): about $${estimate.toFixed(2)} more, with $${(cap - dollars).toFixed(2)} left.`,
      );
    },
    reserve(estimate) {
      const amount = Number.isFinite(estimate) && estimate > 0 ? estimate : 0;
      meter.check(amount);
      reserved += amount;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        reserved = Math.max(0, reserved - amount);
      };
    },
  };
  if (options.cap) meter.setCap(options.cap);
  if (options.file) meter.keepIn(options.file);
  return meter;
}

/** The server's one meter; server/index.ts sets its cap and file from the environment. Tests make their own. */
export const meter = createMeter();
