import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { putCover } from '../src/screens/kit/cover.ts';
import { addedTo, forgetAdded, outlineAt, roundNow, useAdded, useKit } from '../src/screens/kit/store.ts';
import { kitCover, useCovers } from '../src/state/library.ts';
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
  useAdded.setState({ protocolId: null, photos: {}, cover: false });
  useCovers.setState({ covers: {} });
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

describe('a label whose evidence disagrees', () => {
  it('is about the other bottles once one it named is matched, and moot once none is left', () => {
    const crop = 'data:image/jpeg;base64,AAAA';
    const torn = { id: 'torn', shot: 's1', box, crop, looks: 'small bottle', text: 'Reagent B', component: 'reagent-b', candidates: ['reagent-b', 'reagent-a'], match: 'mismatch' as const };
    const guess = { id: 'guess', shot: 's1', box: { ...box, x: 0.6 }, crop, looks: 'large bottle', text: '', component: 'reagent-a', match: 'guess' as const };
    useKit.setState({ sample: true, things: [torn, guess] });
    useKit.getState().answer('guess', 'reagent-a', 'confirmed', '');
    expect(useKit.getState().things).toMatchObject([{ id: 'torn', component: 'reagent-b', candidates: ['reagent-b'] }]);
    useKit.getState().answer('torn', 'reagent-b', 'confirmed', '');
    expect(useKit.getState().things).toEqual([]);
    expect(Object.keys(useKit.getState().picks)).toEqual(['reagent-a', 'reagent-b']);
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

describe('a new kit’s contents', () => {
  it('keep what their labels matched out of the run until the protocol is read, then move it to its bottles', () => {
    useRun.setState({ protocolId: null, photos: {} });
    useKit.getState().setContents([
      { id: 'contents:0', name: 'Insulin', role: 'kit component', kit: true, labels: ['Insulin'] },
      { id: 'contents:1', name: 'Mystery', role: 'kit component', kit: true, labels: ['Mystery'] },
    ]);
    useKit.getState().found(
      { 'contents:0': { shot: 's1', box, crop: 'data:ins', how: 'read' }, 'contents:1': { shot: 's1', box: { ...box, x: 0.6 }, crop: 'data:m', how: 'read' } },
      [{ id: 't1', shot: 's1', box, crop: 'data:g', looks: 'small vial', text: '', component: 'contents:0', match: 'guess' }],
      'Found 2.',
    );
    expect(useRun.getState().photos).toEqual({});

    useRun.setState({ protocolId: '3t3-l1' });
    useKit.getState().adopt({ 'contents:0': 'insulin', 'contents:1': null });
    const kit = useKit.getState();
    expect(Object.keys(kit.picks)).toEqual(['insulin']);
    expect(useRun.getState().photos).toEqual({ insulin: 'data:ins' });
    // One the protocol has no bottle like is asked about; a guess at a content is a guess at its bottle.
    expect(kit.things.map(t => [t.component, t.match, t.crop])).toEqual([['insulin', 'guess', 'data:g'], [null, 'none', 'data:m']]);
    expect(kit.contents).toBeNull();
  });
});

describe('the protocol’s ×', () => {
  it('takes back what this tab’s round added: its photos still in the run, the cover, the round under way', () => {
    useRun.setState({ photos: { bsa: 'data:older' } });
    useKit.getState().addShots([{ id: 's1', src: 'data:s1', width: 10, height: 10 }]);
    useKit.getState().found({ 'reagent-a': { shot: 's1', box, crop: 'data:a', how: 'read' }, 'reagent-b': { shot: 's1', box, crop: 'data:b', how: 'read' } }, [], 'Found 2.');
    putCover('pierce-bca', { src: 'data:cover', box, round: 's1' });
    expect(addedTo(useAdded.getState(), 'pierce-bca', 0)).toBe(true);
    expect(addedTo(useAdded.getState(), 'other-kit', 0)).toBe(false);
    // A later photo of Reagent B, not from this round, stays.
    useRun.getState().setPhoto('reagent-b', 'data:b-later');
    const before = roundNow();

    forgetAdded();
    expect(useRun.getState().photos).toEqual({ bsa: 'data:older', 'reagent-b': 'data:b-later' });
    expect(kitCover('pierce-bca')).toBeUndefined();
    expect(useKit.getState().shots).toEqual([]);
    // Work still under way for the round is for one that is over.
    expect(roundNow()).toBe(before + 1);
    expect(addedTo(useAdded.getState(), 'pierce-bca', 0)).toBe(false);
  });

  it('shows while a round is under way, before anything is matched', () => {
    expect(addedTo(useAdded.getState(), 'pierce-bca', 2)).toBe(true);
    expect(addedTo(useAdded.getState(), null, 2)).toBe(false);
  });
});
