import { describe, expect, it } from 'vitest';
import { isPlannable } from '../shared/calc.ts';
import { Protocol, type Procedure } from '../shared/protocol.ts';
import { answerFromManual, protocolBrief } from '../server/ai/protocols.ts';
import { problems } from '../shared/protocol.ts';
import { prepLines, startPath, stepLines } from '../src/screens/protocol/content.ts';
import { endsText, followNote, followSteps, leftText, prepItems } from '../src/screens/run/follow.ts';

// Following a protocol Chapp cannot plan (src/screens/run/follow.ts), and what the user should see kept apart from
// what to do: on the protocol's step cards and in what Chapp is told. A small cell protocol, made up here.
const cite = (quote: string) => ({ page: 1, quote });
const cells = Protocol.parse({
  format: 'chapp.protocol/1',
  id: 'cells',
  title: 'Demo Differentiation',
  summary: 'Cell differentiation: preadipocytes become adipocytes. Lipid droplets by day 7–10.',
  source: { title: 'Demo manual', publisher: 'Demo Bio', docId: 'D1', revision: '1', date: '', url: 'https://demo.example/m.pdf', sha256: 'a'.repeat(64), pages: 1, fetchedAt: '2026-10-29T00:00:00.000Z' },
  kit: { name: 'Demo Kit', vendor: 'Demo Bio', variants: [{ catalog: 'D1', scale: '', contents: [{ component: 'insulin' }] }], cite: cite('Kit contents') },
  overview: {
    procedure: 'diff',
    steps: ['Grow to 80% confluence', 'Replace with differentiation medium'],
    expected: ['Visible lipid droplets 7-10 days after differentiation medium'],
    cite: cite('To initiate differentiation'),
  },
  components: [{ id: 'insulin', name: 'Insulin', role: 'reagent', suppliedBy: 'kit', cite: cite('Insulin') }],
  equipment: [],
  mixes: [],
  standardCurves: [],
  procedures: [
    {
      id: 'diff',
      name: 'Differentiation',
      format: 'cells',
      prep: [
        { id: 'warm-insulin', stage: 'prepare', title: 'Warm Insulin', key: 'Warm Insulin to room temperature', cite: cite('Warm to room temperature before use') },
        {
          id: 'make-cocktail',
          stage: 'prepare',
          title: 'Reconstitute the cocktail',
          key: 'Reconstitute the Differentiation Cocktail in 110 µL DMSO',
          notes: [{ kind: 'tip', text: 'Aliquot the rest and keep it at -20 °C.', cite: cite('Aliquot the spare') }],
          cite: cite('Reconstitute in 110 µl DMSO I'),
        },
      ],
      steps: [
        { id: 'grow', stage: 'prepare', title: 'Grow to 80%', key: 'Grow cells to ~80% confluence', cite: cite('culture cells until ~80% confluent') },
        {
          id: 'induce',
          stage: 'incubate',
          title: 'Incubate 3 days',
          key: 'Incubate 72 h at 37°C',
          timer: { label: 'Incubate', duration: { value: 72, unit: 'h' }, temperature: { value: 37, unit: '°C' } },
          notes: [
            { kind: 'info', text: 'Some FBS lots work better.', cite: cite('screen several lots of FBS') },
            { kind: 'expected', text: 'Lipid droplets show 7-10 days after differentiation medium.', cite: cite('Lipid droplet accumulation will be visible') },
            { kind: 'caution', text: 'Do not let them overgrow.', cite: cite('Do not allow cultures to become confluent') },
          ],
          cite: cite('Incubate for 3 days'),
        },
      ],
      cite: cite('culture cells until ~80% confluent'),
    },
  ],
  defaults: { procedure: 'diff' },
  notes: [],
});
const proc = cells.procedures[0]!;

describe('following a protocol Chapp cannot plan', () => {
  it('is any protocol without standards and a plate to work out', () => {
    expect(isPlannable(cells, proc)).toBe(false);
  });

  it('gives each step what to do, its timer, what to see and the manual’s notes, cautions first', () => {
    const [grow, induce] = followSteps(proc);
    expect(grow).toMatchObject({ key: 'Grow cells to ~80% confluence', timer: null, expected: [], notes: [] });
    expect(induce).toMatchObject({
      timer: { label: 'Incubate', seconds: 72 * 3600, temperature: '37 °C', covered: false },
      expected: ['Lipid droplets show 7-10 days after differentiation medium.'],
      notes: [
        { kind: 'caution', text: 'Do not let them overgrow.' },
        { kind: 'info', text: 'Some FBS lots work better.' },
      ],
    });
  });

  it('says why only for an assay whose amounts it cannot convert', () => {
    expect(followNote(cells, proc)).toBeNull();
    const assay: Procedure = { ...proc, format: 'microplate', ratio: '1:1', sample: { value: 50, unit: 'µL' }, mixPerSample: { value: 50, unit: 'µL' }, mix: 'm', standardCurve: 'c', range: { min: 1, max: 500, unit: '%' } };
    expect(followNote(cells, assay)).toBe('I can’t work out this run’s amounts (the working range is in %), so every number here is the manual’s, as printed.');
  });

  it('counts down in minutes within the hour, and in hours past it', () => {
    expect(leftText(1477)).toBe('24:37');
    expect(leftText(0)).toBe('0:00');
    expect(leftText(47 * 3600 + 12 * 60 + 5)).toBe('47 h 12 min');
    expect(leftText(3 * 3600)).toBe('3 h');
  });

  it('says the day when a timer ends on another day', () => {
    const now = new Date(2026, 9, 29, 9, 0).getTime();
    expect(endsText(new Date(2026, 9, 29, 14, 5).getTime(), now)).toBe('14:05');
    expect(endsText(new Date(2026, 10, 1, 9, 0).getTime(), now)).toBe('Sun 09:00');
  });
});

describe('reagent prep, apart from the experiment’s steps', () => {
  it('is not counted or shown among the steps', () => {
    expect(stepLines(cells).map(s => s.id)).toEqual(['grow', 'induce']);
    expect(prepLines(cells).map(s => [s.title, s.text])).toEqual([
      ['Warm Insulin', 'Warm Insulin to room temperature'],
      ['Reconstitute the cocktail', 'Reconstitute the Differentiation Cocktail in 110 µL DMSO'],
    ]);
    expect(followSteps(proc).map(s => s.id)).toEqual(['grow', 'induce']);
    expect(prepItems(proc)).toMatchObject([{ id: 'warm-insulin', notes: [] }, { id: 'make-cocktail', notes: [{ kind: 'tip' }] }]);
  });

  it('comes first when a run starts, and not once it is under way', () => {
    expect(startPath(cells, 'diff', false)).toBe('/run/prep');
    expect(startPath(cells, 'diff', true)).toBe('/run/1');
    const none = { ...cells, procedures: [{ ...proc, prep: undefined }] };
    expect(startPath(none, 'diff', false)).toBe('/run/1');
  });

  it('is checked like the steps, and told to Chapp as prep', () => {
    const bad = { ...cells, procedures: [{ ...proc, prep: [{ ...proc.prep![0]!, equipment: ['vortex'] }] }] };
    expect(problems(bad)).toEqual(['step warm-insulin refers to unknown id "vortex"']);
    const brief = protocolBrief(cells, { screen: 'run-prep' });
    expect(brief).toContain('Reagent prep, done before the experiment and not one of its steps (id, title, what to do, page):\n- warm-insulin, Warm Insulin: Warm Insulin to room temperature (p.1)');
    expect(brief).toMatch(/Steps \(index: id, title, what to do, page\):\n0: grow,/);
    expect(brief).toContain('The user is on reagent prep, getting the reagents ready before step 1.');
    expect(answerFromManual(cells, 'how much DMSO for the cocktail?')?.source.quote).toBe('Reconstitute in 110 µl DMSO I');
  });
});

describe('what the user should see, apart from what to do', () => {
  it('rides with its step on the protocol’s step cards', () => {
    expect(stepLines(cells).map(s => s.expected)).toEqual([[], ['Lipid droplets show 7-10 days after differentiation medium.']]);
  });

  it('is told to Chapp as a result to look for, not a step', () => {
    const brief = protocolBrief(cells, { screen: 'protocol' });
    expect(brief).toContain('- induce (what the user should see), p.1: Lipid droplets show 7-10 days after differentiation medium.');
    expect(brief).toContain('Expected result (not a step): Visible lipid droplets 7-10 days after differentiation medium (p.1).');
    expect(brief).not.toMatch(/^\d+: .*lipid/im);
  });
});
