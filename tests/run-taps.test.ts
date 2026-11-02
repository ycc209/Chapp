import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { leftText } from '../src/state/dock.ts';
import { DOUBLE_TAP_MS, tapReader, type StepTap } from '../src/screens/run/taps.ts';

// Moving through a run's steps by tapping the page (src/screens/run/TapNav.tsx), and the floating run's timer.

describe('a tap on a step’s page', () => {
  let heard: StepTap[];
  let read: ReturnType<typeof tapReader>;
  beforeEach(() => {
    vi.useFakeTimers();
    heard = [];
    read = tapReader(t => heard.push(t));
  });
  afterEach(() => vi.useRealTimers());

  it('is Next on the right, Back on the left, once no second tap follows', () => {
    read(0.8);
    expect(heard).toEqual([]);
    vi.advanceTimersByTime(DOUBLE_TAP_MS);
    read(0.2);
    vi.advanceTimersByTime(DOUBLE_TAP_MS);
    expect(heard).toEqual(['next', 'back']);
  });

  it('is Skip, wherever the two fall, when a second follows in time', () => {
    read(0.9);
    vi.advanceTimersByTime(DOUBLE_TAP_MS - 50);
    read(0.1);
    vi.advanceTimersByTime(DOUBLE_TAP_MS * 2);
    expect(heard).toEqual(['skip']);
  });

  it('does nothing once the screen has gone', () => {
    read(0.7);
    read.cancel();
    vi.advanceTimersByTime(DOUBLE_TAP_MS * 2);
    expect(heard).toEqual([]);
  });
});

describe('the time left on the floating run', () => {
  it('reads as minutes, hours or days', () => {
    expect(leftText(245_000)).toBe('4:05');
    expect(leftText(80 * 60_000)).toBe('1:20 h');
    expect(leftText((2 * 24 + 3) * 3_600_000)).toBe('2 d 3 h');
    expect(leftText(-5)).toBe('0:00');
  });
});
