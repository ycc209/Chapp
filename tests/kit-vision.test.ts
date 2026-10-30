import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AIProvider, LabelTarget, Photo } from '../shared/ai.ts';
import { createHandler } from '../server/app.ts';
import { imageType } from '../server/kit.ts';
import { createMockProvider } from '../server/ai/mock.ts';
import { UpstreamError } from '../server/ai/provider.ts';
import { loadProtocol } from '../server/ai/protocols.ts';
import { boxesAt, createKitVision, createMockKitVision, imageSize, namedBy, parseLabels, parseRecognized, parseSam, parseSamRecords, samPointPrompt, tidyBottles, tidyBoxes } from '../server/ai/vision.ts';
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
    expect(found.bottles).toEqual([{ box: expect.any(Object), score: 0.91 }]);
    expect(Math.round(found.bottles[0]!.box.x * 500)).toBe(345);
    // A tap on nothing: nothing.
    const none = fakeFetch({ output: [] });
    expect((await vision(none.fn).segmentBottles(sized, [{ x: 0.1, y: 0.1 }])).bottles).toEqual([]);
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
    expect(await vision(fakeFetch().fn).readLabels([], targets)).toEqual({ labels: [] });
  });

  it('reads the kit box', async () => {
    const { fn, calls } = fakeFetch(chat(RECOGNIZED_BOTTLE));
    expect(await vision(fn).recognizeKit(jpeg)).toMatchObject({ found: true, query: 'Thermo Scientific Pierce BCA Protein Assay' });
    expect(calls[0].body.response_format.json_schema.name).toBe('Kit');
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
    const { recognizeKit, segmentBottles, readLabels, ...rest } = createMockProvider();
    void [recognizeKit, segmentBottles, readLabels];
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
    const kit = await post(mock, '/api/kit/recognize', { photo });
    expect((await kit.json()).found).toBe(true);
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
