import { describe, expect, it, vi } from 'vitest';
import type { Box, FoundProtocol, ProtocolIntro, ReadLabels } from '../shared/ai.ts';
import { api } from '../src/api/client.ts';
import { useKit } from '../src/screens/kit/store.ts';
import { boxAt, labelCrop, padded, SAMPLE, sampleLayout, squareOn } from '../shared/kit.ts';
import { existsSync } from 'node:fs';
import { loadProtocol } from '../server/ai/protocols.ts';
import { labelsInstructions } from '../server/ai/vision.ts';
import { contentsTarget, contentsTargets, groupLabels, labelTargets, planFound, sameBottles, type Seen } from '../src/screens/kit/found.ts';
import { asksAbout, cantLook, following, looking, noneFound, offered, reading, recognized, rowDetail, slotsOf, subjectIs, subjectNeed, subjectOf, takenOf, thingTitle, type Need, type Pick, type Thing } from '../src/screens/kit/matching.ts';
import { followable, frameClock, frameTimes, isVideo, VIDEO_FRAMES, videoType } from '../src/screens/kit/photo.ts';
import { agreed, bestKitRead, kitVotes, labelCalls, otherKitRead, sameKit, tellAsTaken, tellKit } from '../src/screens/kit/analysis.ts';
import { useSession } from '../src/state/session.ts';
import { useRun } from '../src/state/run.ts';

const local = existsSync(new URL('../data/protocols/pierce-bca.json', import.meta.url));

// From what the models found to what the kit screen shows (Recognized, Kit, Kit-Filled): groups, matches, the things
// Chapp asks about, the rows, and the boxes and crops behind them. Pure; no browser.

const needs: Need[] = [
  { id: 'a', name: 'BCA Reagent A', kit: true, role: 'reagent' },
  { id: 'b', name: 'BCA Reagent B', kit: true, role: 'reagent' },
  { id: 'bsa', name: 'Albumin Standard', kit: true, role: 'standard' },
  { id: 'dil', name: 'Diluent', kit: false, role: 'diluent' },
];

const box = (x: number, width = 0.1, height = 0.3): Box => ({ x, y: 0.5, width, height });
const label = (match: ReadLabels['labels'][number]['match'], componentId: string | null, looks = 'bottle', text = '', candidates?: string[]): ReadLabels['labels'][number] => ({ match, componentId, looks, text, volume: '', confidence: 0, ...(candidates ? { candidates } : {}) });
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
    // Bottles nobody could tell stay apart; a label of another product is one of them, never made to fit, its words kept.
    const odd = groupLabels([
      { shot: 's1', box: box(0.1), label: label('none', null) },
      { shot: 's1', box: box(0.3), label: label('none', null) },
      { shot: 's1', box: box(0.5), label: label('other', null, 'bottle', 'Coomassie Plus') },
    ]);
    expect(odd.map(g => [g.match, g.text, g.other ?? false])).toEqual([['none', '', false], ['none', '', false], ['none', 'Coomassie Plus', true]]);
    // Labels whose evidence disagrees stay apart, each with its candidates.
    const torn = groupLabels([
      { shot: 's1', box: box(0.1), label: label('mismatch', 'b', 'small bottle', 'Reagent B', ['b', 'a']) },
      { shot: 's1', box: box(0.3), label: label('mismatch', 'b', 'small bottle', 'Reagent B', ['b', 'a']) },
    ]);
    expect(torn.map(g => [g.match, g.candidates])).toEqual([['mismatch', ['b', 'a']], ['mismatch', ['b', 'a']]]);
  });

  it('asks the user to settle a label whose evidence disagrees, among the bottles not matched yet, once', () => {
    const torn: Seen[] = [
      { shot: 's1', box: box(0.1, 0.2, 0.4), label: label('mismatch', 'b', 'small bottle', 'Reagent B', ['b', 'a']) },
      { shot: 's2', box: box(0.1, 0.1, 0.3), label: label('mismatch', 'b', 'small bottle', 'Reagent B', ['b', 'a']) },
      { shot: 's2', box: box(0.5), label: label('guess', 'b', 'small bottle') },
    ];
    const plan = planFound(groupLabels(torn), needs, { picks: {}, things: [] }, ids());
    // One question for both pictures (the biggest), and no guess at B while it is asked.
    expect(plan.things.map(t => [t.match, t.component, t.candidates, t.shot])).toEqual([['mismatch', 'b', ['b', 'a'], 's1']]);
    // Reagent A already read: the question is whether it is B.
    const read = { shot: 's9', box: box(0), crop: '' };
    expect(planFound(groupLabels(torn), needs, { picks: { a: read }, things: [] }, ids()).things.map(t => [t.match, t.candidates])).toEqual([['mismatch', ['b']]]);
    // Both read: nothing to ask.
    expect(planFound(groupLabels(torn), needs, { picks: { a: read, b: read }, things: [] }, ids()).things).toEqual([]);
  });

  it('asks about a label of another product only while bottles are left to find, after those nobody could tell', () => {
    const seen: Seen[] = [
      { shot: 's1', box: box(0.1, 0.3, 0.6), label: label('other', null, 'tall bottle', 'Coomassie Plus') },
      { shot: 's1', box: box(0.5, 0.1, 0.2), label: label('none', null, 'small tube') },
    ];
    const read = { shot: 's9', box: box(0), crop: '' };
    // Two bottles left: both asked, in photo order.
    expect(planFound(groupLabels(seen), needs, { picks: { a: read, b: read }, things: [] }, ids()).things.map(t => [t.looks, t.text])).toEqual([['tall bottle', 'Coomassie Plus'], ['small tube', '']]);
    // One left: the unread one, though smaller.
    expect(planFound(groupLabels(seen), needs, { picks: { a: read, b: read, bsa: read }, things: [] }, ids()).things.map(t => t.looks)).toEqual(['small tube']);
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

  it('asks to settle a label whose evidence disagrees before a guess, naming every bottle it could be', () => {
    const torn: Thing = { ...thing('torn', 'mismatch', 'b', 'small bottle'), text: 'Reagent B', candidates: ['b', 'a'] };
    const s = { ...recognizedState, picks: {}, things: [recognizedState.things[0]!, torn] };
    const subject = subjectOf(needs, s, false)!;
    expect(subject).toMatchObject({ kind: 'mismatch', thing: { id: 'torn' } });
    expect(subject.kind === 'mismatch' && subject.needs.map(x => x.id)).toEqual(['b', 'a']);
    expect([subjectNeed(subject)?.id, subjectIs(subject, 'a'), subjectIs(subject, 'bsa')]).toEqual(['b', true, false]);
    // Its bottles are being asked about: not offered first, not a row for a bottle nobody could tell.
    expect(offered(needs, s).map(x => x.id)).toEqual(['dil', 'a', 'b', 'bsa']);
    expect(asksAbout(torn, 'a')).toBe(true);
    expect(rowDetail(needs[1], { thing: torn }, n)).toBe('Photo 2 · its label disagrees');
    expect(recognized(4, 2, 2, 1, 1)).toBe('SAM 3.1 found the bottles in 2 photos. Muse Spark read 2 labels. I’m not sure about 1. 1 label names something not in this kit.');
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
    expect(recognized(12, 3, 2, 2)).toBe('SAM 3.1 found the bottles in 3 photos. Muse Spark read 2 labels. I’m not sure about 2.');
    expect(recognized(1, 1, 1, 0)).toBe('SAM 3.1 found the bottle in 1 photo. Muse Spark read 1 label.');
    expect(recognized(3, 1, 0, 3)).toBe('SAM 3.1 found the bottles in 1 photo. I’m not sure about 3.');
    expect(looking(3)).toBe('SAM 3.1 is finding the bottles in your 3 photos…');
    expect(looking(1)).toBe('SAM 3.1 is finding the bottles in your photo…');
    expect(reading(5)).toBe('SAM 3.1 found the bottles. Muse Spark is reading their labels…');
    expect(cantLook(4)).toBe('I can’t look at the photos right now. Show me the 4 bottles.');
    expect(noneFound(1, 4)).toBe('SAM 3.1 couldn’t find the bottles in this photo. Show me the 4 bottles.');
  });

  it('says "your sweep" when every photo is a frame of one sweep of the camera', () => {
    expect(takenOf([{ sweep: true }, { sweep: true }])).toBe('sweep');
    expect(takenOf([{ sweep: true }, {}])).toBe(2);
    expect(takenOf([])).toBe(0);
    expect(looking('sweep')).toBe('SAM 3.1 is finding the bottles in your sweep…');
    expect(recognized(5, 'sweep', 4, 1)).toBe('SAM 3.1 found the bottles in your sweep. Muse Spark read 4 labels. I’m not sure about 1.');
    expect(noneFound('sweep', 5)).toBe('SAM 3.1 couldn’t find the bottles in your sweep. Show me the 5 bottles.');
  });

  it('says "your video" when every photo is a frame picked from a video the user chose', () => {
    expect(takenOf([{ video: true }, { video: true }])).toBe('video');
    expect(takenOf([{ video: true }, { sweep: true }])).toBe(2);
    expect(looking('video')).toBe('SAM 3.1 is finding the bottles in your video…');
    expect(recognized(3, 'video', 3, 0)).toBe('SAM 3.1 found the bottles in your video. Muse Spark read 3 labels.');
    expect(noneFound('video', 4)).toBe('SAM 3.1 couldn’t find the bottles in your video. Show me the 4 bottles.');
    expect(following('sweep')).toBe('SAM 3.1 is following the bottles through your sweep…');
    expect(following('video')).toBe('SAM 3.1 is following the bottles through your video…');
  });
});

describe('which kit a video shows', () => {
  const kit = { vendor: 'Thermo Scientific', catalog: '23236', name: 'Coomassie Plus (Bradford) Assay Kit' };
  const box = { found: true, kit, protocolId: null, query: 'Thermo Scientific Coomassie Plus (Bradford) Assay Kit 23236', packaging: 'box' };
  const bottle = { found: true, kit: { ...kit, name: 'Coomassie Plus Protein Assay Reagent', catalog: '' }, protocolId: null, query: 'Thermo Scientific Coomassie Plus Protein Assay Reagent' };
  const known = { found: true, kit: { vendor: 'Thermo Scientific', catalog: '23225', name: 'Pierce BCA Protein Assay Kit' }, protocolId: 'pierce-bca' };

  it('is the kit most frames vote for, a reading on its box counting twice; its best reading, on the box first', () => {
    expect(bestKitRead([null, bottle, box])).toBe(box);
    // One frame read as a kit Chapp has does not outvote the box and a bottle of another.
    expect(bestKitRead([bottle, box, known])).toBe(box);
    expect(bestKitRead([known, known, box])).toBe(box);
    expect(bestKitRead([known, known, bottle])).toBe(known);
    expect(bestKitRead([bottle])).toBe(bottle);
    expect(bestKitRead([null, { found: false }, { found: true, kit, protocolId: null }])).toBeNull();
    expect(kitVotes([bottle, box, known]).map(v => [v.read, v.votes, v.reads])).toEqual([[box, 3, 2], [known, 1, 1]]);
  });

  it('tells one kit from another by its protocol, its catalog number, or the words that tell kits apart', () => {
    expect(sameKit(box, bottle)).toBe(true);
    expect(sameKit(known, { ...known, kit: { ...known.kit, catalog: '23227' } })).toBe(true);
    expect(sameKit(box, { ...box, kit: { ...kit, catalog: '23263' } })).toBe(false);
    expect(sameKit(bottle, { found: true, kit: { vendor: '', catalog: '', name: 'Pierce BCA Protein Assay Reagent A' }, protocolId: null, query: 'x' })).toBe(false);
    expect(sameKit(known, { found: true, kit: { vendor: '', catalog: '', name: 'Pierce BCA Protein Assay Reagent A' }, protocolId: null, query: 'x' })).toBe(true);
  });

  it('asks which kit it is only when another is read just as surely', () => {
    const otherBox = { ...box, kit: { ...kit, catalog: '23263', name: 'Pierce Rapid Gold BCA Kit' }, query: 'Pierce Rapid Gold BCA Kit 23263' };
    expect(otherKitRead([box, otherBox])).toBe(otherBox);
    expect(otherKitRead([box, otherBox, box])).toBeNull();
    // A box against a bottle's label: the box, without asking.
    expect(otherKitRead([box, known])).toBeNull();
    expect(otherKitRead([box])).toBeNull();
    expect([agreed([box, null]), agreed([box, bottle]), agreed([bottle, bottle]), agreed([box, bottle, otherBox])]).toEqual([false, true, false, false]);
  });

  it('opens the search for the manual of a kit Chapp does not have, and changes nothing when no frame says', () => {
    useRun.setState({ protocolId: null });
    useSession.setState({ exchange: null });
    expect(tellKit([null, { found: false }])).toBe('none');
    expect(useSession.getState().exchange).toBeNull();
    expect(useRun.getState().protocolId).toBeNull();
    useRun.setState({ protocolId: 'pierce-bca', step: 3 });
    expect(tellKit([bottle, box])).toBe('search');
    // The query is what makes the Overview search (an exchange without one is only something said).
    expect(useSession.getState().exchange).toEqual({ ask: `Find the manual for the ${box.query}`, say: '', query: box.query });
    // A new run: the last kit's protocol would have the labels read against the wrong kit while the manual is found.
    expect(useRun.getState().protocolId).toBeNull();
    expect(useRun.getState().step).toBe(0);
  });

  it('makes a kit Chapp has the run’s, and drops a search asked before so the Overview does not run it again', () => {
    useSession.setState({ exchange: { ask: 'Find the manual for the 3T3-L1 kit', say: '', query: '3T3-L1 kit' } });
    expect(tellKit([known])).toBe('known');
    expect(useRun.getState().protocolId).toBe('pierce-bca');
    expect(useSession.getState().exchange).toBeNull();
    // Something said that searches nothing stays.
    useSession.setState({ exchange: { ask: 'Hi', say: 'Hello' } });
    tellKit([known]);
    expect(useSession.getState().exchange).toEqual({ ask: 'Hi', say: 'Hello' });
  });

  it('tells which kit a sweep shows while it is recorded, once two of its frames agree', async () => {
    useRun.setState({ protocolId: null });
    const answers = [known, null, known];
    const read = vi.spyOn(api, 'recognizeKit').mockImplementation(async () => answers.shift() as never);
    const shot = (id: string) => ({ id, src: 'data:image/jpeg;base64,AAAA', width: 1, height: 1, sweep: true });
    const telling = tellAsTaken();
    telling.add(shot('sweep-a'));
    telling.add(shot('sweep-b'));
    await new Promise(r => setTimeout(r, 0));
    expect(useRun.getState().protocolId).toBeNull();
    telling.add(shot('sweep-c'));
    // Told before the sweep is over: the run's protocol is the kit's.
    await vi.waitFor(() => expect(useRun.getState().protocolId).toBe('pierce-bca'));
    expect(await telling.done()).toBe('known');
    expect(read).toHaveBeenCalledTimes(3);
    read.mockRestore();
  });

  it('reads the labels against what the manual says the kit holds as soon as it says, and makes its protocol the run’s once read', async () => {
    const query = 'Cayman 3T3-L1 Differentiation Kit 10009839';
    let done: (found: FoundProtocol) => void = () => {};
    let told: ((intro: ProtocolIntro) => void) | undefined;
    const search = vi.spyOn(api, 'findProtocolLive').mockImplementation((_q, _heard, _signal, onIntro) => {
      told = onIntro;
      return new Promise(resolve => (done = resolve));
    });
    useKit.getState().clear();
    useRun.setState({ protocolId: null });
    expect(tellKit([{ found: true, kit: { vendor: 'Cayman', catalog: '10009839', name: '3T3-L1 Differentiation Kit' }, protocolId: null, query, packaging: 'pouch' }])).toBe('search');
    expect(useKit.getState().contents).toBeNull();

    told!({ contents: [{ name: 'Insulin', amount: '' }, { name: 'DMSO I', amount: '' }] } as ProtocolIntro);
    expect(useKit.getState().contents?.map(c => c.name)).toEqual(['Insulin', 'DMSO I']);
    done({ found: true, protocolId: '3t3-l1-adipocyte-differentiation', progress: [], answer: '', sources: [] });
    await vi.waitFor(() => expect(useRun.getState().protocolId).toBe('3t3-l1-adipocyte-differentiation'));
    search.mockRestore();
  });
});

describe('a new kit’s contents', () => {
  const target = (id: string, name: string, labels: string[] = []) => ({ id, name, role: 'reagent', kit: true, labels });

  it('are what its manual lists, a volume only when the amount is one', () => {
    const contents = contentsTargets([
      { name: 'Insulin', amount: '1 mL' },
      { name: ' ', amount: '' },
      { name: '1000X Differentiation Cocktail', amount: '10 × 1 mL' },
    ]);
    expect(contents).toEqual([
      { id: 'contents:0', name: 'Insulin', role: 'kit component', kit: true, labels: ['Insulin'], volumes: ['1 mL'] },
      { id: 'contents:1', name: '1000X Differentiation Cocktail', role: 'kit component', kit: true, labels: ['1000X Differentiation Cocktail'] },
    ]);
    expect(contentsTarget(contents).needs.map(n => [n.id, n.name, n.kit])).toEqual([['contents:0', 'Insulin', true], ['contents:1', '1000X Differentiation Cocktail', true]]);
  });

  it('become the protocol’s bottles named alike, each once, and nothing for a bottle only half like them', () => {
    const contents = contentsTargets([
      { name: 'Insulin', amount: '' },
      { name: 'Differentiation Cocktail (1000X)', amount: '' },
      { name: 'DMSO I', amount: '' },
      { name: 'Buffer A', amount: '' },
    ]);
    const bottles = [
      target('insulin', 'Insulin', ['Insulin']),
      target('cocktail', '1000X Differentiation Cocktail', ['Differentiation Cocktail']),
      target('dmso-i', 'DMSO I', ['DMSO I', 'DMSO (anhydrous)']),
      target('buffer-b', 'Buffer B'),
      target('dmem', 'DMEM'),
    ];
    expect(sameBottles(contents, bottles)).toEqual({ 'contents:0': 'insulin', 'contents:1': 'cocktail', 'contents:2': 'dmso-i', 'contents:3': null });
    // Two contents like one bottle: the more alike has it.
    expect(sameBottles(contentsTargets([{ name: 'Insulin solution', amount: '' }, { name: 'Insulin', amount: '' }]), bottles)).toEqual({ 'contents:0': null, 'contents:1': 'insulin' });
  });
});

describe('reading labels', () => {
  it.runIf(local)('tells the model and the matching what volumes each bottle comes in', () => {
    const bca = loadProtocol('pierce-bca')!;
    const byId = Object.fromEntries(labelTargets(bca).map(t => [t.id, t.volumes]));
    expect(byId['reagent-a']).toEqual(['500 mL', '100 mL']);
    expect(byId['reagent-b']).toEqual(['25 mL', '2.5 mL']);
    expect(byId.diluent).toBeUndefined();
    expect(labelsInstructions(labelTargets(bca))).toContain('comes as 25 mL or 2.5 mL');
  });

  it('reads a bottle’s views together, the calls about as full as each other', () => {
    expect(labelCalls([['a1', 'a2', 'a3'], ['b1'], ['c1', 'c2']], 4)).toEqual([
      { crops: ['a1', 'a2', 'a3'], views: [3] },
      { crops: ['b1', 'c1', 'c2'], views: [1, 2] },
    ]);
    // Photos alone: twelve to a call, as before.
    expect(labelCalls(Array.from({ length: 14 }, (_, i) => [i])).map(c => c.crops.length)).toEqual([7, 7]);
  });
});

describe('frames from a video', () => {
  it('are spread over it, about one every 2 s, at most 8, neither end a frame', () => {
    expect(frameTimes(12)).toEqual([1, 3, 5, 7, 9, 11]);
    expect(frameTimes(1)).toEqual([0.5]);
    const long = frameTimes(120);
    expect(long).toHaveLength(VIDEO_FRAMES);
    expect(long[0]).toBe(7.5);
    expect(long.at(-1)).toBe(112.5);
    // A video whose length the browser cannot tell: its first frame.
    expect(frameTimes(Number.NaN)).toEqual([0]);
    expect(frameTimes(Infinity)).toEqual([0]);
  });

  it('are numbered as SAM numbers them, by when each starts as the video says, else spread evenly over it', () => {
    // A recording whose frames come unevenly: the frame on screen is the last one started, a frame is sought at its middle.
    const uneven = frameClock(1, [0, 0.03, 0.1, 0.5, 0.52]);
    expect([0, 0.029, 0.03, 0.2, 0.499, 0.5, 0.9, 5].map(t => uneven.frameAt(t))).toEqual([0, 1, 1, 2, 3, 3, 4, 4]);
    expect(uneven.timeOf(2)).toBeCloseTo(0.3);
    expect(uneven.frameAt(uneven.timeOf(3))).toBe(3);
    // The last frame runs to about one frame's length past its start, within the video's length.
    expect(uneven.timeOf(4)).toBeGreaterThan(0.52);
    expect(uneven.timeOf(4)).toBeLessThan(0.7);
    // Without its times: SAM's count of frames over the video's length; before SAM has counted them, 30 a second.
    const counted = frameClock(8, null, 240);
    expect([counted.frameAt(0), counted.frameAt(4), counted.frameAt(7.99), counted.frameAt(9)]).toEqual([0, 120, 239, 239]);
    expect(counted.timeOf(120)).toBeCloseTo(4.0167, 3);
    const guessed = frameClock(10);
    expect([guessed.frameAt(1), guessed.frameAt(20)]).toEqual([30, 299]);
    expect(frameClock(Number.NaN).frameAt(3)).toBe(0);
  });

  it('come from a video by its type, or a phone’s .mov without one', () => {
    expect(isVideo(new File([], 'kit.mov', { type: 'video/quicktime' }))).toBe(true);
    expect(isVideo(new File([], 'IMG_0042.MOV'))).toBe(true);
    expect(isVideo(new File([], 'kit.jpg', { type: 'image/jpeg' }))).toBe(false);
  });

  it('go to SAM to follow when the video is an MP4 or a MOV of 20 s or less', () => {
    const mov = new File([new Uint8Array(1000)], 'IMG_0042.MOV');
    expect(videoType(mov)).toBe('video/quicktime');
    expect(videoType(new Blob([], { type: 'video/mp4;codecs=avc1' }))).toBe('video/mp4');
    expect(followable(mov, 12)).toBe(true);
    expect(followable(mov, 45)).toBe(false);
    expect(followable(mov, Number.NaN)).toBe(false);
    expect(followable(new File([], 'kit.webm', { type: 'video/webm' }), 5)).toBe(true);
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
