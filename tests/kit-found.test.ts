import { describe, expect, it } from 'vitest';
import type { Box, ReadLabels } from '../shared/ai.ts';
import { boxAt, labelCrop, padded, SAMPLE, sampleLayout, squareOn } from '../shared/kit.ts';
import { groupLabels, planFound, type Seen } from '../src/screens/kit/found.ts';
import { cantLook, looking, noneFound, offered, recognized, rowDetail, slotsOf, subjectOf, thingTitle, type Need, type Pick, type Thing } from '../src/screens/kit/matching.ts';

// From what the models found to what the kit screen shows (Recognized, Kit, Kit-Filled): groups, matches, the things
// Chapp asks about, the rows, and the boxes and crops behind them. Pure; no browser.

const needs: Need[] = [
  { id: 'a', name: 'BCA Reagent A', kit: true, role: 'reagent' },
  { id: 'b', name: 'BCA Reagent B', kit: true, role: 'reagent' },
  { id: 'bsa', name: 'Albumin Standard', kit: true, role: 'standard' },
  { id: 'dil', name: 'Diluent', kit: false, role: 'diluent' },
];

const box = (x: number, width = 0.1, height = 0.3): Box => ({ x, y: 0.5, width, height });
const label = (match: ReadLabels['labels'][number]['match'], componentId: string | null, looks = 'bottle', text = ''): ReadLabels['labels'][number] => ({ match, componentId, looks, text });
const ids = () => {
  let n = 0;
  return () => `t${n++}`;
};

describe('what the models found', () => {
  // The 23225 product shot as Muse Spark read it: two bottles of Reagent A read, ampules and Reagent B guessed.
  const shot1: Seen[] = [
    { shot: 's1', box: box(0.05, 0.04, 0.16), label: label('guess', 'bsa', 'glass ampule') },
    { shot: 's1', box: box(0.1, 0.04, 0.16), label: label('guess', 'bsa', 'glass ampule') },
    { shot: 's1', box: box(0.46, 0.23, 0.6), label: label('read', 'a', 'tall white bottle', 'Pierce BCA Protein Assay Reagent A') },
    { shot: 's1', box: box(0.57, 0.12, 0.24), label: label('guess', 'b', 'small white bottle') },
    { shot: 's1', box: box(0.69, 0.26, 0.64), label: label('read', 'a', 'tall white bottle', 'Pierce BCA Protein Assay Reagent A') },
  ];

  it('groups the bottles of a photo that are the same component, the biggest as its picture', () => {
    const groups = groupLabels(shot1);
    expect(groups.map(g => [g.match, g.component, g.boxes.length])).toEqual([
      ['guess', 'bsa', 2],
      ['read', 'a', 2],
      ['guess', 'b', 1],
    ]);
    expect(groups[1].box).toEqual(shot1[4].box);
    // Bottles nobody could tell stay apart; labels of other products are left out.
    const odd = groupLabels([
      { shot: 's1', box: box(0.1), label: label('none', null) },
      { shot: 's1', box: box(0.3), label: label('none', null) },
      { shot: 's1', box: box(0.5), label: label('other', null, 'bottle', 'Coomassie Plus') },
    ]);
    expect(odd.map(g => g.match)).toEqual(['none', 'none']);
  });

  it('matches what was read, asks about guesses once each, and names as many unknown bottles as are left', () => {
    const plan = planFound(groupLabels(shot1), needs, { picks: {}, things: [] }, ids());
    expect(Object.keys(plan.picks)).toEqual(['a']);
    expect(plan.picks.a).toMatchObject({ shot: 's1', how: 'read', boxes: [shot1[2].box, shot1[4].box] });
    expect(plan.things.map(t => [t.match, t.component, t.looks])).toEqual([
      ['guess', 'bsa', 'glass ampule'],
      ['guess', 'b', 'small white bottle'],
    ]);

    // A second photo with Reagent B read: its guess is moot; the user's tap stays; one unknown bottle per open row.
    const seen: Seen[] = [
      ...shot1,
      { shot: 's2', box: box(0.4, 0.3, 0.6), label: label('read', 'b', 'small blue bottle', 'Pierce BCA Protein Assay Reagent B') },
      { shot: 's3', box: box(0.1, 0.1, 0.2), label: label('none', null, 'small tube') },
      { shot: 's3', box: box(0.5, 0.2, 0.7), label: label('none', null, 'tall bottle') },
    ];
    const tapped = { shot: 's1', box: box(0), crop: '' };
    const more = planFound(groupLabels(seen), needs, { picks: { a: tapped }, things: [] }, ids());
    expect(Object.keys(more.picks)).toEqual(['b']);
    expect(more.things.map(t => [t.match, t.component, t.looks])).toEqual([
      ['guess', 'bsa', 'glass ampule'],
      ['none', null, 'tall bottle'],
    ]);
    // Read or guessed on several photos: the biggest picture of it.
    const twice = planFound(groupLabels([...shot1, { shot: 's2', box: box(0.2, 0.3, 0.6), label: label('guess', 'bsa', 'glass ampule') }]), needs, { picks: {}, things: [] }, ids());
    expect(twice.things.map(t => [t.component, t.shot])).toEqual([['b', 's1'], ['bsa', 's2']]);
    // Nothing left to find: unknown bottles are not asked about.
    const full = planFound(groupLabels(seen), needs, { picks: { a: tapped, b: tapped, bsa: tapped, dil: tapped }, things: [] }, ids());
    expect(full).toEqual({ picks: {}, things: [] });
  });
});

describe('the questions and rows', () => {
  const crop = 'data:';
  const thing = (id: string, match: Thing['match'], component: string | null, looks: string, shot = 's2'): Thing =>
    ({ id, shot, box: box(0.4), crop, looks, text: '', component, match });
  const read: Pick = { shot: 's1', box: box(0.2), crop, how: 'read' };
  // Recognized.dc.html: A and B read, a small vial that may be the standard, a tall bottle nobody could tell.
  const recognizedState = {
    picks: { a: read, b: read } as Record<string, Pick>,
    skipped: {},
    pending: null,
    asking: null,
    things: [thing('vial', 'guess', 'bsa', 'small vial'), thing('tall', 'none', null, 'tall bottle', 's3')],
  };
  const n = (id: string) => ({ s1: 1, s2: 2, s3: 3 })[id] ?? 0;

  it('asks about the bottle nobody could tell first, then the guess, then where the rest are', () => {
    const s = recognizedState;
    expect(subjectOf(needs, s, false)).toMatchObject({ kind: 'unknown', thing: { id: 'tall' } });
    expect(offered(needs, s).map(x => x.name)).toEqual(['Diluent', 'Albumin Standard']);
    expect(slotsOf(needs, s).get('dil')?.id).toBe('tall');
    const kit = { ...s, picks: { ...s.picks, dil: { ...read, shot: 's3', how: 'picked' as const } }, things: [s.things[0]] };
    expect(subjectOf(needs, kit, false)).toMatchObject({ kind: 'guess', need: { id: 'bsa' } });
    const rest = { ...kit, things: [] };
    expect(subjectOf(needs, rest, false)).toMatchObject({ kind: 'where', need: { id: 'bsa' } });
    // While the models look, Chapp does not ask where things are; a tapped square is asked about at once.
    expect(subjectOf(needs, rest, true)).toBeNull();
    expect(subjectOf(needs, { ...rest, pending: { ...read, component: 'bsa' } }, true)).toMatchObject({ kind: 'pending', need: { id: 'bsa' } });
    // The user can pick which thing to answer.
    expect(subjectOf(needs, { ...s, asking: 'vial' }, false)).toMatchObject({ kind: 'guess', thing: { id: 'vial' } });
  });

  it("says what the designs say under each row's name", () => {
    expect(rowDetail(needs[0], { pick: read }, n)).toBe('Kit · photo 1');
    expect(rowDetail(needs[2], { pick: { ...read, shot: 's2', how: 'confirmed' } }, n)).toBe('Kit · photo 2 · you confirmed');
    expect(rowDetail(needs[3], { pick: { ...read, shot: 's3', how: 'picked' } }, n)).toBe('Photo 3 · you picked it');
    expect(rowDetail(needs[2], { thing: recognizedState.things[0] }, n)).toBe('Photo 2 · maybe the Albumin Standard');
    expect(rowDetail(needs[3], { thing: recognizedState.things[1] }, n)).toBe('Photo 3 · I can’t tell');
    expect(thingTitle({ looks: 'small vial' })).toBe('Small vial');
  });

  it("words Chapp's lines like the designs", () => {
    expect(recognized(4, 3, 2)).toBe('I found 4 things in 3 photos. I’m not sure about 2.');
    expect(recognized(1, 1, 0)).toBe('I found 1 thing in 1 photo.');
    expect(looking(3)).toBe('Looking at your 3 photos…');
    expect(looking(1)).toBe('Looking at your photo…');
    expect(cantLook(4)).toBe('I can’t look at the photos right now. Show me the 4 bottles.');
    expect(noneFound(1, 4)).toBe('I couldn’t find the bottles in this photo. Show me the 4 bottles.');
  });
});

describe('boxes and crops', () => {
  it('cuts a label crop with a margin, 256–768 px on its long side', () => {
    expect(labelCrop({ x: 0.5, y: 0.2, width: 0.25, height: 0.5 }, 1600, 1200)).toEqual({ sx: 760, sy: 180, sw: 480, sh: 720, width: 480, height: 720 });
    const big = labelCrop({ x: 0, y: 0, width: 1, height: 1 }, 1600, 1200);
    expect([big.sw, big.sh, big.width, big.height]).toEqual([1600, 1200, 768, 576]);
    const tiny = labelCrop({ x: 0.5, y: 0.5, width: 0.04, height: 0.16 }, 500, 461);
    expect(Math.max(tiny.width, tiny.height)).toBe(256);
    // At the photo's edge the margin is cut off.
    const edge = padded({ x: 0.95, y: 0, width: 0.05, height: 0.1 }, 0.1);
    expect([edge.x, edge.y, edge.x + edge.width, edge.y + edge.height].map(v => +v.toFixed(3))).toEqual([0.945, 0, 1, 0.11]);
  });

  it('squares a bottle for its thumbnail, inside the photo', () => {
    const sq = squareOn({ x: 0.9, y: 0.1, width: 0.1, height: 0.5 }, 1000, 800);
    expect(sq.width * 1000).toBeCloseTo(sq.height * 800);
    expect(sq.x + sq.width).toBeLessThanOrEqual(1);
    expect(sq.height * 800).toBeCloseTo(460);
    // Never more than the photo's short side.
    expect(squareOn({ x: 0, y: 0, width: 1, height: 1 }, 1000, 800).height).toBe(1);
  });

  it('lays out the sample photos the drawn way: two bottles, then one each, every box on its photo', () => {
    const layout = sampleLayout(['reagent', 'reagent', 'standard', 'diluent']);
    expect(layout.map(p => p.map(b => b.index))).toEqual([[0, 1], [2], [3]]);
    for (const b of layout.flat()) {
      expect(b.box.x).toBeGreaterThanOrEqual(0);
      expect(b.box.y).toBeGreaterThanOrEqual(0);
      expect(b.box.x + b.box.width).toBeLessThanOrEqual(1);
      expect(b.box.y + b.box.height).toBeCloseTo(SAMPLE.base / SAMPLE.height);
    }
    expect(boxAt(layout[0].map(b => b.box), { x: 0.72, y: 0.7 })).toBe(layout[0][1].box);
  });
});
