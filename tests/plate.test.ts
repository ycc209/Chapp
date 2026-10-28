import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlateReading } from '../shared/ai.ts';
import { analyzePlate } from '../shared/fit.ts';
import { decodeText, fitToPlan, parsePlateText, readingOf, wellId } from '../shared/plate.ts';
import { createHandler } from '../server/app.ts';
import { createMetaProvider } from '../server/ai/meta.ts';
import { createMockProvider } from '../server/ai/mock.ts';
import { platePrompt, plateFromModel, xlsxText } from '../server/ai/plate.ts';
import { plateMap, wellRoles } from '../src/components/lab/model.ts';
import { checkIsClean, editCheck, needsLook, readableText, typedReading, type PlateCheck } from '../src/screens/run/model.ts';

// One BCA plate (the kit's 9 standards and 12 samples in duplicate, 42 wells) as six readers export it, made by the
// fixtures' generator: tests/fixtures/plate/expected.json holds all 96 values and the plan's wells.
const dir = new URL('./fixtures/plate/', import.meta.url);
const fixture = (name: string) => new Uint8Array(readFileSync(new URL(name, dir)));
const expected = JSON.parse(readFileSync(new URL('expected.json', dir), 'utf8')) as { plan: string[]; values: Record<string, number> };

const kit = [['A', 2000], ['B', 1500], ['C', 1000], ['D', 750], ['E', 500], ['F', 250], ['G', 125], ['H', 25], ['I', 0]] as const;
const plate = plateMap({ standards: kit.map(([id, c]) => ({ id, concentration: c, blank: c === 0 })), standardReplicates: 2, samples: 12, sampleReplicates: 2 });
const roles = wellRoles(plate);
const wells = plate.cells.map(c => c.well);
const bcaFit = { preferred: ['4pl', 'best-fit'], avoid: ['linear'] } as Parameters<typeof analyzePlate>[2];
const truth = analyzePlate(roles, Object.fromEntries(wells.map(w => [w, expected.values[w]!])), bcaFit);

describe('the fixture plate', () => {
  it('is the storyboard plate: 42 wells, the plan the generator used', () => {
    expect(wells.sort()).toEqual([...expected.plan].sort());
    expect(Object.keys(expected.values)).toHaveLength(96);
  });
});

const exports: { file: string; layout: 'grid' | 'list'; wells: number; odd?: Record<string, string>; decimals?: number; reads?: number }[] = [
  { file: 'gen5-synergy.txt', layout: 'grid', wells: 95, odd: { H12: 'OVRFLW' }, reads: 2 },
  { file: 'softmax-plate.txt', layout: 'grid', wells: 96 },
  { file: 'tecan-icontrol-de.csv', layout: 'grid', wells: 95, odd: { H4: 'OVER' } },
  { file: 'bmg-mars-list.csv', layout: 'list', wells: 96 },
  { file: 'well-value.csv', layout: 'list', wells: 42 },
  { file: 'printout.txt', layout: 'grid', wells: 96, decimals: 3 },
];

describe('plate-reader exports, read without a model', () => {
  for (const x of exports) {
    it(`${x.file}: the ${x.layout} layout, every well where the reader put it`, () => {
      const read = parsePlateText(decodeText(fixture(x.file)), { wavelength: 562 })!;
      expect(read).not.toBeNull();
      expect(read.layout).toBe(x.layout);
      expect(Object.keys(read.values)).toHaveLength(x.wells);
      expect(read.odd).toEqual(x.odd ?? {});
      if (x.reads) expect(read.reads).toBe(x.reads);
      const tolerance = (x.decimals ?? 4) === 4 ? 1e-9 : 0.0006;
      for (const [w, v] of Object.entries(read.values)) expect(Math.abs(v - expected.values[w]!), w).toBeLessThanOrEqual(tolerance);
    });

    it(`${x.file}: round trip through analyzePlate gives the plate's own answers`, () => {
      const read = parsePlateText(decodeText(fixture(x.file)), { wavelength: 562 })!;
      const fit = fitToPlan(read, wells);
      expect(fit.missing).toEqual([]);
      const a = analyzePlate(roles, fit.readings, bcaFit);
      expect(a.standards.filter(s => !s.blank)).toHaveLength(8);
      for (const s of a.samples) {
        const want = truth.samples.find(t => t.ref === s.ref)!;
        expect(s.flag, `sample ${s.ref}`).toBe(want.flag);
        if (want.concentration !== null) expect(Math.abs(s.concentration! - want.concentration) / want.concentration, `sample ${s.ref}`).toBeLessThan(0.015);
      }
      // The example's Sample 7 is above the top standard, in every export.
      expect(a.samples.find(s => s.ref === '7')!.flag).toBe('above');
    });
  }

  it('Gen5: takes the 562 read, not the layout of names before it or the blank-corrected copy after it', () => {
    const read = parsePlateText(decodeText(fixture('gen5-synergy.txt')), { wavelength: 562 })!;
    expect(read.label).toMatch(/562/);
    expect(read.label).not.toMatch(/blank/i);
    expect(read.values.A1).toBe(expected.values.A1);
  });

  it('SoftMax Pro: UTF-16 with a byte-order mark, rows without letters under the temperature', () => {
    const bytes = fixture('softmax-plate.txt');
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xfe]);
    const read = parsePlateText(decodeText(bytes))!;
    expect(read.values.A1).toBe(expected.values.A1);
    expect(read.values.H12).toBe(expected.values.H12);
    expect(read.values).not.toHaveProperty('A13');
  });

  it('Tecan: decimal commas between semicolons, and OVER kept as an odd well of the plan', () => {
    const read = parsePlateText(decodeText(fixture('tecan-icontrol-de.csv')))!;
    const fit = fitToPlan(read, wells);
    expect(fit.odd).toEqual({ H4: 'OVER' });
    expect(Object.keys(fit.readings)).toHaveLength(41);
  });

  it('Tecan Magellan .xlsx: the first sheet as text, then the same grid', () => {
    const text = xlsxText(Buffer.from(fixture('tecan-magellan.xlsx')));
    expect(text).toMatch(/^Application: Tecan i-control/);
    const read = parsePlateText(text, { wavelength: 562 })!;
    expect(Object.keys(read.values)).toHaveLength(96);
    for (const w of wells) expect(read.values[w]).toBeCloseTo(expected.values[w]!, 9);
  });

  it('a "Well,Value" list picks the value column over the wavelength and the mean', () => {
    const read = parsePlateText(decodeText(fixture('well-value.csv')))!;
    expect(read.label).toMatch(/Value/);
    expect(read.values.B1).toBe(expected.values.B1);
  });

  it('a list with the row and the column apart (Well Row, Well Col)', () => {
    const text = ['Well Row,Well Col,Content,Raw Data (562)', 'A,1,Standard S1,2.2373', 'A,2,Standard S1,2.2730', 'B,1,Standard S2,1.8317', 'B,2,Standard S2,1.8626'].join('\n');
    expect(parsePlateText(text, { wavelength: 562 })!.values).toEqual({ A1: 2.2373, A2: 2.273, B1: 1.8317, B2: 1.8626 });
  });

  it('two wavelengths in a list: the protocol’s one', () => {
    const text = ['Well,Abs 650,Abs 562', 'A1,0.051,1.234', 'A2,0.049,1.240', 'A3,0.050,0.987'].join('\n');
    expect(parsePlateText(text, { wavelength: 562 })!.values.A1).toBe(1.234);
  });

  it('reads well ids and readings as readers write them', () => {
    expect(['A1', 'a01', 'H12', 'H 12', 'I1', 'A13'].map(w => wellId(w))).toEqual(['A1', 'A1', 'H12', 'H12', null, null]);
    expect(readingOf('0,123', true)).toBe(0.123);
    expect(readingOf('0,123', false)).toBeNull();
    expect(readingOf('1.5E-01', false)).toBe(0.15);
    expect(readingOf('OVRFLW', false)).toBeNull();
  });

  it('decodes Windows-1252 and UTF-16 without a mark', () => {
    expect(decodeText(new Uint8Array([0x32, 0x34, 0xb0, 0x43]))).toBe('24°C');
    expect(decodeText(new Uint8Array(Buffer.from('A,1,2,3\nB,4,5,6', 'utf16le')))).toBe('A,1,2,3\nB,4,5,6');
  });

  it('finds nothing in a file without a plate, or in a layout of names alone', () => {
    expect(parsePlateText('Hello\nThis is not a plate')).toBeNull();
    const names = ['', ...Array.from({ length: 12 }, (_, i) => i + 1)].join('\t') + '\n' + 'ABCDEFGH'.split('').map(r => [r, ...Array(12).fill('SPL1')].join('\t')).join('\n');
    expect(parsePlateText(names)).toBeNull();
  });
});

describe('the plan’s wells and the check on Run-Read', () => {
  const values = Object.fromEntries(wells.map(w => [w, expected.values[w]!]));

  it('fits a read to the plan: missing, odd and wells outside it', () => {
    const { A1, ...rest } = values;
    const fit = fitToPlan({ values: { ...rest, H12: 0.05 }, odd: { B1: 'OVRFLW' } }, wells);
    expect(fit.missing).toEqual(['A1']);
    expect(fit.odd).toEqual({});
    expect(fit.extra).toBe(1);
    expect(A1).toBeGreaterThan(2);
    const odd = fitToPlan({ values: Object.fromEntries(Object.entries(values).filter(([w]) => w !== 'B1')), odd: { B1: 'OVRFLW' } }, wells);
    expect(odd.odd).toEqual({ B1: 'OVRFLW' });
  });

  it('a whole file goes straight to Results; a model’s reading, or a gap, is checked first', () => {
    const file: PlateCheck = { by: 'file', name: 'plate.csv', values, odd: {}, unsure: [], note: null };
    expect(checkIsClean(file, fitToPlan(file, wells))).toBe(true);
    const photo: PlateCheck = { ...file, by: 'model', name: null, unsure: ['B3'] };
    expect(checkIsClean(photo, fitToPlan(photo, wells))).toBe(false);
    const { H4, ...withoutH4 } = values;
    const gap: PlateCheck = { ...file, values: withoutH4, odd: { H4: 'OVER' } };
    expect(H4).toBeGreaterThan(2);
    expect(checkIsClean(gap, fitToPlan(gap, wells))).toBe(false);
  });

  it('says how many wells are readable (Gloves-Photo) and marks the ones to look at', () => {
    const c: PlateCheck = { by: 'model', name: null, values: { ...values }, odd: { H4: 'OVER' }, unsure: ['B3', 'H11'], note: null };
    delete c.values.H4;
    delete c.values.A1;
    const fit = fitToPlan(c, wells);
    expect(readableText(fit)).toBe('40 of 42 wells are readable.');
    expect(readableText(fitToPlan({ values }, wells))).toBe('All 42 wells are readable.');
    expect([...needsLook(c, fit)].sort()).toEqual(['A1', 'B3', 'H4']);
  });

  it('a well typed in by hand is a reading, no longer odd or in doubt', () => {
    const c: PlateCheck = { by: 'model', name: null, values: { A1: 1 }, odd: { H4: 'OVER' }, unsure: ['A1'], note: null };
    const typed = editCheck(c, 'H4', typedReading('2,95')!);
    expect(typed.values.H4).toBe(2.95);
    expect(typed.odd).toEqual({});
    expect(editCheck(c, 'A1', 1.1).unsure).toEqual([]);
    expect(editCheck(c, 'A1', null).values).toEqual({});
    expect(typedReading('abc')).toBeNull();
  });
});

describe('what Muse Spark reads', () => {
  const hints = { rows: 8, cols: 12 };

  it('asks for the grid as shown, at the protocol’s wavelength', () => {
    const p = platePrompt({ photo: { type: 'image/jpeg', data: new Uint8Array() }, ...hints, wavelength: 562 });
    expect(p).toMatch(/rows A–H and columns 1–12/);
    expect(p).toMatch(/562 nm/);
    expect(p).toMatch(/never round/);
  });

  it('turns its rows into wells: numbers, odd text, and the wells it doubted', () => {
    const content = JSON.stringify({
      found: true,
      wavelength: '562',
      rows: [
        { row: 'A', values: ['2.237', '2,273', 'OVRFLW', '', ...Array(7).fill(''), '0.04', 'extra'] },
        { row: 'B', values: ['1.832', '-'] },
        { row: 'Z', values: ['9'] },
      ],
      unclear: ['A2', 'Q9', 'b1'],
      note: '',
    });
    const r = plateFromModel(content, hints);
    expect(r).toEqual({ readings: { A1: 2.237, A2: 2.273, A12: 0.04, B1: 1.832 }, odd: { A3: 'OVRFLW' }, unsure: ['A2', 'B1'], sampleData: false, by: 'model' });
  });

  it('says so when there is no plate in the picture', () => {
    const r = plateFromModel(JSON.stringify({ found: false, wavelength: '', rows: [], unclear: [], note: '' }), hints);
    expect(r.readings).toEqual({});
    expect(r.note).toBe('No plate table found.');
    expect(() => plateFromModel('{"found": tru', hints)).toThrow(/not JSON/);
  });
});

// ─── The route ───────────────────────────────────────────────────────────────────────────────────────────────────

const dist = mkdtempSync(join(tmpdir(), 'chapp-dist-'));
writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Chapp</title>');
const servers: Server[] = [];
const calls: { url: string; body: any }[] = [];
let answer = '';
const fakeMeta = createMetaProvider({
  apiKey: 'test-key',
  log: () => {},
  fetch: (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ choices: [{ message: { content: answer } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch,
});

async function start(provider: Parameters<typeof createHandler>[0]['provider']): Promise<string> {
  const server = createServer(createHandler({ provider, providerName: 'mock', metaModelApi: false, dist, push: { dir: mkdtempSync(join(tmpdir(), 'chapp-push-')) } }));
  servers.push(server);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
let mock: string, meta: string;
beforeAll(async () => {
  [mock, meta] = await Promise.all([start(createMockProvider()), start(fakeMeta)]);
});
afterAll(() => servers.forEach(s => s.close()));

const read = (base: string, body: unknown) =>
  fetch(`${base}/api/read-plate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: (await r.json()) as PlateReading & { error?: string } }));
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==';

describe('POST /api/read-plate', () => {
  it('reads an export itself, without the model', async () => {
    const r = await read(meta, { file: { name: 'gen5.txt', text: decodeText(fixture('gen5-synergy.txt')) }, wavelength: 562 });
    expect(r.status).toBe(200);
    expect(r.body.by).toBe('file');
    expect(r.body.sampleData).toBe(false);
    expect(Object.keys(r.body.readings)).toHaveLength(95);
    expect(r.body.odd).toEqual({ H12: 'OVRFLW' });
    expect(r.body.note).toMatch(/562/);
    expect(calls).toHaveLength(0);
  });

  it('opens .xlsx and UTF-16 text sent as base64', async () => {
    const x = await read(mock, { file: { name: 'magellan.xlsx', base64: Buffer.from(fixture('tecan-magellan.xlsx')).toString('base64') } });
    expect(x.body.by).toBe('file');
    expect(Object.keys(x.body.readings)).toHaveLength(96);
    const u = await read(mock, { file: { name: 'softmax.txt', base64: Buffer.from(fixture('softmax-plate.txt')).toString('base64') } });
    expect(u.body.readings.A1).toBe(expected.values.A1);
  });

  it('hands an odd file to the model, and its reading comes back to be checked', async () => {
    answer = JSON.stringify({ found: true, wavelength: '562', rows: [{ row: 'A', values: ['2.237', '2.273'] }], unclear: ['A2'], note: '' });
    const r = await read(meta, { file: { name: 'odd.txt', text: 'Plate 1 at 562\nA1 is 2.237 and A2 is 2.273' }, wavelength: 562 });
    expect(r.body).toEqual({ readings: { A1: 2.237, A2: 2.273 }, odd: {}, unsure: ['A2'], sampleData: false, by: 'model' });
    expect(calls.at(-1)!.body.messages[0].content).toMatch(/A1 is 2\.237/);
    expect(calls.at(-1)!.body.response_format.json_schema.name).toBe('PlateRead');
  });

  it('sends a photo to Muse Spark as an image', async () => {
    answer = JSON.stringify({ found: true, wavelength: '562', rows: [{ row: 'H', values: Array(12).fill('0.045') }], unclear: [], note: '' });
    const r = await read(meta, { photo: PNG, wavelength: 562 });
    expect(r.body.by).toBe('model');
    expect(Object.keys(r.body.readings)).toHaveLength(12);
    const content = calls.at(-1)!.body.messages[0].content;
    expect(content[1]).toEqual({ type: 'image_url', image_url: { url: PNG } });
  });

  it('the mock reads no photo: the sample readings, labeled as such', async () => {
    const r = await read(mock, { photo: PNG });
    expect(r.body).toMatchObject({ readings: {}, sampleData: true, by: 'sample' });
  });

  it('says plainly what is wrong with a request', async () => {
    expect((await read(mock, {})).status).toBe(400);
    expect((await read(mock, { photo: 'data:text/html;base64,AAAA' })).status).toBe(400);
    expect((await read(mock, { photo: PNG, file: { name: 'x.csv', text: 'A,1' } })).status).toBe(400);
    const zip = await read(mock, { file: { name: 'broken.xlsx', base64: Buffer.from('PK\u0003\u0004 not really a zip at all, just bytes').toString('base64') } });
    expect(zip.status).toBe(400);
    expect(zip.body.error).toMatch(/CSV or XLSX/);
    const none = await read(mock, { file: { name: 'notes.txt', text: 'Hello' } });
    expect(none.body).toMatchObject({ readings: {}, note: 'No plate table found.' });
    const get = await fetch(`${mock}/api/read-plate`);
    expect(get.status).toBe(405);
  });

  it('a model that answers badly is a 502 with a message to show', async () => {
    answer = 'not json';
    const r = await read(meta, { photo: PNG });
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/not JSON/);
  });
});
