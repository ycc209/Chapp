import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AIProvider, FollowedFrame, LabelTarget, Photo, TrackEvent, Video } from '../shared/ai.ts';
import { readEvents } from '../shared/sse.ts';
import { createHandler } from '../server/app.ts';
import { imageType } from '../server/kit.ts';
import { createMockProvider } from '../server/ai/mock.ts';
import { UpstreamError } from '../server/ai/provider.ts';
import { loadProtocol } from '../server/ai/protocols.ts';
import { boxesAt, createKitVision, createMockKitVision, framesToRead, imageSize, millilitres, namedBy, samBoxPrompt, packagingOf, packagingPrompt, parseSamVideo, parseLabels, parseRecognized, parseSam, parseSamRecords, samPointPrompt, tidyBottles, tidyBoxes } from '../server/ai/vision.ts';
import { labelTargets } from '../src/screens/kit/found.ts';

// Kit photos on the server: SAM 3.1's and Muse Spark's real replies (copied from data/smoke/kit/raw/, masks cut
// short), the checks on what a label says, the calls against a fake fetch, and the /api/kit/* routes. No network.

const KEY = 'test-key-never-shown';
const local = existsSync(new URL('../data/protocols/pierce-bca.json', import.meta.url));

/** The BCA run's bottles as the app sends them (labelTargets of data/protocols/pierce-bca.json). */
const targets: LabelTarget[] = [
  { id: 'reagent-a', name: 'BCA Reagent A', role: 'reagent', kit: true, labels: ['BCA Reagent A', 'Reagent A'] },
  { id: 'reagent-b', name: 'BCA Reagent B', role: 'reagent', kit: true, labels: ['BCA Reagent B', 'Reagent B'] },
  { id: 'bsa', name: 'Albumin Standard (BSA)', role: 'standard', kit: true, labels: ['Albumin Standard', 'BSA'] },
  { id: 'diluent', name: 'Diluent (same buffer as your samples)', role: 'diluent', kit: false, labels: [] },
];

/** SAM 3.1 on the 23225 product shot (500 × 461): ten ampules, two bottles of Reagent A, Reagent B. */
const SAM_23225 =
  '<0f>0<|box;x1=215;y1=318;x2=233;y2=391;w=500;h=461|><|mask;x=0;y=0;data=74,19,~!!!%N!O|>,1<|box;x1=23;y1=322;x2=41;y2=400;w=500;h=461|><|mask;x=0;y=0;data=…|>,' +
  '2<|box;x1=188;y1=327;x2=207;y2=405;w=500;h=461|><|mask;x=0;y=0;data=…|>,3<|box;x1=345;y1=98;x2=477;y2=395;w=500;h=461|><|mask;x=0;y=0;data=…|>,' +
  '4<|box;x1=230;y1=333;x2=249;y2=413;w=500;h=461|><|mask;x=0;y=0;data=…|>,5<|box;x1=42;y1=335;x2=62;y2=415;w=500;h=461|><|mask;x=0;y=0;data=…|>,' +
  '6<|box;x1=135;y1=323;x2=154;y2=399;w=500;h=461|><|mask;x=0;y=0;data=…|>,7<|box;x1=96;y1=330;x2=116;y2=409;w=500;h=461|><|mask;x=0;y=0;data=…|>,' +
  '8<|box;x1=66;y1=323;x2=85;y2=400;w=500;h=461|><|mask;x=0;y=0;data=…|>,9<|box;x1=232;y1=90;x2=349;y2=367;w=500;h=461|><|mask;x=0;y=0;data=…|>,' +
  '10<|box;x1=251;y1=322;x2=270;y2=400;w=500;h=461|><|mask;x=0;y=0;data=…|>,11<|box;x1=283;y1=293;x2=341;y2=403;w=500;h=461|><|mask;x=0;y=0;data=…|>';

/** Muse Spark reading the 12 crops of the 23227 shot: the ampules and Reagent B guessed, Reagent A read. */
const LABELS_23227 = JSON.stringify({
  items: [
    ...Array.from({ length: 10 }, (_, i) => ({ component: '', crop: i + 1, guess: 'bsa', looks: 'glass ampule', name: '' })),
    { component: '', crop: 11, guess: 'reagent-b', looks: 'small blue bottle', name: '' },
    { component: 'reagent-a', crop: 12, guess: '', looks: 'large white bottle', name: 'Pierce BCA Protein Assay Reagent A' },
  ],
});

/** SAM 3.1 asked for "box" on the 23225 shot: the kit's box behind the bottles, 0.43 of the photo (the live run's, rounded). */
const SAM_BOX_23225 = '<0f>0<|box;x1=35;y1=60;x2=395;y2=337;w=500;h=461;c=0.92|><|mask;x=0;y=0;c=0.92;data=277,360,~…|>';
/**
 * …and asked for "package" on the same shot with a foil pouch in place of the box (made with Muse Image), where
 * "pouch" found nothing: the pouch, and the two big bottles less surely (the live run's boxes, rounded).
 */
const SAM_PACKAGE_POUCH =
  '<0f>0<|box;x1=90;y1=100;x2=530;y2=750;w=1000;h=1000;c=0.87|><|mask;x=0;y=0;c=0.87;data=…|>,' +
  '1<|box;x1=690;y1=210;x2=960;y2=860;w=1000;h=1000;c=0.59|><|mask;x=0;y=0;c=0.59;data=…|>,2<|box;x1=470;y1=190;x2=700;y2=800;w=1000;h=1000;c=0.59|><|mask;x=0;y=0;c=0.59;data=…|>';

const RECOGNIZED_23227 = '{"catalog": "23227", "found": true, "name": "Pierce BCA Protein Assay Kit", "read": "Prod # 23227 Pierce BCA Protein Assay Kit Lot # OB18465 Thermo", "vendor": "Thermo Scientific"}';
const RECOGNIZED_BOTTLE = '{"catalog":"","found":true,"name":"Pierce BCA Protein Assay","read":"Prod # 23228 Pierce BCA Protein Assay Reagent A 500 ml Thermo Scientific","vendor":"Thermo Scientific"}';

const jpeg: Photo = { type: 'image/jpeg', data: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]) };
/** The same JPEG with its frame header: 500 × 461 pixels, as the 23225 shot. */
const sized: Photo = { type: 'image/jpeg', data: new Uint8Array([...jpeg.data, 0xff, 0xc0, 0, 11, 8, 0x01, 0xcd, 0x01, 0xf4, 1, 1, 0x11, 0, 0xff, 0xd9]) };

describe('SAM 3.1 boxes', () => {
  it('reads every box of the real reply as fractions of the photo', () => {
    const boxes = parseSam(SAM_23225);
    expect(boxes).toHaveLength(12);
    expect(boxes[0].x).toBeCloseTo(215 / 500);
    expect(boxes[0].y).toBeCloseTo(318 / 461);
    expect(boxes[0].width).toBeCloseTo(18 / 500);
    expect(boxes[0].height).toBeCloseTo(73 / 461);
    expect(parseSam('')).toEqual([]);
    // Each box's mask comes with it: the raster's height and width (the box's), how it is coded, and its payload.
    const [first] = parseSamRecords(SAM_23225);
    expect(first!.mask).toEqual({ encoding: 'lossless', height: 74, width: 19, payload: '!!!%N!O', left: 215, top: 318, frameWidth: 500, frameHeight: 461 });
    expect(parseSamRecords('<|box;x1=1;y1=1;x2=3;y2=3;w=10;h=10|><|mask;x=0;y=0;data=3,3,!(QO|>')[0]!.mask).toMatchObject({ encoding: 'one_bit', payload: '(QO' });
    expect(parseSamRecords('<|box;x1=1;y1=1;x2=3;y2=3;w=10;h=10|>')[0]!.mask).toBeUndefined();
    // Tidying keeps each box's mask with it (only the first record of the sample has its payload in full).
    expect(tidyBottles(parseSamRecords(SAM_23225)).find(r => r.mask?.left === 215)?.mask?.payload).toBe('!!!%N!O');
    expect(parseSam('<|box;x1=5;y1=5;x2=5;y2=9;w=10;h=10|><|box;x1=1;y1=1;x2=3;y2=3;w=0;h=10|>')).toEqual([]);
  });

  it('reads fields by key: the id each object came under, the confidence when asked for, and a payload with ">" in it', () => {
    const text = '<0f>1<|box;x1=444;y1=625;x2=679;y2=850;w=1800;h=1200;c=0.9609375|><|mask;x=0;y=0;c=0.9609375;data=226,236,!a>b|c~|>,2<|box;x1=1;y1=1;x2=9;y2=9;w=1800;h=1200|>';
    const [one, two] = parseSamRecords(text);
    expect(one).toMatchObject({ id: 1, score: 0.9609375, mask: { encoding: 'one_bit', height: 226, width: 236, payload: 'a>b|c~', left: 444, top: 625 } });
    expect(one!.box.x).toBeCloseTo(444 / 1800);
    expect(two).toEqual({ id: 2, box: expect.any(Object) });
  });

  it('asks about taps as SAM’s point prompts, in the photo’s own pixels', () => {
    expect(samPointPrompt([{ x: 0.5, y: 0.25 }, { x: 1, y: 0 }], { width: 500, height: 461 })).toBe('<0f>1<|point;x=250;y=115;w=500;h=461|>,2<|point;x=499;y=0;w=500;h=461|>');
  });

  it('reads a photo’s size from its header', () => {
    expect(imageSize(sized.data)).toEqual({ width: 500, height: 461 });
    expect(imageSize(jpeg.data)).toBeNull();
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 3, 0x20, 0, 0, 2, 0x58]);
    expect(imageSize(png)).toEqual({ width: 800, height: 600 });
    expect(imageSize(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it('keeps bottles left to right, drops specks and a box inside a bigger one, and keeps the biggest when there are too many', () => {
    const boxes = tidyBoxes(parseSam(SAM_23225));
    expect(boxes).toHaveLength(12);
    expect(boxes.map(b => b.x)).toEqual([...boxes.map(b => b.x)].sort((a, b) => a - b));
    const bottle = { x: 0.5, y: 0.1, width: 0.3, height: 0.8 };
    const cap = { x: 0.55, y: 0.1, width: 0.2, height: 0.1 };
    const speck = { x: 0.1, y: 0.1, width: 0.01, height: 0.01 };
    expect(tidyBoxes([cap, speck, bottle])).toEqual([bottle]);
    expect(tidyBoxes(parseSam(SAM_23225), 3).map(b => Math.round(b.x * 500))).toEqual([232, 283, 345]);
  });

  it('picks the smallest box under each point', () => {
    const big = { x: 0, y: 0, width: 1, height: 1 };
    const small = { x: 0.4, y: 0.4, width: 0.2, height: 0.2 };
    expect(boxesAt([big, small], [{ x: 0.5, y: 0.5 }, { x: 0.45, y: 0.45 }, { x: 0.1, y: 0.1 }])).toEqual([small, big]);
  });
});

describe('the kit’s packaging on a photo', () => {
  it('is what SAM is surest of among what is big enough to be the kit photographed', () => {
    const box = packagingOf(parseSamRecords(SAM_BOX_23225))!;
    expect(Math.round(box.x * 500)).toBe(35);
    expect(box.width * box.height).toBeCloseTo(0.43, 2);
    // The pouch, not a bottle "package" also caught; surer beats bigger.
    expect(Math.round(packagingOf(parseSamRecords(SAM_PACKAGE_POUCH))!.x * 1000)).toBe(90);
    const wide = { x: 0, y: 0, width: 0.9, height: 0.9 };
    const sure = { x: 0.1, y: 0.1, width: 0.4, height: 0.4 };
    expect(packagingOf([{ box: wide, score: 0.6 }, { box: sure, score: 0.9 }])).toBe(sure);
    // Something small far off on the bench is not the kit; nothing is none.
    const small = { x: 0.8, y: 0.8, width: 0.15, height: 0.15 };
    expect(packagingOf([{ box: small, score: 0.99 }])).toBeNull();
    expect(packagingOf([])).toBeNull();
  });

  it('is asked for by Muse Spark’s word or two, else as "package"', () => {
    expect(packagingPrompt('Bag')).toBe('bag');
    expect(packagingPrompt(' foil  pouch! ')).toBe('foil pouch');
    expect(packagingPrompt('')).toBe('package');
    expect(packagingPrompt('a very long description of a cardboard carton')).toBe('package');
  });
});

describe('a video SAM followed', () => {
  // Frames as SAM writes them: a line each, out of order, the same id for the same bottle on every frame.
  const box = (x1: number, y1: number, x2: number, y2: number) => `<|box;x1=${x1};y1=${y1};x2=${x2};y2=${y2};w=100;h=100|><|mask;x=0;y=0;data=…|>`;
  const reply = [
    `<3f>1${box(10, 20, 30, 90)},2${box(40, 20, 60, 90)}`,
    `<0f>1${box(5, 20, 25, 90)},2${box(35, 20, 55, 90)}`,
    'not a frame',
    `<7f>3${box(60, 10, 95, 95)}`,
  ].join('\n');

  it('reads every bottle on every frame, by the frame and SAM’s id', () => {
    const seen = parseSamVideo(reply);
    expect(seen.map(s => [s.frame, s.id])).toEqual([[3, 1], [3, 2], [0, 1], [0, 2], [7, 3]]);
    expect(parseSamVideo('<4f>2<|box;x1=1;y1=1;x2=50;y2=50;w=100;h=100;c=0.42|>')[0]!.score).toBe(0.42);
    expect(seen[0]!.box.x).toBe(0.1);
    expect(seen[0]!.box.width).toBeCloseTo(0.2);
    expect(seen[0]!.box.height).toBeCloseTo(0.7);
  });

  it('reads each bottle once as its main picture, from few frames, each bottle nearly at its best', () => {
    const at = (frame: number, id: number, x: number, w: number, y = 0.2, h = 0.6) => ({ frame, id, box: { x, y, width: w, height: h } });
    // A and B stand still on frames 0–40, both biggest on 20 (grown about their middles); a flicker; A's cap, followed apart.
    const seen = [
      ...Array.from({ length: 41 }, (_, f) => (f === 20 ? [at(f, 1, 0.09, 0.2), at(f, 2, 0.39, 0.2)] : [at(f, 1, 0.1, 0.18), at(f, 2, 0.4, 0.18)])).flat(),
      at(4, 99, 0.8, 0.1),
      ...[0, 1, 2, 3].map(f => at(f, 7, 0.12, 0.08, 0.2, 0.1)),
    ];
    const picks = framesToRead(seen);
    const mains = picks.flatMap(p => p.bottles.filter(b => b.main).map(b => [p.frame, b.id]));
    expect(mains).toEqual([[20, 1], [20, 2]]);
    // Two more views of each, from other moments, on frames shared where they can be.
    const views = (id: number) => picks.filter(p => p.bottles.some(b => b.id === id)).map(p => p.frame);
    expect(views(1)).toHaveLength(3);
    expect(views(1)).toEqual(views(2));
    for (const [a, b] of [[views(1)[0]!, views(1)[1]!], [views(1)[1]!, views(1)[2]!]]) expect(Math.abs(a - b)).toBeGreaterThanOrEqual(6);
    expect(picks.flatMap(p => p.bottles.map(b => b.id)).filter(id => id === 7 || id === 99)).toEqual([]);
    expect(framesToRead([])).toEqual([]);
  });

  it('takes a still, whole view over a bigger one that is blurred or cut off', () => {
    const at = (frame: number, x: number, w: number, score?: number) => ({ frame, id: 1, box: { x, y: 0.2, width: w, height: 0.6 }, ...(score ? { score } : {}) });
    const seen = [
      // Moving fast and bigger on frames 0–9; still on 10–19; biggest of all on 20–29, but cut off at the left edge.
      ...Array.from({ length: 10 }, (_, f) => at(f, 0.1 + f * 0.05, 0.3)),
      ...Array.from({ length: 10 }, (_, f) => at(10 + f, 0.5, 0.2)),
      ...Array.from({ length: 10 }, (_, f) => at(20 + f, 0, 0.4)),
    ];
    const main = framesToRead(seen).find(p => p.bottles.some(b => b.main))!;
    expect(main.frame).toBeGreaterThanOrEqual(10);
    expect(main.frame).toBeLessThan(20);
    // Something SAM was never sure of is no bottle.
    expect(framesToRead(seen.map(s => ({ ...s, score: 0.3 })))).toEqual([]);
  });
});

describe('labels', () => {
  it('counts a label as read only when the words read name the component', () => {
    const { labels } = parseLabels(LABELS_23227, targets, 12);
    expect(labels.slice(0, 10).every(l => l.match === 'guess' && l.componentId === 'bsa' && l.text === '' && l.looks === 'glass ampule')).toBe(true);
    expect(labels[10]).toEqual({ text: '', looks: 'small blue bottle', componentId: 'reagent-b', match: 'guess' });
    expect(labels[11]).toEqual({ text: 'Pierce BCA Protein Assay Reagent A', looks: 'large white bottle', componentId: 'reagent-a', match: 'read' });
  });

  it('trusts the words over the pick, calls an unbacked pick a guess, and leaves other products out', () => {
    const item = (over: object) => ({ crop: 1, name: '', looks: 'bottle', component: '', guess: '', ...over });
    const one = (over: object) => parseLabels(JSON.stringify({ items: [item(over)] }), targets, 1).labels[0];
    expect(one({ name: 'Pierce BCA Protein Assay Reagent B', component: 'reagent-a' })).toMatchObject({ componentId: 'reagent-b', match: 'read' });
    expect(one({ name: 'Pierce BCA Protein Assay', component: 'reagent-a' })).toMatchObject({ componentId: 'reagent-a', match: 'guess' });
    expect(one({ name: 'PBS', component: 'diluent' })).toMatchObject({ componentId: 'diluent', match: 'guess' });
    expect(one({ name: 'Albumin Standard 2.0 mg/mL', component: 'bsa' })).toMatchObject({ componentId: 'bsa', match: 'read' });
    expect(one({ name: 'Coomassie Plus Protein Assay Reagent' })).toMatchObject({ componentId: null, match: 'other' });
    expect(one({ looks: '' })).toEqual({ text: '', looks: 'bottle', componentId: null, match: 'none' });
    // A crop the model skipped is one nobody could tell.
    expect(parseLabels(JSON.stringify({ items: [item({ crop: 2, name: 'Reagent A', component: 'reagent-a' })] }), targets, 2).labels[0].match).toBe('none');
    expect(() => parseLabels('not json', targets, 1)).toThrow(UpstreamError);
  });

  it('reads a label the photo cuts off when what shows fits one bottle alone and the model picked it', () => {
    // The ATP kit on 2026-10-30: the blue-capped tube turned, its label showing "Converter M".
    const atp: LabelTarget[] = [
      { id: 'converter-mix-b', name: 'Converter Mix B', role: 'reagent', kit: true, labels: ['Converter Mix B', 'Converter Enzyme I', 'ATP Converter'] },
      { id: 'developer-mix-n', name: 'Developer Mix N', role: 'reagent', kit: true, labels: ['Developer Mix N', 'Developer IV', 'Developer Mix'] },
      { id: 'atp-iv', name: 'ATP IV', role: 'standard', kit: true, labels: ['ATP IV', 'ATP Standard II', 'ATP Standard'] },
    ];
    const item = (over: object) => ({ crop: 1, name: '', looks: 'blue capped vial', component: '', guess: '', ...over });
    const one = (over: object) => parseLabels(JSON.stringify({ items: [item(over)] }), atp, 1).labels[0];
    expect(one({ name: 'Converter M', component: 'converter-mix-b' })).toMatchObject({ componentId: 'converter-mix-b', match: 'read' });
    expect(one({ name: 'Converter M', guess: 'converter-mix-b' })).toMatchObject({ componentId: 'converter-mix-b', match: 'read' });
    // Cut on the left too.
    expect(one({ name: 'verter Mix B', component: 'converter-mix-b' })).toMatchObject({ match: 'read' });
    // Words that fit two bottles ("Mix"), only a fragment ("Conv"), or a pick they do not fit: still a guess.
    expect(one({ name: 'Mix', component: 'converter-mix-b' })).toMatchObject({ match: 'guess' });
    expect(one({ name: 'ATP', component: 'atp-iv' })).toMatchObject({ match: 'guess' });
    expect(one({ name: 'Conv', component: 'converter-mix-b' })).toMatchObject({ match: 'guess' });
    expect(one({ name: 'Converter M', component: 'developer-mix-n' })).toMatchObject({ componentId: 'developer-mix-n', match: 'guess' });
  });

  it('reads a bottle by its volume when only one bottle of the run comes in it and the words read are that bottle’s', () => {
    const sized = targets.map(t => ({ ...t, volumes: { 'reagent-a': ['500 mL', '100 mL'], 'reagent-b': ['25 mL', '2.5 mL'], bsa: ['10 mL', '2 mL'] }[t.id] }));
    const reply = (name: string, volume: string, guess = 'reagent-b') => JSON.stringify({ items: [{ crop: 1, bottle: true, name, volume, looks: 'small bottle', component: '', guess }] });
    // Reagent B's label turns its "B" out of sight; its 25 ml shows.
    expect(parseLabels(reply('BCA™ Protein Assay Reagent', '25 ml'), sized, 1).labels[0]).toMatchObject({ componentId: 'reagent-b', match: 'read' });
    // What is printed wins over the pick.
    expect(parseLabels(reply('BCA Protein Assay Reagent', '500 mL'), sized, 1).labels[0]).toMatchObject({ componentId: 'reagent-a', match: 'read' });
    // No volume, a volume none comes in, words of another product, or no volumes known: still a guess.
    expect(parseLabels(reply('BCA Protein Assay Reagent', ''), sized, 1).labels[0]!.match).toBe('guess');
    expect(parseLabels(reply('BCA Protein Assay Reagent', '50 ml'), sized, 1).labels[0]!.match).toBe('guess');
    expect(parseLabels(reply('Coomassie Plus', '25 ml'), sized, 1).labels[0]!.match).toBe('guess');
    expect(parseLabels(reply('BCA Protein Assay Reagent', '25 ml'), targets, 1).labels[0]!.match).toBe('guess');
    expect([millilitres('25 ml'), millilitres('2,5 mL'), millilitres('500μL'), millilitres('1 L'), millilitres('2 mg/ml')]).toEqual([25, 2.5, 0.5, 1000, null]);
  });

  it('leaves out what is not a bottle at all', () => {
    const cloth = JSON.stringify({ items: [{ crop: 1, bottle: false, name: '', looks: 'white fabric', component: '', guess: '' }] });
    expect(parseLabels(cloth, targets, 1).labels[0]).toEqual({ text: '', looks: 'white fabric', componentId: null, match: 'other', bottle: false });
  });

  it('matches label words whole', () => {
    expect(namedBy('Pierce® BCA™ Protein Assay Reagent A, 500 ml', targets).map(t => t.id)).toEqual(['reagent-a']);
    expect(namedBy('Reagent AB', targets)).toEqual([]);
    expect(namedBy('', targets)).toEqual([]);
  });
});

describe('the kit box', () => {
  it.runIf(local)('opens the protocol this machine has for the catalog number read', () => {
    expect(parseRecognized(RECOGNIZED_23227)).toEqual({
      found: true,
      kit: { vendor: 'Thermo Scientific', catalog: '23227', name: 'Pierce BCA Protein Assay Kit' },
      protocolId: 'pierce-bca',
    });
  });

  it('otherwise says what to look the kit up by', () => {
    expect(parseRecognized(RECOGNIZED_BOTTLE)).toMatchObject({ found: true, protocolId: null, query: 'Thermo Scientific Pierce BCA Protein Assay' });
    expect(parseRecognized('{"found":true,"vendor":"Example Bio","name":"Glow Assay Kit","catalog":"Cat. EX123","read":""}')).toMatchObject({
      kit: { catalog: 'EX123' },
      protocolId: null,
      query: 'Example Bio Glow Assay Kit EX123',
    });
    expect(parseRecognized('{"found":false,"vendor":"","name":"","catalog":"","read":""}')).toEqual({ found: false });
    expect(parseRecognized('{"found":true,"vendor":"Thermo","name":"","catalog":"23225","read":""}')).toEqual({ found: false });
    expect(() => parseRecognized(undefined)).toThrow(UpstreamError);
  });

  it('says what packaging the name was read on, and nothing when it was read on a bottle’s label', () => {
    const pouch = parseRecognized('{"found":true,"vendor":"Thermo Scientific","name":"Pierce BCA Protein Assay Kit","catalog":"23225","packaging":"Pouch","read":""}');
    expect(pouch.packaging).toBe('pouch');
    expect(parseRecognized(RECOGNIZED_BOTTLE).packaging).toBeUndefined();
    expect(parseRecognized('{"found":true,"vendor":"Thermo Scientific","name":"Pierce BCA Protein Assay","catalog":"","packaging":"","read":""}').packaging).toBeUndefined();
  });
});

type Call = { url: string; body: any };
function fakeFetch(...answers: (unknown | { status: number; body: unknown } | Error)[]) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    const next = answers.shift();
    if (next instanceof Error) throw next;
    const wrapped = next && typeof next === 'object' && typeof (next as { status?: unknown }).status === 'number';
    const { status, body } = wrapped ? (next as { status: number; body: unknown }) : { status: 200, body: next };
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const vision = (fetch: typeof globalThis.fetch, timeouts = {}) => createKitVision({ apiKey: KEY, fetch, log: () => {}, timeouts });
const chat = (content: string) => ({ choices: [{ message: { role: 'assistant', content } }] });

describe('meta kit vision', () => {
  it('sends the photo to SAM 3.1 with "bottle" and returns its tidied boxes', async () => {
    const { fn, calls } = fakeFetch({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: SAM_23225 }] }] });
    const found = await vision(fn).segmentBottles(jpeg);
    expect(found.bottles).toHaveLength(12);
    expect(calls[0].url).toBe('https://api.meta.ai/v1/responses');
    expect(calls[0].body.model).toBe('sam-3.1');
    expect(calls[0].body.input[0].content[0]).toEqual({ type: 'input_text', text: 'bottle' });
    expect(calls[0].body.input[0].content[1].image_url).toMatch(/^data:image\/jpeg;base64,\/9j\//);
  });

  it('sends a tap to SAM as a point prompt and returns what it outlines there, with how sure it is', async () => {
    const reply = '<0f>1<|box;x1=345;y1=98;x2=477;y2=395;w=500;h=461;c=0.91|><|mask;x=0;y=0;c=0.91;data=…|>';
    const { fn, calls } = fakeFetch({ output: [{ type: 'message', content: [{ type: 'output_text', text: reply }] }] });
    const found = await vision(fn).segmentBottles(sized, [{ x: 0.82, y: 0.5 }]);
    expect(calls[0].body.input[0].content[0]).toEqual({ type: 'input_text', text: '<0f>1<|point;x=410;y=231;w=500;h=461|>' });
    expect(calls[0].body.metadata).toEqual({ include_confidence: 'true' });
    expect(found.bottles).toEqual([{ box: expect.any(Object), score: 0.91, id: 1 }]);
    expect(Math.round(found.bottles[0]!.box.x * 500)).toBe(345);
    // A tap on nothing: nothing.
    const none = fakeFetch({ output: [] });
    expect((await vision(none.fn).segmentBottles(sized, [{ x: 0.1, y: 0.1 }])).bottles).toEqual([]);
  });

  it('outlines bottles known to be there within their boxes, a box prompt each, by the photo’s own pixels', async () => {
    expect(samBoxPrompt([{ x: 0.23, y: 0.28, width: 0.35, height: 0.36 }], { width: 900, height: 1600 })).toBe('<0f>1<|box;x1=207;y1=448;x2=522;y2=1024;w=900;h=1600|>');
    const reply = '<0f>1<|box;x1=345;y1=98;x2=477;y2=395;w=500;h=461;c=0.99|><|mask;x=0;y=0;c=0.99;data=…|>';
    const { fn, calls } = fakeFetch({ output: [{ type: 'message', content: [{ type: 'output_text', text: reply }] }] });
    const found = await vision(fn).segmentBottles(sized, undefined, undefined, [{ x: 0.69, y: 0.21, width: 0.26, height: 0.65 }]);
    expect(calls[0].body.input[0].content[0].text).toMatch(/^<0f>1<\|box;x1=345;y1=97;x2=475;y2=396;w=500;h=461\|>$/);
    expect(found.bottles).toEqual([{ box: expect.any(Object), score: 0.99, id: 1 }]);
  });

  it('keeps only the bottles under the points asked about when the photo’s size cannot be read', async () => {
    const { fn } = fakeFetch({ output: [{ type: 'message', content: [{ type: 'output_text', text: SAM_23225 }] }] });
    const found = await vision(fn).segmentBottles(jpeg, [{ x: 0.82, y: 0.5 }]);
    expect(found.bottles.map(b => Math.round(b.box.x * 500))).toEqual([345]);
  });

  it('asks Muse Spark for strict JSON at low effort, every crop numbered, and checks what it read', async () => {
    const { fn, calls } = fakeFetch(chat(LABELS_23227));
    const read = await vision(fn).readLabels(Array.from({ length: 12 }, () => jpeg), targets);
    expect(read.labels.filter(l => l.match === 'read').map(l => l.componentId)).toEqual(['reagent-a']);
    const body = calls[0].body;
    expect(calls[0].url).toBe('https://api.meta.ai/v1/chat/completions');
    expect(body.model).toBe('muse-spark-1.3');
    expect(body.reasoning_effort).toBe('low');
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.response_format.json_schema.schema.properties.items.items.properties.component.enum).toEqual(['', 'reagent-a', 'reagent-b', 'bsa', 'diluent']);
    expect(body.messages[0].content).toContain('- reagent-a: BCA Reagent A (reagent; label says "BCA Reagent A" or "Reagent A")');
    expect(body.messages[0].content).toContain("- diluent: Diluent (same buffer as your samples) (diluent; the user's own bottle, no kit label)");
    const content = body.messages[1].content;
    expect(content.filter((c: any) => c.type === 'image_url')).toHaveLength(12);
    expect(content[1]).toEqual({ type: 'text', text: 'Picture 1:' });
    expect(body.response_format.json_schema.schema.properties.items.items.required).toEqual(expect.arrayContaining(['bottle', 'volume']));
    // Several views of one bottle: its pictures under its number, one answer for it.
    const views = fakeFetch(chat(JSON.stringify({ items: [{ crop: 1, bottle: true, name: 'BCA Protein Assay Reagent B', looks: 'small bottle', component: 'reagent-b', guess: '' }, { crop: 2, bottle: true, name: '', looks: 'glass ampule', component: '', guess: 'bsa' }] })));
    const grouped = await vision(views.fn).readLabels([jpeg, jpeg, jpeg, jpeg], targets, [3, 1]);
    expect(grouped.labels.map(l => [l.componentId, l.match])).toEqual([['reagent-b', 'read'], ['bsa', 'guess']]);
    const asked = views.calls[0].body.messages[1].content.map((c: any) => c.type === 'text' ? c.text : 'image');
    expect(asked).toEqual(['2 bottles:', 'Bottle 1 (3 pictures):', 'image', 'image', 'image', 'Bottle 2 (1 picture):', 'image']);
    expect(views.calls[0].body.messages[0].content).toContain('one group per bottle');
    expect(await vision(fakeFetch().fn).readLabels([], targets)).toEqual({ labels: [] });
  });

  it('asks SAM 3.1 for the packaging by Muse Spark’s word, then as "package", and returns what it found or none', async () => {
    const reply = (text: string) => ({ output: [{ type: 'message', content: [{ type: 'output_text', text }] }] });
    const pouch = fakeFetch({ output: [] }, reply(SAM_PACKAGE_POUCH));
    const found = await vision(pouch.fn).findPackaging(jpeg, 'pouch');
    expect(pouch.calls.map(c => c.body.input[0].content[0].text)).toEqual(['pouch', 'package']);
    expect(pouch.calls[0].url).toBe('https://api.meta.ai/v1/responses');
    expect(pouch.calls[0].body.model).toBe('sam-3.1');
    expect(pouch.calls[0].body.metadata).toEqual({ include_confidence: 'true' });
    expect(Math.round(found.box!.x * 1000)).toBe(90);
    // Found by its own word, asked once; "package" itself, once too.
    const box = fakeFetch(reply(SAM_BOX_23225));
    expect(Math.round((await vision(box.fn).findPackaging(jpeg, 'box')).box!.y * 461)).toBe(60);
    expect(box.calls).toHaveLength(1);
    const none = fakeFetch({ output: [] }, { output: [] });
    expect(await vision(none.fn).findPackaging(jpeg, 'bag')).toEqual({ box: null });
    expect(none.calls).toHaveLength(2);
    const once = fakeFetch({ output: [] });
    expect(await vision(once.fn).findPackaging(jpeg, 'package')).toEqual({ box: null });
    expect(once.calls).toHaveLength(1);
    await expect(vision(fakeFetch({ status: 'failed', error: { message: 'no' } }).fn).findPackaging(jpeg, 'box')).rejects.toThrow('Meta find-packaging failed: no');
  });

  it('sends a video to SAM 3.1 to follow "bottle", in the request or through Meta’s file store, and picks its frames', async () => {
    const lines = Array.from({ length: 6 }, (_, f) => `<${f}f>1<|box;x1=10;y1=20;x2=40;y2=90;w=100;h=100|><|mask;x=0;y=0;data=…|>`).join('\n');
    const done = { status: 'completed', usage: { video_frames_processed: 240 }, output: [{ type: 'message', content: [{ type: 'output_text', text: lines }] }] };
    const mp4: Video = { type: 'video/mp4', data: new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]) };
    const inline = fakeFetch(done);
    const tracked = await vision(inline.fn).trackBottles!(mp4);
    expect(inline.calls[0].body.input[0].content).toEqual([{ type: 'input_text', text: 'bottle' }, { type: 'input_video', video_url: 'data:video/mp4;base64,AAAAGGZ0eXBpc29t' }]);
    expect(tracked).toMatchObject({ frames: 240, picks: [{ frame: 0, bottles: [{ id: 1, box: expect.objectContaining({ x: 0.1 }), main: true }] }] });
    expect(tracked.seen[0]).toMatchObject({ frame: 0, id: 1, box: expect.objectContaining({ x: 0.1 }) });
    expect(inline.calls[0].body.metadata).toEqual({ mask_encoding: 'one_bit', include_confidence: 'true' });
    // Bigger than the request takes: uploaded first, then named by its file id.
    const calls: { url: string; body: unknown }[] = [];
    const store = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body instanceof FormData ? Object.fromEntries([...init.body.keys()].map(k => [k, true])) : JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(url.endsWith('/files') ? { id: 'file-842549258569145', object: 'file' } : done));
    }) as unknown as typeof fetch;
    await createKitVision({ apiKey: KEY, fetch: store, log: () => {}, inlineVideoMax: 4 }).trackBottles!({ ...mp4, type: 'video/quicktime' });
    expect(calls[0]).toEqual({ url: 'https://api.meta.ai/v1/files', body: { purpose: true, 'expires_after[anchor]': true, 'expires_after[seconds]': true, file: true } });
    expect((calls[1].body as any).input[0].content[1]).toEqual({ type: 'input_video', file_id: 'file-842549258569145' });
    // Too big for the request after all: sent again through the store.
    const again: string[] = [];
    const refused = (async (url: string) => {
      again.push(url);
      if (url.endsWith('/files')) return new Response(JSON.stringify({ id: 'file-1' }));
      return again.length === 1 ? new Response(JSON.stringify({ error: { message: 'request is too large' } }), { status: 413 }) : new Response(JSON.stringify(done));
    }) as unknown as typeof fetch;
    expect((await vision(refused).trackBottles!(mp4)).frames).toBe(240);
    expect(again).toEqual(['https://api.meta.ai/v1/responses', 'https://api.meta.ai/v1/files', 'https://api.meta.ai/v1/responses']);
    // A video shorter than the 50 frames SAM counts at least: up to the last frame it saw.
    const short = fakeFetch({ ...done, usage: { video_frames_processed: 50 } });
    expect((await vision(short.fn).trackBottles!(mp4)).frames).toBe(6);
    await expect(vision(fakeFetch({ status: 'failed', error: { message: 'no' } }).fn).trackBottles!(mp4)).rejects.toThrow('Meta track failed: no');
  });

  it('streams SAM’s frames as it follows a video: each outlined as it comes, an unsure one left out, then the bottles', async () => {
    // Frame 0 of @meta-sam/parser's README example, two objects with real masks, the second one SAM is unsure of.
    const line = (f: number) =>
      `<${f}f>0<|box;x1=211;y1=228;x2=270;y2=254;w=320;h=334;c=0.9|>` +
      "<|mask;x=0;y=0;c=0.9;data=27,60,~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(|>" +
      ',1<|box;x1=155;y1=228;x2=202;y2=254;w=320;h=334;c=0.2|>' +
      '<|mask;x=0;y=0;c=0.2;data=27,48,~!!!!J!0c[q=Pj_zs=*4C4(/./x#:/`S_GnD`=o3?X{emCgO$y@|>\n';
    const events = [
      { type: 'response.created' },
      ...[0, 1, 2].map(f => ({ type: 'response.output_text.delta', delta: line(f) })),
      { type: 'response.completed', response: { status: 'completed', usage: { video_frames_processed: 50 } } },
    ];
    const calls: { headers: Record<string, string>; body: any }[] = [];
    const sse = (async (_url: string, init: RequestInit) => {
      calls.push({ headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
      return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;
    const mp4: Video = { type: 'video/mp4', data: new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]) };
    const frames: FollowedFrame[] = [];
    const tracked = await vision(sse).trackBottles!(mp4, { onFrame: f => frames.push(f) });
    expect(calls[0].body.stream).toBe(true);
    expect(calls[0].headers.accept).toBe('text/event-stream');
    expect(frames.map(f => f.frame)).toEqual([0, 1, 2]);
    // Drawn as it comes: the bottle SAM is sure of, outlined in fractions of the frame; not the one it is unsure of.
    expect(frames[0].bottles.map(b => b.id)).toEqual([0]);
    expect(frames[0].bottles[0].outline).toMatch(/^M0\.\d{4},0\.\d{4}L.*Z$/);
    expect(tracked.seen).toHaveLength(3);
    expect(tracked.seen[0]).toEqual({ frame: 0, id: 0, box: frames[0].bottles[0].box, outline: frames[0].bottles[0].outline });
    expect(tracked.picks.flatMap(p => p.bottles.map(b => b.id))).toEqual([0]);
    // Not a video its frames can be read from: no times, the frames SAM saw.
    expect(tracked.frames).toBe(3);
    expect(tracked.times).toBeUndefined();
  });

  it('reads the kit box', async () => {
    const { fn, calls } = fakeFetch(chat(RECOGNIZED_BOTTLE));
    expect(await vision(fn).recognizeKit(jpeg)).toMatchObject({ found: true, query: 'Thermo Scientific Pierce BCA Protein Assay' });
    expect(calls[0].body.response_format.json_schema.name).toBe('Kit');
    expect(calls[0].body.response_format.json_schema.schema.required).toContain('packaging');
  });

  it('fails as UpstreamError, never with the key, when the model errs, times out or cannot be reached', async () => {
    const failing = fakeFetch({ status: 500, body: { error: { message: `bad key ${KEY}` } } });
    const error = await vision(failing.fn).segmentBottles(jpeg).catch(e => e);
    expect(error).toBeInstanceOf(UpstreamError);
    expect(error.message).toBe('Meta segment failed (500): bad key ***');
    const slow = (async (_: string, init: RequestInit) =>
      new Promise((_, fail) => init.signal!.addEventListener('abort', () => fail(init.signal!.reason)))) as unknown as typeof fetch;
    await expect(vision(slow, { labels: 20 }).readLabels([jpeg], targets)).rejects.toThrow('Meta read-labels timed out after 0 s');
    await expect(vision(fakeFetch(new TypeError('fetch failed')).fn).recognizeKit(jpeg)).rejects.toThrow('Could not reach the Meta API for recognize-kit');
    await expect(vision(fakeFetch({ status: 'failed', error: { message: 'no' } }).fn).segmentBottles(jpeg)).rejects.toThrow('Meta segment failed: no');
  });
});

describe('mock kit vision', () => {
  it('answers with the drawn sample photos: two bottles on the first, one on each other, the reagents read', async () => {
    const mock = createMockKitVision();
    expect((await mock.segmentBottles(jpeg, undefined, 0)).bottles).toHaveLength(2);
    expect((await mock.segmentBottles(jpeg, undefined, 1)).bottles).toHaveLength(1);
    const { labels } = await mock.readLabels([jpeg, jpeg, jpeg, jpeg, jpeg], targets);
    expect(labels.map(l => [l.match, l.componentId, l.looks])).toEqual([
      ['read', 'reagent-a', 'bottle'],
      ['read', 'reagent-b', 'bottle'],
      ['guess', 'bsa', 'small vial'],
      ['none', null, 'tall bottle'],
      ['none', null, 'bottle'],
    ]);
    expect(await mock.recognizeKit(jpeg)).toMatchObject({ found: true, kit: { name: 'Pierce BCA Protein Assay Kit' }, protocolId: 'pierce-bca' });
    // The sample photos are bottles on a bench: no packaging.
    expect(await mock.findPackaging(jpeg, 'box')).toEqual({ box: null });
    // No video: the phone reads the frames it kept.
    expect(await mock.trackBottles!({ type: 'video/mp4', data: new Uint8Array(8) })).toEqual({ frames: 0, picks: [], seen: [] });
  });
});

describe('/api/kit routes', () => {
  const dist = mkdtempSync(join(tmpdir(), 'chapp-dist-'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Chapp</title>');
  const servers: Server[] = [];
  let mock: string, blind: string;
  const start = async (provider: AIProvider) => {
    const server = createServer(createHandler({ provider, providerName: 'mock', metaModelApi: false, dist }));
    servers.push(server);
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };
  beforeAll(async () => {
    const { recognizeKit, segmentBottles, findPackaging, trackBottles, readLabels, ...rest } = createMockProvider();
    void [recognizeKit, segmentBottles, findPackaging, trackBottles, readLabels];
    [mock, blind] = await Promise.all([start(createMockProvider()), start(rest)]);
  });
  afterAll(() => servers.forEach(s => s.close()));

  const photo = { type: 'image/jpeg', data: Buffer.from(jpeg.data).toString('base64') };
  const post = (base: string, path: string, body: unknown, type = 'application/json') =>
    fetch(base + path, { method: 'POST', headers: { 'content-type': type }, body: typeof body === 'string' ? body : JSON.stringify(body) });

  it('finds bottles, reads labels and recognizes the kit', async () => {
    const seg = await post(mock, '/api/kit/segment', { photo, index: 0 });
    expect(seg.status).toBe(200);
    expect((await seg.json()).bottles).toHaveLength(2);
    const labels = await post(mock, '/api/kit/labels', { crops: [photo, photo], components: targets });
    expect((await labels.json()).labels.map((l: any) => l.match)).toEqual(['read', 'read']);
    const grouped = await post(mock, '/api/kit/labels', { crops: [photo, photo, photo], components: targets, views: [2, 1] });
    expect((await grouped.json()).labels).toHaveLength(2);
    expect((await post(mock, '/api/kit/labels', { crops: [photo, photo], components: targets, views: [3] })).status).toBe(400);
    const kit = await post(mock, '/api/kit/recognize', { photo });
    expect((await kit.json()).found).toBe(true);
    const packaging = await post(mock, '/api/kit/packaging', { photo, what: 'bag' });
    expect(packaging.status).toBe(200);
    expect(await packaging.json()).toEqual({ box: null });
  });

  it('turns away what is not a photo, not JSON, not POST, or not a route', async () => {
    const notPhoto = await post(mock, '/api/kit/segment', { photo: { type: 'image/jpeg', data: Buffer.from('hello, this is text').toString('base64') } });
    expect(notPhoto.status).toBe(400);
    expect((await notPhoto.json()).error).toBe('The photo is not a JPEG, PNG or WebP picture');
    expect((await post(mock, '/api/kit/labels', { crops: [], components: targets })).status).toBe(400);
    expect((await post(mock, '/api/kit/segment', '{', 'application/json')).status).toBe(400);
    expect((await post(mock, '/api/kit/segment', 'x', 'text/plain')).status).toBe(415);
    expect((await fetch(`${mock}/api/kit/segment`)).status).toBe(405);
    expect((await post(mock, '/api/kit/nothing', {})).status).toBe(404);
    expect((await post(blind, '/api/kit/segment', { photo })).status).toBe(501);
    expect((await post(blind, '/api/kit/packaging', { photo, what: 'box' })).status).toBe(501);
    expect((await post(mock, '/api/kit/packaging', { photo })).status).toBe(400);
  });

  it('follows the bottles through a video sent as it is, and turns away what is not one', async () => {
    const mp4 = new Blob([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 2, 0])]);
    const send = (base: string, body: Blob | string, type: string) => fetch(`${base}/api/kit/track`, { method: 'POST', headers: { 'content-type': type }, body });
    const ok = await send(mock, mp4, 'video/mp4');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ frames: 0, picks: [], seen: [] });
    expect((await send(mock, mp4, 'video/quicktime')).status).toBe(200);
    expect((await send(mock, 'not a video at all', 'video/mp4')).status).toBe(400);
    expect((await send(mock, JSON.stringify({ photo }), 'application/json')).status).toBe(415);
    expect((await send(blind, mp4, 'video/mp4')).status).toBe(501);
  });

  it('with accept: text/event-stream, sends the video’s frames, how it goes to SAM, each frame, then the bottles', async () => {
    const mp4 = new Blob([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 2, 0])]);
    const box = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
    const outline = 'M0.1,0.2L0.4,0.2L0.4,0.6Z';
    const live = await start({
      ...createMockProvider(),
      trackBottles: async (_video, l) => {
        l?.onVideo?.({ times: [0, 0.0333] });
        l?.onStage?.('started');
        l?.onFrame?.({ frame: 0, bottles: [{ id: 1, box, outline }] });
        return { frames: 2, times: [0, 0.0333], picks: [{ frame: 0, bottles: [{ id: 1, box, main: true }] }], seen: [{ frame: 0, id: 1, box, outline }] };
      },
    });
    const read = async (res: Response) => {
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const got: TrackEvent[] = [];
      for await (const e of readEvents(res.body!)) got.push({ event: e.event, data: JSON.parse(e.data) } as TrackEvent);
      return got;
    };
    const events = async (base: string) => read(await fetch(`${base}/api/kit/track`, { method: 'POST', headers: { 'content-type': 'video/mp4', accept: 'text/event-stream' }, body: mp4 }));
    expect(await events(live)).toEqual([
      { event: 'video', data: { times: [0, 0.0333] } },
      { event: 'stage', data: { stage: 'started' } },
      { event: 'frame', data: { frame: 0, bottles: [{ id: 1, box, outline }] } },
      // The sightings were sent frame by frame: not again.
      { event: 'followed', data: { frames: 2, times: [0, 0.0333], picks: [{ frame: 0, bottles: [{ id: 1, box, main: true }] }] } },
    ]);
    // SAM failing once the stream has begun: the status is 200 by then, so the error travels as an event.
    const failing = await start({ ...createMockProvider(), trackBottles: async () => Promise.reject(new UpstreamError('Meta track failed: no')) });
    expect(await events(failing)).toEqual([{ event: 'error', data: { error: 'Meta track failed: no' } }]);
  });

  it('knows a picture by its first bytes', () => {
    expect(imageType(jpeg.data)).toBe('image/jpeg');
    expect(imageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]))).toBe('image/png');
    expect(imageType(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(imageType(new TextEncoder().encode('GIF89a'))).toBeNull();
  });
});

// Every reply kept by scripts/kit-vision.ts (data/smoke/kit/raw/cache/, only on a machine that ran it) still parses.
const cache = new URL('../data/smoke/kit/raw/cache/', import.meta.url);
const kept = existsSync(cache) ? readdirSync(cache).filter(f => f.endsWith('.json')) : [];
describe.runIf(kept.length > 0 && local)('saved live replies', () => {
  it('parse into boxes, labels and kits', () => {
    const bca = labelTargets(loadProtocol('pierce-bca')!);
    for (const file of kept) {
      const reply = JSON.parse(readFileSync(new URL(file, cache), 'utf8'));
      if (reply.model === 'sam-3.1') {
        expect(parseSam(reply.output[0].content[0].text).length, file).toBeGreaterThan(0);
        continue;
      }
      const content = reply.choices[0].message.content;
      const parsed = JSON.parse(content);
      if ('items' in parsed) expect(parseLabels(content, bca, parsed.items.length).labels, file).toHaveLength(parsed.items.length);
      else expect(parseRecognized(content).found, file).toBe(true);
    }
  });
});
