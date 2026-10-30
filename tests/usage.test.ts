import { describe, expect, it } from 'vitest';
import { costOf, createMeter, usageLine, usageOf } from '../server/ai/usage.ts';
import { UpstreamError } from '../server/ai/provider.ts';

// What Chapp spends on Meta's models (server/ai/usage.ts): each reply's own usage at the published prices, the cache
// hits in the log line, and the day's cap. No network.

// The ATP manual's steps call on 2026-10-30, as recorded (data/smoke/import/atp-assay/steps.json).
const steps = { usage: { input_tokens: 8069, input_tokens_details: { cached_tokens: 0 }, output_tokens: 6625, output_tokens_details: { reasoning_tokens: 2608 } } };

describe('usage', () => {
  it('reads the Responses API’s usage and Chat Completions’', () => {
    expect(usageOf(steps)).toEqual({ input: 8069, cached: 0, output: 6625, reasoning: 2608 });
    expect(usageOf({ usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 80 }, completion_tokens: 5 } })).toEqual({ input: 100, cached: 80, output: 5, reasoning: 0 });
    expect(usageOf({})).toBeNull();
  });

  it('prices tokens, cached input at its own rate, and each web search', () => {
    // 8,069 × $1.25 + 6,625 × $4.25 per million.
    expect(costOf('muse-spark-1.3', steps)).toBeCloseTo(0.0382, 4);
    const cached = { usage: { input_tokens: 10_000, input_tokens_details: { cached_tokens: 9_000 }, output_tokens: 0 } };
    expect(costOf('muse-spark-1.3', cached)).toBeCloseTo((1000 * 1.25 + 9000 * 0.15) / 1e6, 8);
    expect(costOf('muse-spark-1.3', { output: [{ type: 'web_search_call' }, { type: 'web_search_call' }, { type: 'message' }] })).toBeCloseTo(0.005, 8);
    expect(costOf('a-model-with-no-price', steps)).toBe(0);
  });

  it('says in the log how much of the input the cache had', () => {
    // 521 × $1.25 + 7,104 × $0.15 + 2,084 × $4.25 per million.
    expect(usageLine('muse-spark-1.3', { usage: { input_tokens: 7625, input_tokens_details: { cached_tokens: 7104 }, output_tokens: 2084 } })).toBe('in 7,625 (cached 7,104) · out 2,084 · $0.0106');
    expect(usageLine('muse-spark-1.3', steps)).toBe('in 8,069 · out 6,625 · $0.0382');
    expect(usageLine('muse-spark-1.3', {})).toBe('');
  });
});

describe('the daily cap', () => {
  it('refuses calls once the day’s spending reaches it, and starts again the next day', () => {
    let now = new Date('2026-10-30T10:00:00Z');
    const meter = createMeter({ cap: 1, now: () => now });
    meter.spend(0.6);
    expect(() => meter.check()).not.toThrow();
    // A read counted at $0.50 would pass it.
    expect(() => meter.check(0.5)).toThrow(/past today's allowance.*\$0\.40 left/);
    meter.spend(0.5);
    expect(() => meter.check()).toThrow(UpstreamError);
    expect(() => meter.check()).toThrow(/used today's allowance/);
    now = new Date('2026-10-31T00:01:00Z');
    expect(meter.spent()).toBe(0);
    expect(() => meter.check()).not.toThrow();
  });

  it('has no cap unless one is set', () => {
    const meter = createMeter();
    meter.spend(1000);
    expect(() => meter.check(1000)).not.toThrow();
    meter.setCap(Number(undefined));
    expect(meter.cap()).toBe(0);
  });
});
