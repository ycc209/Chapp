import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { outlineAt, useKit } from '../src/screens/kit/store.ts';
import { useRun } from '../src/state/run.ts';

// The kit session (src/screens/kit/store.ts): a matched bottle's crop goes into the run, and a retake drops the match
// and asks for the bottle again, the run keeping the picture it had until a new one replaces it.

const memory = () => {
  const kept = new Map<string, string>();
  return { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) };
};
const box = { x: 0.3, y: 0.2, width: 0.4, height: 0.6 };

beforeEach(() => {
  vi.stubGlobal('sessionStorage', memory());
  vi.stubGlobal('localStorage', memory());
  useKit.getState().clear();
  useRun.setState({ protocolId: 'pierce-bca', photos: {} });
});
afterEach(() => vi.unstubAllGlobals());

describe('outlineAt', () => {
  it('finds SAM’s outline of a box by its place, even for a copy of the box', () => {
    const look = { state: 'read' as const, boxes: [box, { ...box, x: 0.6 }], outlines: [undefined, 'M0,0L1,0L1,1Z'] };
    expect(outlineAt(look, { ...box, x: 0.6 })).toBe('M0,0L1,0L1,1Z');
    expect(outlineAt(look, box)).toBeUndefined();
    expect(outlineAt({ state: 'read', boxes: [box] }, box)).toBeUndefined();
    expect(outlineAt(undefined, box)).toBeUndefined();
  });
});

describe('retake', () => {
  it('drops the match and asks for the bottle again; the run keeps the picture it had', () => {
    useKit.getState().found({ 'reagent-a': { shot: 's1', box, crop: 'data:a', how: 'read' }, 'reagent-b': { shot: 's1', box, crop: 'data:b', how: 'read' } }, [], 'Found 2.');
    expect(useRun.getState().photos).toEqual({ 'reagent-a': 'data:a', 'reagent-b': 'data:b' });

    useKit.getState().retake('reagent-a', 'Take a photo of just the BCA Reagent A.');
    const kit = useKit.getState();
    expect(kit.picks['reagent-a']).toBeUndefined();
    expect(kit.picks['reagent-b']).toBeDefined();
    expect(kit.asking).toBe('reagent-a');
    expect(kit.skipped['reagent-a']).toBe(false);
    expect(kit.said).toBe('Take a photo of just the BCA Reagent A.');
    expect(useRun.getState().photos['reagent-a']).toBe('data:a');

    // The next photo's reading of it is a fresh match, and replaces the run's picture.
    useKit.getState().found({ 'reagent-a': { shot: 's2', box, crop: 'data:a2', how: 'read' } }, [], 'Found 1.');
    expect(useKit.getState().picks['reagent-a']?.crop).toBe('data:a2');
    expect(useRun.getState().photos['reagent-a']).toBe('data:a2');
  });
});
