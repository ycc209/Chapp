import { describe, expect, it } from 'vitest';
import { kitReads } from '../src/screens/kit/analysis.ts';
import { BOTTLE_COLOURS, colourOf, foundBottles, kitProgress, labelGroups, trackNames } from '../src/screens/kit/progress.ts';
import type { Look } from '../src/screens/kit/store.ts';

// What the protocol page says Chapp is doing with the kit's photos in the background, and how soon a video's frames
// settle which kit it is.

const shot = (id: string, video = true) => ({ id, src: '', width: 1, height: 1, video });
const look = (state: Look['state']): Look => ({ state, boxes: [] });
const base = { picks: {}, following: null, sample: false } as const;
const kit3 = ['x', 'y', 'z'];

describe('the kit’s progress lines', () => {
  it('are nothing for a round with no photos, or the drawn samples', () => {
    expect(kitProgress({ ...base, shots: [], seen: {} }, kit3)).toMatchObject({ lines: [], busy: false });
    expect(kitProgress({ ...base, shots: [shot('a')], seen: {}, sample: true }, kit3).lines).toEqual([]);
  });

  it('say SAM is following the video, then finding the bottles, then reading the labels, each under way in turn', () => {
    expect(kitProgress({ ...base, shots: [], seen: {}, following: 'video' }, kit3)).toMatchObject({ lines: ['Following the bottles through your video'], busy: true });
    expect(kitProgress({ ...base, shots: [shot('a'), shot('b')], seen: { a: look('found'), b: look('finding') } }, kit3)).toMatchObject({
      lines: ['Followed the bottles through your video', 'Finding the bottles on 2 frames'],
      busy: true,
    });
    expect(kitProgress({ ...base, shots: [shot('a'), shot('b')], seen: { a: look('reading'), b: look('found') } }, kit3)).toMatchObject({
      lines: ['Followed the bottles through your video', 'Found the bottles on 2 frames', 'Reading the labels'],
      busy: true,
    });
  });

  it('say which model does each: SAM finds the bottles, Muse Spark reads them', () => {
    const done = { ...base, shots: [shot('a')], seen: { a: look('read') } };
    expect(kitProgress(done, kit3).by).toEqual(['SAM 3.1', 'SAM 3.1', 'Muse Spark']);
    expect(kitProgress({ ...base, shots: [], seen: {}, following: 'video' }, kit3).by).toEqual(['SAM 3.1']);
  });

  it('end with whether every one of the kit’s own bottles matched, some did, or none did, never how many', () => {
    const done = { ...base, shots: [shot('a'), shot('b')], seen: { a: look('read'), b: look('read') } };
    // The user's own bottle (not in the kit's box or bag) is not one of them.
    expect(kitProgress({ ...done, picks: { x: {}, y: {}, mine: {} } as never }, kit3)).toMatchObject({
      lines: ['Followed the bottles through your video', 'Found the bottles on 2 frames', 'Matched the labels to the kit'],
      busy: false,
    });
    expect(kitProgress({ ...done, picks: { x: {}, y: {}, z: {} } as never }, kit3).lines.at(-1)).toBe('Matched every bottle in the kit');
    expect(kitProgress(done, kit3).lines.at(-1)).toBe('Read the labels, but none matched the kit');
    // Which are the kit's is not known yet (a new kit's manual still being read).
    expect(kitProgress({ ...done, picks: { x: {} } as never }, []).lines.at(-1)).toBe('Matched the labels to the kit');
    expect(kitProgress({ ...base, shots: [shot('a', false)], seen: { a: look('failed') } }, kit3)).toMatchObject({
      lines: ['I couldn’t find any bottles on your photo'],
      busy: false,
    });
  });
});

describe('the names on the bottles followed', () => {
  it('are the kit bottles their labels matched, by the id SAM followed each under', () => {
    const b1 = { x: 0.1, y: 0.2, width: 0.2, height: 0.5 };
    const b2 = { x: 0.5, y: 0.2, width: 0.2, height: 0.5 };
    const kit = {
      seen: { a: { state: 'read' as const, boxes: [b1, b2], ids: [3, 7] } },
      picks: { reagentA: { shot: 'a', box: b2, crop: '' }, bsa: { shot: 'zzz', box: b1, crop: '' } },
    };
    const names = trackNames(kit, [{ id: 'reagentA', name: 'Reagent A' }, { id: 'bsa', name: 'Albumin Standard' }]);
    expect([...names]).toEqual([[7, 'Reagent A']]);
  });
});

describe('the bottles found, for the strip at the end of a video', () => {
  const b1 = { x: 0.1, y: 0.2, width: 0.2, height: 0.5 };
  const b2 = { x: 0.5, y: 0.2, width: 0.2, height: 0.5 };
  const b3 = { x: 0.3, y: 0.1, width: 0.3, height: 0.7 };
  const components = [{ id: 'insulin', name: 'Insulin' }, { id: 'dmso', name: 'DMSO I' }];
  const shots = [shot('a'), shot('b')];

  it('are every bottle on every frame, in order, while the labels are read', () => {
    const found = foundBottles({ shots, seen: { a: { state: 'reading', boxes: [b1, b2] }, b: { state: 'found', boxes: [b3] } }, picks: {}, things: [] }, components);
    expect(found.map(f => [f.key, f.name, f.unsure])).toEqual([['a:0', undefined, false], ['a:1', undefined, false], ['b:0', undefined, false]]);
  });

  it('then the ones named by their labels and the ones Chapp is unsure of; the same bottle again is left out', () => {
    const seen = { a: { state: 'read' as const, boxes: [b1, b2] }, b: { state: 'read' as const, boxes: [b3] } };
    const picks = { insulin: { shot: 'a', box: b1, crop: '' }, dmso: { shot: 'b', box: b3, crop: '' } };
    const things = [{ id: 't', shot: 'a', box: b2, crop: '', looks: 'tall bottle', text: '', component: null, match: 'none' as const }];
    expect(foundBottles({ shots, seen, picks, things }, components).map(f => [f.key, f.name ?? null, f.unsure])).toEqual([['a:0', 'Insulin', false], ['a:1', null, true], ['b:0', 'DMSO I', false]]);
    // Without the thing: the second bottle on a is neither, so it goes (another view of a bottle already named).
    expect(foundBottles({ shots, seen, picks, things: [] }, components).map(f => f.key)).toEqual(['a:0', 'b:0']);
  });
});

describe('which kit a video shows, as its frames are read', () => {
  const known = { found: true, kit: { vendor: 'Thermo Scientific', catalog: '23225', name: 'Pierce BCA Protein Assay Kit' }, protocolId: 'pierce-bca' };
  const other = { found: true, kit: { vendor: 'Thermo Scientific', catalog: '23236', name: 'Coomassie Plus' }, protocolId: null, query: 'Coomassie Plus 23236' };

  it('settles as soon as a frame is a kit Chapp has, without waiting for the rest', async () => {
    const never = new Promise<null>(() => {});
    const got: number[] = [];
    const reads = await kitReads([never, Promise.resolve(known), never], n => got.push(n));
    expect(reads).toEqual([null, known, null]);
    expect(got).toEqual([1]);
  });

  it('settles as soon as a frame reads the kit on its box or bag, so its manual is looked up then', async () => {
    const never = new Promise<null>(() => {});
    const onBag = { ...other, packaging: 'bag' };
    expect(await kitReads([never, Promise.resolve(onBag)])).toEqual([null, onBag]);
  });

  it('otherwise waits for every frame', async () => {
    const reads = await kitReads([Promise.resolve(null), Promise.resolve(other)]);
    expect(reads).toEqual([null, other]);
  });
});

describe('labels on the video', () => {
  const at = (x: number, name?: string, y = 0.5, width = 0.08) => ({ box: { x, y, width, height: 0.3 }, ...(name ? { name } : {}) });

  it('go over bottles side by side with the same name as one, and stand alone for the rest', () => {
    // Five ampules of one standard in a row, a reagent bottle apart from them, then two still being read side by side.
    const groups = labelGroups([at(0.28, 'Albumin Standard'), at(0.1, 'Albumin Standard'), at(0.19, 'Albumin Standard'), at(0.6, 'BCA Reagent A'), at(0.8), at(0.89)]);
    expect(groups.map(g => [g.bottles.length, g.bottles[0]!.name])).toEqual([[3, 'Albumin Standard'], [1, 'BCA Reagent A'], [2, undefined]]);
    expect(groups[0]!.box.x).toBeCloseTo(0.1);
    expect(groups[0]!.box.width).toBeCloseTo(0.26);
    // Side by side with different names, far apart with the same one, or one above the other: each its own.
    expect(labelGroups([at(0.1, 'A'), at(0.19, 'B')])).toHaveLength(2);
    expect(labelGroups([at(0.1, 'A'), at(0.5, 'A')])).toHaveLength(2);
    expect(labelGroups([at(0.1, 'A', 0.1), at(0.19, 'A', 0.6)])).toHaveLength(2);
  });

  it('are coloured by the kit’s bottle, the same one every time', () => {
    const kit = [{ id: 'reagent-a' }, { id: 'reagent-b' }, { id: 'bsa' }];
    expect(colourOf('reagent-b', kit)).toBe(BOTTLE_COLOURS[1]);
    expect(colourOf('reagent-b', kit)).toBe(colourOf('reagent-b', kit));
    expect(new Set(kit.map(c => colourOf(c.id, kit))).size).toBe(3);
  });
});
