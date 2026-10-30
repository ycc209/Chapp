import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  assemble, citeText, countPages, INTRO, micro, parseQuantity, CURVES, formatOf, importProtocol, INVENTORY, isPdf, NOTES, parseAmount, parseCite, parseConcentration, parseRange,
  parseTemperature, parseTime, parseVolume, readWire, renameLegacy, slug, STEPS, withId,
} from '../server/ai/import.ts';
import { intro, parts } from './import-fixture.ts';
import { compareProtocols } from '../server/ai/import-check.ts';
import { UpstreamError } from '../server/ai/provider.ts';
import { meter } from '../server/ai/usage.ts';
import type { ProtocolIntro } from '../shared/ai.ts';
import { isAssay, Protocol, problems } from '../shared/protocol.ts';

const meta = { sha256: 'a'.repeat(64), pages: 2, fetchedAt: '2026-10-28T00:00:00.000Z', seconds: 1 };

describe('units on the wire', () => {
  it('asks for micro in plain ASCII and keeps every unit as printed', () => {
    // With the micro sign in a schema Muse Spark often wrote mL for 25 µL. No schema has a unit list any more: amounts
    // are text with their unit, micro written u, read back as µ, and kept whatever the unit is.
    for (const spec of [INTRO, INVENTORY, STEPS, CURVES, NOTES]) expect(JSON.stringify(formatOf('X', spec))).not.toMatch(/µ|"uL"|"mL"/);
    expect([parseVolume('25 uL'), parseVolume('25 μL'), parseRange('20-2000 μg/mL')?.unit]).toEqual([{ value: 25, unit: 'µL' }, { value: 25, unit: 'µL' }, 'µg/mL']);
    expect(['500 nL', '10 ng/mL', '5 uM', '0.5 %', '10 U/mL', '2 x 10^6 cells'].map(parseQuantity)).toEqual([
      { value: 500, unit: 'nL' }, { value: 10, unit: 'ng/mL' }, { value: 5, unit: 'µM' }, { value: 0.5, unit: '%' }, { value: 10, unit: 'U/mL' }, null,
    ]);
    expect(parseRange('15.6-1,000 pg/mL')).toEqual({ min: 15.6, max: 1000, unit: 'pg/mL' });
    // The unit is one word: what follows it is not part of it.
    expect(['10 mg/mL in water', '25 uL per well', '2 mg / mL'].map(parseQuantity)).toEqual([{ value: 10, unit: 'mg/mL' }, { value: 25, unit: 'µL' }, { value: 2, unit: 'mg/mL' }]);
  });
});

describe('assembling the wire rows into a protocol', () => {
  const { protocol: p, problems: found } = assemble(parts(), meta);

  it('validates, with ids made safe and references resolved', () => {
    expect(Protocol.safeParse(p).success).toBe(true);
    expect(p.id).toBe('demo-assay');
    expect(p.title).toBe('Demo Assay');
    expect(p.components.map(c => c.id)).toEqual(['reagent-a', 'reagent-b', 'std', 'buffer']);
    expect(p.mixes[0]!.parts).toEqual([{ component: 'reagent-a', parts: 10 }, { component: 'reagent-b', parts: 1 }]);
    expect(p.procedures[0]!.steps.find(s => s.id === 'p-read')!.equipment).toEqual(['reader']);
    expect(problems(p).filter(x => x.includes('unknown id'))).toEqual([]);
  });

  it('keeps the numbers as printed: temperatures, volumes, the dilution table', () => {
    expect(p.components[0]!.storage).toEqual({ value: 2, max: 8, unit: '°C' });
    expect(p.components[1]!.storage).toEqual({ value: -20, unit: '°C' });
    const proc = p.procedures[0]!;
    expect(isAssay(proc)).toBe(true);
    expect([proc.sample, proc.mixPerSample, proc.ratio]).toEqual([{ value: 20, unit: 'µL' }, { value: 200, unit: 'µL' }, '1:10']);
    const timer = proc.steps.find(s => s.stage === 'incubate')!.timer!;
    expect(timer).toMatchObject({ duration: { value: 30, unit: 'min' }, temperature: { value: 37, unit: '°C' }, covered: true });
    expect(timer.alternatives![0]).toMatchObject({ duration: { value: 2, unit: 'h' }, temperature: { value: 15, max: 30, unit: '°C' } });
    expect(p.standardCurves[0]!.points.map(x => [x.id, x.from, x.take.value, x.diluent.value, x.concentration.value, x.blank ?? false]))
      .toEqual([['A', 'stock', 100, 0, 1000, false], ['B', 'A', 50, 50, 500, false], ['C', null, 0, 100, 0, true]]);
    expect(problems(p)).toEqual([]);
  });

  it('makes standards in the wells up to what the procedure puts in each well, when no row says the volume', () => {
    // As Muse Spark read the ATP manual on 2026-10-30: "adjust volume to 50 µL/well" left out of every row, the
    // blank's too; the procedure loads 50 µL of standards and samples.
    const atp = parts();
    atp.inventory.curves = [{ id: 'col', name: 'ATP standards', stock: 'std', diluent: 'buffer', range: '0-10 nmol/well', cite: 'p9: 0, 2, 4 nmol/well' }];
    atp.inventory.procedures = [{ ...atp.inventory.procedures[0]!, curve: 'col', sample: '50 uL', range: '0-10 nmol/well' }];
    atp.curves.points = [
      { curve: 'col', id: 'col-1mm', diluent: '90 uL', from: 'stock', take: '10 uL', concentration: '1 mM', blank: false },
      { curve: 'col', id: 'col-1', diluent: '', from: 'col-1mm', take: '0 uL', concentration: '0 nmol/well', blank: true },
      { curve: 'col', id: 'col-2', diluent: '', from: 'col-1mm', take: '2 uL', concentration: '2 nmol/well', blank: false },
      { curve: 'col', id: 'col-3', diluent: '', from: 'col-1mm', take: '4 uL', concentration: '', blank: false },
    ];
    const { protocol, problems: dropped } = assemble(atp, meta);
    expect(protocol.standardCurves[0]!.points.map(x => [x.id, x.take.value, x.diluent.value, `${x.concentration.value} ${x.concentration.unit}`, x.blank ?? false, x.intermediate ?? false])).toEqual([
      ['1mm', 10, 90, '1 mM', false, true],
      ['1', 0, 50, '0 nmol/well', true, false],
      ['2', 2, 48, '2 nmol/well', false, false],
      // No concentration: 4 µL of the 1 mM working dilution.
      ['3', 4, 46, '4 nmol/well', false, false],
    ]);
    expect(dropped.filter(x => /not a whole row/.test(x))).toEqual([]);
  });

  it('puts each note where it belongs and reports what it dropped', () => {
    expect(p.mixes[0]!.notes.map(n => n.text)).toEqual(['It turns green.']);
    expect(p.notes.map(n => n.text)).toEqual(['Research use only.', 'Wear gloves.']);
    expect(p.procedures[0]!.steps.find(s => s.id === 'p-load')!.notes!.map(n => n.text)).toEqual(['Pipette slowly.']);
    // Reagent prep is kept apart from the experiment's steps.
    expect(p.procedures[0]!.prep!.map(s => [s.id, s.key])).toEqual([['p-warm', 'Bring Reagents A and B to room temperature']]);
    expect(p.procedures[0]!.steps.map(s => s.id)).toEqual(['p-standards', 'p-load', 'p-incubate', 'p-read']);
    expect(found).toEqual(expect.arrayContaining([
      'mix lonely: fewer than two parts',
      'step p-load: a mix addition without what it adds',
      'step p-read note: no citation',
      'analysis: the manual names no curve fit; Chapp fits a four-parameter curve',
    ]));
    expect(p.imported).toMatchObject({ model: 'muse-spark-1.3', problems: found });
  });

  it('serves an upload from Chapp, and renames it with its path', () => {
    expect(p.source.url).toBe('/api/protocols/demo-assay/manual.pdf');
    expect(withId(p, 'demo-2').source.url).toBe('/api/protocols/demo-2/manual.pdf');
    const web = assemble(parts(), { ...meta, url: 'https://demo.example/manual.pdf' }).protocol;
    expect(withId(web, 'demo-2').source.url).toBe('https://demo.example/manual.pdf');
  });

  it('reads a cell protocol: no plate, no standards, no readout', () => {
    const cells = parts();
    cells.inventory.curves = [];
    cells.inventory.procedures[0] = { ...cells.inventory.procedures[0]!, format: 'cells', mix: '', curve: '', ratio: '', sample: '', mixPerSample: '', range: '' };
    cells.steps.steps = cells.steps.steps.filter(s => s.stage !== 'standards').map(s => (s.stage === 'read' ? { ...s, stage: 'observe' } : s));
    cells.curves.points = [];
    cells.notes = { ...cells.notes, hasAnalysis: false, readout: 0 };
    const { protocol } = assemble(cells, meta);
    expect(protocol.standardCurves).toEqual([]);
    expect(protocol.analysis).toBeUndefined();
    expect(isAssay(protocol.procedures[0]!)).toBe(false);
    expect(protocol.procedures[0]!.steps.map(s => s.stage)).toEqual(['load', 'incubate', 'observe']);
    expect(problems(protocol)).toEqual([]);
  });

  it('keeps a procedure read as nothing but reagent prep as its steps, and says so', () => {
    const all = parts();
    all.steps.steps = all.steps.steps.map(s => ({ ...s, before: true }));
    const { protocol, problems } = assemble(all, meta);
    expect(protocol.procedures[0]!.steps).toHaveLength(5);
    expect(protocol.procedures[0]!.prep).toBeUndefined();
    expect(problems).toContain('procedure plate: every step was reagent prep; kept as its steps');
  });

  it('refuses a manual with no steps at all', () => {
    const none = parts();
    none.steps.steps = [];
    expect(() => assemble(none, meta)).toThrow(UpstreamError);
  });
});

describe('the wire format', () => {
  it('is strict: every object closed and every field required', () => {
    const objects: Record<string, any>[] = [];
    const roots = new Set<unknown>();
    const walk = (s: any) => {
      if (s?.type === 'object') objects.push(s);
      for (const v of Object.values(s?.properties ?? {})) walk(v);
      if (s?.items) walk(s.items);
    };
    for (const [name, spec] of [['I', INVENTORY], ['S', STEPS], ['C', CURVES], ['N', NOTES]] as const) {
      const f = formatOf(name, spec);
      expect(f).toMatchObject({ type: 'json_schema', strict: true });
      roots.add(f.schema);
      walk(f.schema);
    }
    expect(objects.length).toBeGreaterThan(10);
    for (const o of objects) {
      expect(o.additionalProperties).toBe(false);
      expect([...o.required].sort()).toEqual(Object.keys(o.properties).sort());
      // Flat: a row holds only text, numbers, yes/no and lists of text.
      if (!roots.has(o)) for (const v of Object.values(o.properties) as any[]) expect(v.type === 'array' ? v.items.type : v.type).not.toBe('object');
    }
  });

  it('reads citations and amounts back from their text', () => {
    expect(parseCite('p3: Cover the plate and incubate')).toEqual({ page: 3, quote: 'Cover the plate and incubate', table: '', figure: '' });
    expect(parseCite('p2 table: Table 1')).toEqual({ page: 2, quote: '', table: 'Table 1', figure: '' });
    expect(parseCite('p1 figure: Fig. 1 Procedure summary')).toMatchObject({ page: 1, figure: 'Fig. 1 Procedure summary' });
    expect(parseCite('p2 Table 2')).toMatchObject({ page: 2, table: 'Table 2' });
    expect(parseCite('p4')).toEqual({ page: 4, quote: '', table: '', figure: '' });
    for (const c of [{ page: 3, quote: 'Add 200 µL of the WR', table: '', figure: '' }, { page: 2, quote: '', table: 'Contents and storage', figure: '' }]) expect(parseCite(citeText(c))).toEqual(c);
    expect(parseVolume('25 uL')).toEqual({ value: 25, unit: 'µL' });
    expect(parseVolume('0.1 mL')).toEqual({ value: 0.1, unit: 'mL' });
    expect(parseVolume('200 µl')).toEqual({ value: 200, unit: 'µL' });
    expect(parseVolume('a bit')).toBeNull();
    expect(parseVolume('0.03 mL (30 uL)')).toEqual({ value: 0.03, unit: 'mL' });
    expect(parseAmount('2 x 500 mL')).toEqual({ count: 2, amount: { value: 500, unit: 'mL' } });
    expect(parseAmount('10 × 1 mL')).toEqual({ count: 10, amount: { value: 1, unit: 'mL' } });
    expect(parseAmount('25 mL')).toEqual({ amount: { value: 25, unit: 'mL' } });
    expect(parseAmount('1 vial')).toEqual({ count: 1 });
    expect(parseAmount('')).toEqual({});
    expect(parseConcentration('2 mg/mL')).toEqual({ value: 2, unit: 'mg/mL' });
    expect(parseConcentration('2,000 ug/mL')).toEqual({ value: 2000, unit: 'µg/mL' });
    expect(parseRange('20-2000 ug/mL')).toEqual({ min: 20, max: 2000, unit: 'µg/mL' });
    expect(parseRange('20–2,000 µg/mL')).toEqual({ min: 20, max: 2000, unit: 'µg/mL' });
    expect(parseRange('5 to 250 ug/mL')).toEqual({ min: 5, max: 250, unit: 'µg/mL' });
    expect(parseRange('')).toBeNull();
    expect(parseTime('30 min')).toEqual({ value: 30, unit: 'min' });
    expect(parseTime('2 hours')).toEqual({ value: 2, unit: 'h' });
    expect(parseTime('30 s')).toEqual({ value: 30, unit: 's' });
    expect(parseTime('')).toBeNull();
    // Shown text keeps µ, even where the model wrote amounts the wire's way.
    expect(micro('25 uL sample + 200 uL of WR; 20–2,000 ug/mL')).toBe('25 µL sample + 200 µL of WR; 20–2,000 µg/mL');
    expect(micro('Mix until uniform')).toBe('Mix until uniform');
  });

  it('reads a reply in the earlier wire format as today\'s', () => {
    const old = {
      steps: [{ procedure: 'plate', id: 'p-inc', stage: 'incubate', title: 'Incubate', key: '37 °C', curve: '', mix: 'wr', equipment: [], timerLabel: 'Incubate', timerDuration: 30, timerUnit: 'min', timerTemperature: '37', covered: true, page: 2, quote: 'Incubate at 37°C.', table: '', figure: '' }],
      additions: [{ step: 'p-inc', what: 'mix', ref: 'wr', volume: 200, unit: 'uL', per: 'well' }],
      alternatives: [{ step: 'p-inc', label: 'Longer', duration: 2, unit: 'h', temperature: '37', rangeMin: 0, rangeMax: 0, rangeUnit: '', curve: '', page: 2, quote: '', table: 'Table 2', figure: '' }],
      notes: [],
    };
    expect(readWire(STEPS, renameLegacy('steps', old))).toEqual({
      // Read before reagent prep was asked for: every row is a step of the experiment.
      steps: [{ procedureId: 'plate', stepId: 'p-inc', before: false, stage: 'incubate', title: 'Incubate', key: '37 °C', makes: 'wr', equipment: [], cite: 'p2: Incubate at 37°C.' }],
      timers: [{ stepId: 'p-inc', label: 'Incubate', time: '30 min', temperature: '37', covered: true }],
      additions: [{ stepId: 'p-inc', what: 'mix', ref: 'wr', volume: '200 uL', per: 'well' }],
      alternatives: [{ stepId: 'p-inc', label: 'Longer', time: '2 h', temperature: '37', range: '', curve: '', cite: 'p2 table: Table 2' }],
      notes: [],
    });
    const today = parts().steps;
    expect(renameLegacy('steps', today)).toBe(today);
  });

  it('reads temperatures, slugs and PDFs', () => {
    expect(parseTemperature('37')).toEqual({ value: 37, unit: '°C' });
    expect(parseTemperature('15–30 °C')).toEqual({ value: 15, max: 30, unit: '°C' });
    expect(parseTemperature('−20ºC')).toEqual({ value: -20, unit: '°C' });
    expect(parseTemperature('room temperature')).toBeNull();
    expect(parseTemperature('')).toBeNull();
    expect(slug('Pierce™ BCA Protein Assay')).toBe('pierce-bca-protein-assay');
    const fake = new TextEncoder().encode('%PDF-1.7\n1 0 obj << /Type /Pages /Count 2 >>\n2 0 obj << /Type /Page >>\n3 0 obj << /Type/Page >>');
    expect(isPdf(fake)).toBe(true);
    expect(countPages(fake)).toBe(2);
    expect(isPdf(new TextEncoder().encode('<html>'))).toBe(false);
  });
});

/**
 * A fake /responses endpoint answering each call from `replies` (by its text.format name), and what it was sent. With
 * `files`, it also takes an upload (POST /files → file-1) and its deletion; without, it has no Files API (404). With
 * `tokens`, it counts input (POST /responses/input_tokens).
 */
function fakeMeta(replies: Record<string, unknown>, { files = false, tokens = 0 } = {}) {
  const sent: { name: string; body: any; at: number }[] = [];
  const other: string[] = [];
  let clock = 0;
  const fetch = (async (url: string, init: RequestInit) => {
    if (url.endsWith('/files')) {
      other.push(`upload ${(init.body as FormData).get('purpose')} ${(init.body as FormData).get('expires_after[seconds]')}`);
      return files ? new Response(JSON.stringify({ id: 'file-1', object: 'file' })) : new Response('{"error":{"message":"not found"}}', { status: 404 });
    }
    if (init.method === 'DELETE') {
      other.push(`delete ${url.split('/').pop()}`);
      return new Response('{}');
    }
    if (url.endsWith('/responses/input_tokens')) {
      other.push('count');
      return new Response(JSON.stringify({ object: 'response.input_tokens', input_tokens: tokens }));
    }
    const body = JSON.parse(String(init.body));
    const name = body.text.format.name as string;
    sent.push({ name, body, at: clock++ });
    const reply = replies[name];
    if (reply instanceof Response) return reply;
    const output = [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(reply) }] }];
    return new Response(JSON.stringify({ status: 'completed', output }), { status: 200 });
  }) as typeof globalThis.fetch;
  return { fetch, sent, other };
}

const PDF = new TextEncoder().encode('%PDF-1.7\n<< /Type /Page >>\n<< /Type /Page >>\n%%EOF');

describe('importProtocol', () => {
  const p = parts();
  const replies = { ChappIntro: intro(), ChappInventory: p.inventory, ChappSteps: p.steps, ChappCurves: p.curves, ChappNotes: p.notes };

  it('asks for the intro and the inventory at once, then the rest with the inventory ids, and returns a checked protocol', async () => {
    const { fetch, sent } = fakeMeta(replies);
    const lines: string[] = [];
    const logs: string[] = [];
    const heard: ProtocolIntro[] = [];
    const out = await importProtocol(PDF, { url: 'https://demo.example/m.pdf' }, { apiKey: 'sk-test', fetch, log: l => logs.push(l), onProgress: l => lines.push(l), onIntro: i => heard.push(i) });
    expect(sent.slice(0, 2).map(s => s.name)).toEqual(['ChappIntro', 'ChappInventory']);
    expect(sent.slice(2).map(s => s.name).sort()).toEqual(['ChappCurves', 'ChappNotes', 'ChappSteps']);
    // Every call thinks as little as it can (measured on the BCA manual: still 48 of 49); the steps need low, or the
    // 30 s shake can pass for the 37 °C incubation.
    expect(Object.fromEntries(sent.map(s => [s.name, s.body.reasoning.effort]))).toEqual({
      ChappIntro: 'minimal', ChappInventory: 'minimal', ChappSteps: 'low', ChappCurves: 'minimal', ChappNotes: 'minimal',
    });
    const first = sent[1]!.body;
    expect(first.model).toBe('muse-spark-1.3');
    expect(first.input[1].content[0]).toMatchObject({ type: 'input_file', file_data: expect.stringMatching(/^data:application\/pdf;base64,/) });
    expect(sent.find(s => s.name === 'ChappSteps')!.body.input[1].content[1].text).toContain('"id":"Reagent A"');
    expect(out.protocol.source).toMatchObject({ url: 'https://demo.example/m.pdf', pages: 2 });
    expect(out.sources).toEqual([{ url: 'https://demo.example/m.pdf', title: 'Demo Assay Kit Manual' }]);
    expect(lines).toEqual(['Reading the manual', 'Turning it into steps']);
    // What the kit is was heard first, and is what the protocol says: the Overview's words do not change.
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({ title: 'Demo Assay', kit: { catalogs: ['D100'] }, source: { url: 'https://demo.example/m.pdf', publisher: 'Demo Bio' } });
    // What the summary says the user will see stays apart from its steps.
    expect(heard[0]!.overview).toEqual({ steps: intro().overviewSteps, expected: ['Wells turn yellow'], cite: { page: 1, figure: 'Fig. 1 Procedure summary' } });
    expect([out.protocol.title, out.protocol.summary, out.protocol.overview.steps, out.protocol.overview.expected]).toEqual([
      heard[0]!.title,
      heard[0]!.summary,
      heard[0]!.overview.steps,
      heard[0]!.overview.expected,
    ]);
    // Timings only: nothing from the manual or the key in the log.
    expect(logs.join('\n')).not.toMatch(/sk-test|Reagent|Demo/);
  });

  it('sends the manual as text to every call but the intro, when it has text', async () => {
    const { fetch, sent } = fakeMeta(replies);
    await importProtocol(PDF, {}, { apiKey: 'k', fetch, log: () => {}, textOf: () => '--- Page 1 ---\nDemo manual text' });
    const got = Object.fromEntries(sent.map(s => [s.name, s.body.input[1].content[0]]));
    for (const call of ['ChappInventory', 'ChappSteps', 'ChappCurves', 'ChappNotes']) expect(got[call]).toEqual({ type: 'input_text', text: 'The manual, page by page:\n\n--- Page 1 ---\nDemo manual text' });
    // The at-a-glance summary is often a picture: the intro reads the PDF itself.
    expect(got.ChappIntro).toMatchObject({ type: 'input_file' });
    // No text (a scanned manual, or no pdftotext): the PDF for all.
    const none = fakeMeta(replies);
    await importProtocol(PDF, {}, { apiKey: 'k', fetch: none.fetch, log: () => {}, textOf: () => null });
    expect(none.sent.every(s => s.body.input[1].content[0].type === 'input_file')).toBe(true);
  });

  it('gives every call on one manual the same cache key, so the rules and the manual they share can be reused', async () => {
    const { fetch, sent } = fakeMeta(replies);
    await importProtocol(PDF, {}, { apiKey: 'k', fetch, log: () => {}, textOf: () => '--- Page 1 ---\nDemo manual text' });
    const keys = new Set(sent.map(s => s.body.prompt_cache_key));
    expect([...keys]).toEqual([expect.stringMatching(/^chapp-manual-[0-9a-f]{16}$/)]);
    expect(sent.every(s => s.body.prompt_cache_retention === '24h')).toBe(true);
    // The shared part comes first: the rules, then the manual; each call's own task last.
    expect(sent.every(s => s.body.input[0].role === 'system' && s.body.input[1].content.at(-1).type === 'input_text')).toBe(true);
  });

  it('uploads a scanned manual once for all its calls, and deletes it once read; a manual with text goes inline', async () => {
    const scanned = fakeMeta(replies, { files: true });
    await importProtocol(PDF, {}, { apiKey: 'k', fetch: scanned.fetch, log: () => {}, textOf: () => null });
    expect(scanned.sent.map(s => s.body.input[1].content[0])).toEqual(scanned.sent.map(() => ({ type: 'input_file', file_id: 'file-1' })));
    await new Promise(r => setTimeout(r, 0));
    expect(scanned.other).toEqual(['upload user_data 3600', 'delete file-1']);
    // Only the intro takes the PDF: no upload.
    const text = fakeMeta(replies, { files: true });
    await importProtocol(PDF, {}, { apiKey: 'k', fetch: text.fetch, log: () => {}, textOf: () => '--- Page 1 ---\nDemo manual text' });
    expect(text.other).toEqual([]);
    expect(text.sent.find(s => s.name === 'ChappIntro')!.body.input[1].content[0]).toMatchObject({ file_data: expect.stringMatching(/^data:application\/pdf;base64,/) });
    // An upload the API refuses: inline, as before.
    const refused = fakeMeta(replies);
    await importProtocol(PDF, {}, { apiKey: 'k', fetch: refused.fetch, log: () => {}, textOf: () => null });
    expect(refused.sent.every(s => s.body.input[1].content[0].file_data)).toBe(true);
  });

  it('with a daily cap, counts the manual first and refuses a read that would pass it', async () => {
    try {
      meter.setCap(0.5);
      // About 5 × 20,000 tokens of input plus the output: well under $0.50.
      const small = fakeMeta(replies, { tokens: 20_000 });
      await importProtocol(PDF, {}, { apiKey: 'k', fetch: small.fetch, log: () => {}, textOf: () => '--- Page 1 ---\nDemo manual text' });
      expect(small.other).toEqual(['count', 'count']);
      expect(small.sent).toHaveLength(5);
      // 5 × 200,000 tokens is $1.25 before it writes a word: nothing is read.
      const big = fakeMeta(replies, { tokens: 200_000 });
      const error = await importProtocol(PDF, {}, { apiKey: 'k', fetch: big.fetch, log: () => {}, textOf: () => '--- Page 1 ---\nDemo manual text' }).catch(e => e);
      expect(error).toBeInstanceOf(UpstreamError);
      expect(error.message).toMatch(/past today's allowance/);
      expect(big.sent).toEqual([]);
    } finally {
      meter.setCap(0);
    }
  });

  it('reads the protocol all the same when the intro fails, in the deep read\'s own words', async () => {
    const { fetch } = fakeMeta({ ...replies, ChappIntro: new Response('{"error":{"message":"busy"}}', { status: 429 }) });
    const heard: ProtocolIntro[] = [];
    const out = await importProtocol(PDF, {}, { apiKey: 'k', fetch, log: () => {}, onIntro: i => heard.push(i) });
    expect(heard).toEqual([]);
    expect(out.protocol.summary).toBe(p.notes.summary);
    expect(out.protocol.overview.steps).toEqual(p.notes.overviewSteps);
    // The deep read gave no expected results: none, rather than an empty list.
    expect(out.protocol.overview).not.toHaveProperty('expected');
  });

  it('skips the dilution call for a kit without standards', async () => {
    const cells = { ...replies, ChappInventory: { ...p.inventory, curves: [] } };
    const { fetch, sent } = fakeMeta(cells);
    const out = await importProtocol(PDF, {}, { apiKey: 'k', fetch, log: () => {} });
    expect(sent.map(s => s.name)).not.toContain('ChappCurves');
    expect(out.protocol.standardCurves).toEqual([]);
    expect(out.sources).toEqual([]);
  });

  it('turns a failed call into an UpstreamError without the key', async () => {
    const { fetch } = fakeMeta({ ...replies, ChappInventory: new Response(JSON.stringify({ error: { message: 'bad key sk-secret' } }), { status: 401 }) });
    const error = await importProtocol(PDF, {}, { apiKey: 'sk-secret', fetch, log: () => {} }).catch(e => e);
    expect(error).toBeInstanceOf(UpstreamError);
    expect(error.message).toContain('401');
    expect(error.message).not.toContain('sk-secret');
  });

  it('refuses what is not a PDF', async () => {
    await expect(importProtocol(new TextEncoder().encode('hello'), {}, { apiKey: 'k', fetch: fakeMeta(replies).fetch, log: () => {} })).rejects.toThrow('not a PDF');
  });
});

// Replays of the live imports kept in data/smoke/import/ (git-ignored), when they are on this machine.
function replay(name: string) {
  const dir = new URL(`../data/smoke/import/${name}/`, import.meta.url);
  const read = (call: string) => JSON.parse(readFileSync(new URL(`${call}.json`, dir), 'utf8')).reply;
  const has = ['inventory', 'steps', 'notes'].every(c => existsSync(new URL(`${c}.json`, dir)));
  const fetch = (async (_url: string, init: RequestInit) => {
    const call = JSON.parse(String(init.body)).text.format.name.replace('Chapp', '').toLowerCase();
    return new Response(JSON.stringify(read(call)), { status: 200 });
  }) as typeof globalThis.fetch;
  return { has, fetch };
}

const bcaPdf = new URL('../data/sources/pierce-bca/MAN0011430_Pierce_BCA_Protein_Asy_UG.pdf', import.meta.url);
const bcaGold = new URL('../data/protocols/pierce-bca.json', import.meta.url);
const bca = replay('pierce-bca');

describe.skipIf(!bca.has || !existsSync(bcaPdf) || !existsSync(bcaGold))('the BCA manual, as Muse Spark read it', () => {
  it('matches the hand-made protocol on the numbers the bench depends on', async () => {
    const pdf = new Uint8Array(readFileSync(bcaPdf));
    const heard: ProtocolIntro[] = [];
    const { protocol } = await importProtocol(pdf, { url: 'https://documents.thermofisher.com/TFS-Assets/LSG/manuals/MAN0011430_Pierce_BCA_Protein_Asy_UG.pdf' }, { apiKey: 'k', fetch: bca.fetch, log: () => {}, onIntro: i => heard.push(i) });
    const gold = Protocol.parse(JSON.parse(readFileSync(bcaGold, 'utf8')));
    // The fast intro already had the kit and the manual's own at-a-glance lines right.
    expect(heard[0]).toMatchObject({ title: 'Pierce BCA Protein Assay', overview: { steps: gold.overview.steps, cite: { page: 1 } } });
    const checks = compareProtocols(gold, protocol);
    const must = (what: RegExp) => checks.filter(c => what.test(c.what));
    for (const c of [...must(/Working Reagent 50:1/), ...must(/^microplate (sample|working reagent) per well/), ...must(/^microplate incubation$/), ...must(/^readout/), ...must(/^Standard range vial/)]) {
      expect(c, c.what).toMatchObject({ ok: true });
    }
    expect(protocol.source.sha256).toBe(gold.source.sha256);
  });
});

const abcamPdf = new URL('../data/sources/abcam-ab287843/ab287843-protocol-v5a.pdf', import.meta.url);
const abcam = replay('abcam-ab287843');

describe.skipIf(!abcam.has || !existsSync(abcamPdf))('the Abcam 3T3-L1 kit, as Muse Spark read it', () => {
  it('is a cell protocol with every number the manual prints, and no plate, standards or readout', async () => {
    const pdf = new Uint8Array(readFileSync(abcamPdf));
    const { protocol: p, problems: found } = await importProtocol(pdf, {}, { apiKey: 'k', fetch: abcam.fetch, log: () => {} });
    expect(found).toEqual([]);
    expect(p.source).toMatchObject({ publisher: 'Abcam', docId: 'ab287843', date: '2025-06-19', pages: 1 });
    expect(p.standardCurves).toEqual([]);
    expect(p.analysis).toBeUndefined();
    expect(p.procedures.every(x => x.format === 'cells' && !isAssay(x))).toBe(true);
    // The kit: 600 µL insulin, one vial of cocktail, 0.5 mL DMSO I, all at −20 °C.
    const contents = p.kit.variants[0]!.contents.map(c => [c.component, c.amount ? `${c.amount.value} ${c.amount.unit}` : 'vial']);
    expect(contents).toEqual(expect.arrayContaining([[expect.stringMatching(/insulin/), '600 µL'], [expect.stringMatching(/dmso/), '0.5 mL'], [expect.stringMatching(/cocktail/), 'vial']]));
    expect(p.components.filter(c => c.suppliedBy === 'kit').map(c => c.storage)).toEqual(Array(3).fill({ value: -20, unit: '°C' }));
    // Both media: 1 µL in 1 mL.
    expect(p.mixes.map(m => m.parts.map(x => x.parts).sort((a, b) => a - b))).toEqual([[1, 1000], [1, 1000]]);
    // 48 h, then 3 days (72 h) at 37 °C.
    const timers = p.procedures.flatMap(x => x.steps).flatMap(s => (s.timer ? [`${s.timer.duration.value} ${s.timer.duration.unit}${s.timer.temperature ? ` ${s.timer.temperature.value} °C` : ''}`] : []));
    expect(timers).toEqual(expect.arrayContaining(['48 h', '72 h 37 °C']));
    const keys = p.procedures.flatMap(x => x.steps).map(s => s.key).join('\n');
    for (const fact of ['80%', '110 µL', '2-3 days', '7-10 days']) expect(keys).toContain(fact);
  });
});
