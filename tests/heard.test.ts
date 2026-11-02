import { describe, expect, it } from 'vitest';
import { afterCommitted, normalizeHeard, sameWords } from '../src/voice/heard.ts';

describe('the same words', () => {
  it('ignores punctuation, spaces and case: a partial transcript and the final one of a turn', () => {
    expect(sameWords('下一步，', '下一步。')).toBe(true);
    expect(sameWords('Next step,', 'next step.')).toBe(true);
    expect(sameWords('好 下一步', '好，下一步')).toBe(true);
    expect(sameWords('下一步', '上一步')).toBe(false);
    expect(normalizeHeard('  我要做 BCA! ')).toBe('我要做bca');
  });

  it('finds what a final transcript says beyond the words already taken as a turn', () => {
    expect(afterCommitted('下一步，', normalizeHeard('下一步'))).toBe('');
    expect(afterCommitted('下一步，開始計時。', normalizeHeard('下一步'))).toBe('開始計時。');
    expect(afterCommitted('Next step, start the timer.', normalizeHeard('next step'))).toBe('start the timer.');
    expect(afterCommitted('上一步。', normalizeHeard('下一步'))).toBeNull();
    expect(afterCommitted('開始計時', '')).toBe('開始計時');
  });
});
