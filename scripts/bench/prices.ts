import type { Usage } from './core.ts';

/**
 * Standard-tier list prices, $ per 1M tokens (checked 2026-10-28). Claude: as given in the brief and the Claude API
 * model notes (cache reads 0.1× input except where listed, cache writes 1.25×). OpenAI: developers.openai.com/api/docs/
 * pricing, short context (≤ 272K input). Meta's Muse models have no public per-token price, so their cost is not
 * computed.
 */
type Price = { input: number; output: number; cachedInput: number; cacheWrite: number };

const claude = (input: number, output: number, cachedInput = input * 0.1): Price => ({ input, output, cachedInput, cacheWrite: input * 1.25 });
const openai = (input: number, cachedInput: number, output: number): Price => ({ input, output, cachedInput, cacheWrite: input });

export const PRICES: Record<string, Price> = {
  'claude-haiku-5-5': claude(0.1, 0.5),
  'claude-sonnet-5-5': claude(2, 10, 0.2),
  'claude-opus-5-5': claude(4, 20, 0.2),
  'claude-fable-5-1': claude(10, 50, 0.25),
  'gpt-6-astra': openai(10, 1, 50),
  'gpt-6.1-sol': openai(2, 0.1, 10),
  'gpt-6.1-terra': openai(1, 0.05, 5),
  'gpt-6-luna': openai(0.1, 0.01, 0.5),
  'gpt-6-sol': openai(2, 0.2, 10),
  'gpt-5.6-sol': openai(4, 0.4, 20),
  'gpt-5.6-terra': openai(2, 0.2, 12),
  'gpt-5.6-luna': openai(0.2, 0.02, 1.2),
};

/** A call's list-price cost; null for a model without a public price (Meta's). */
export function costOf(model: string, u: Usage): number | null {
  const p = PRICES[model];
  if (!p) return null;
  const fresh = Math.max(0, u.input - u.cachedInput - u.cacheWrite);
  return (fresh * p.input + u.cachedInput * p.cachedInput + u.cacheWrite * p.cacheWrite + u.output * p.output) / 1e6;
}
