import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { standardSeries } from '../shared/calc.ts';
import { analyzePlate, sampleReadings } from '../shared/fit.ts';
import { Protocol } from '../shared/protocol.ts';
import {
  benchSteps,
  commonRows,
  concentrationRows,
  countdownText,
  halvingSeries,
  lengthText,
  massRows,
  plateMap,
  reagentPlan,
  samplesThatFit,
  shadeLevels,
  stepDetail,
  stepLabel,
  vialLabel,
  vialRecipe,
  vialRange,
  vialSay,
  wellRoles,
} from '../src/components/lab/model.ts';

// The bench parts' numbers, checked against what the design artboards show for the storyboard's run.
const file = new URL('../data/protocols/pierce-bca.json', import.meta.url);
const local = existsSync(file);
const bca = local ? Protocol.parse(JSON.parse(readFileSync(file, 'utf8'))) : null;

const nine = 'ABCDEFGHI'.split('').map((id, i) => ({ id, concentration: [2000, 1500, 1000, 750, 500, 250, 125, 25, 0][i]!, blank: id === 'I' }));

describe('shades', () => {
  it('spreads the kit’s 9 over all eight blues, darkest first, and leaves the blank white', () => {
    expect(shadeLevels(nine)).toEqual([8, 7, 6, 5, 4, 3, 2, 1, 0]);
  });

  it('skips blues for five standards, as Plan-Heard draws them', () => {
    const five = halvingSeries(2000, 4, 1, 25).vials;
    expect(shadeLevels(five)).toEqual([8, 6, 3, 1, 0]);
  });
});

describe('vials', () => {
  const v = (from: string | null, take: number, diluent: number, blank = false) => ({ id: 'X', concentration: 1, blank, from, take, diluent, left: 0 });
  it('says each vial the way the cards and Chapp do', () => {
    expect(vialRecipe(v('stock', 120, 0))).toEqual(['Stock 120', 'Diluent 0']);
    expect(vialRecipe(v('B', 70, 70))).toEqual(['From B 70', 'Diluent 70']);
    expect(vialRecipe(v(null, 0, 160, true))).toEqual(['Diluent 160', 'Blank']);
    expect(vialSay(v('stock', 120, 0))).toEqual(['120 µL of stock', 'no diluent']);
    expect(vialSay(v('B', 70, 70))).toEqual(['70 µL from B', '70 µL of diluent']);
    expect(vialSay(v(null, 0, 160, true))).toEqual(['160 µL of diluent', 'nothing else']);
  });

  it('labels a standard on the series’ scale and a working dilution as the manual prints it', () => {
    expect(vialLabel({ ...v('1', 6, 144), concentration: 2 }, 'nmol/well')).toEqual(['2', 'nmol/well']);
    expect(vialLabel({ ...v('stock', 10, 90), concentration: 50, intermediate: true, printed: { value: 1, unit: 'mM' } }, 'nmol/well')).toEqual(['1', 'mM']);
    // One the app made itself has nothing printed, so it stays on the scale.
    expect(vialLabel({ ...v('stock', 10, 90), concentration: 50, intermediate: true }, 'nmol/well')).toEqual(['50', 'nmol/well']);
  });

  it('halves from 2,000: five standards once (Plan-Heard: 100 µL BSA and 200 µL diluent, each vial keeps 50 µL)', () => {
    const s = halvingSeries(2000, 4, 1, 25);
    expect(s.vials.map(x => [x.id, x.concentration, x.from, x.take, x.diluent])).toEqual([
      ['A', 2000, 'stock', 100, 0],
      ['B', 1000, 'A', 50, 50],
      ['C', 500, 'B', 50, 50],
      ['D', 250, 'C', 50, 50],
      ['E', 0, null, 0, 50],
    ]);
    expect([s.stock, s.diluent, s.minLeft, s.need]).toEqual([100, 200, 50, 25]);
  });
});

describe('vials named together', () => {
  const five = 'ABCDE'.split('').map(id => ({ id }));
  it('ticks a range, both ends included, however it is said', () => {
    for (const said of ['B-E', 'B–E', 'b to e', 'B through E', 'B..E', 'B到E', 'B 至 E']) expect(vialRange(said, five)).toEqual(['B', 'C', 'D', 'E']);
    expect(vialRange('E-B', five)).toEqual(['B', 'C', 'D', 'E']);
  });
  it('ticks a list, in the series order', () => {
    expect(vialRange('D, B and C', five)).toEqual(['B', 'C', 'D']);
    expect(vialRange('A、C', five)).toEqual(['A', 'C']);
  });
  it('leaves one vial, and a vial the run lacks, to the usual check', () => {
    expect(vialRange('A', five)).toBeNull();
    expect(vialRange('B-G', five)).toBeNull();
    expect(vialRange('S1', five)).toBeNull();
  });
});

describe('plate', () => {
  const plan = plateMap({ standards: nine, standardReplicates: 2, samples: 12, sampleReplicates: 2 });

  it('puts replicates side by side, standards first, in two-column blocks (Run-Load)', () => {
    expect(plan.wells).toBe(42);
    expect(plan.tubes).toHaveLength(21);
    expect(plan.tubes[0]!.wells).toEqual(['A1', 'A2']);
    expect(plan.tubes[7]!.wells).toEqual(['H1', 'H2']);
    expect(plan.tubes[8]).toMatchObject({ name: 'Standard I', blank: true, wells: ['A3', 'A4'] });
    // "Tube 10 of 21. Sample 1 → B3 · B4"
    expect(plan.tubes[9]).toMatchObject({ name: 'Sample 1', wells: ['B3', 'B4'] });
    expect(plan.tubes[20]!.wells).toEqual(['E5', 'E6']);
    expect(plan.columns).toBe(6);
  });

  it('starts a new block when the samples’ replicates differ from the standards’ (Plan-Heard: 41 wells)', () => {
    const five = halvingSeries(2000, 4, 1, 25).vials;
    const p = plateMap({ standards: five, standardReplicates: 1, samples: 12, sampleReplicates: 3 });
    expect(p.wells).toBe(41);
    expect(p.tubes[4]!.wells).toEqual(['E1']);
    expect(p.tubes[5]!.wells).toEqual(['A2', 'A3', 'A4']);
    expect(p.tubes[16]!.wells).toEqual(['D5', 'D6', 'D7']);
    expect(p.fits).toBe(true);
  });

  it('knows how many samples fit beside the standards', () => {
    expect(samplesThatFit(nine, 2, 2)).toBe(39);
    const over = plateMap({ standards: nine, standardReplicates: 2, samples: 40, sampleReplicates: 2 });
    expect(over.fits).toBe(false);
  });

  it('turns into well roles for the analysis', () => {
    const roles = wellRoles(plan);
    expect(roles.find(r => r.well === 'A3')).toEqual({ well: 'A3', kind: 'standard', ref: 'I', concentration: 0, blank: true });
    expect(roles.find(r => r.well === 'B4')).toEqual({ well: 'B4', kind: 'sample', ref: '1' });
  });
});

describe('time', () => {
  it('formats the timer as the design does', () => {
    expect(countdownText(1477)).toBe('24:37');
    expect(countdownText(65)).toBe('1:05');
    expect(lengthText(1800)).toBe('30 min');
    expect(lengthText(7200)).toBe('2 h');
    expect(stepLabel(2, 6, 'Load the plate')).toBe('Step 3 of 6 · Load the plate');
  });
});

describe.skipIf(!local)('the BCA run, as the artboards show it', () => {
  const p = bca!;

  it('sizes the kit’s 9 for duplicates as on Run-Standards (2/5 of the table)', () => {
    const s = standardSeries(p, 'microplate', 2);
    expect(s.vials.map(vialRecipe)).toEqual([
      ['Stock 120', 'Diluent 0'], ['Stock 150', 'Diluent 50'], ['Stock 130', 'Diluent 130'],
      ['From B 70', 'Diluent 70'], ['From C 130', 'Diluent 130'], ['From E 130', 'Diluent 130'],
      ['From F 130', 'Diluent 130'], ['From G 40', 'Diluent 160'], ['Diluent 160', 'Blank'],
    ]);
    // Standards-2: 400 µL of BSA and 960 µL of diluent.
    expect([s.stock, s.diluent]).toEqual([400, 960]);
  });

  it('makes 10.1 mL of working reagent for 42 wells (20 % spare) at exactly 50:1, as the manual says: 9.9 mL A and 198 µL B', () => {
    const r = reagentPlan(p, 'microplate', 42);
    expect([r.need, r.make, r.ratio]).toEqual([8400, 10100, '50 : 1']);
    expect(r.parts.map(x => [x.name, x.volume])).toEqual([['Reagent A', 9900], ['Reagent B', 198]]);
    // 20 % over the need, to 0.1 mL: 41 wells 9.8 mL, triplicates (63 wells) 15.1 mL, the five-standard plan (18) 4.3 mL.
    expect(reagentPlan(p, 'microplate', 41).make).toBe(9800);
    expect(reagentPlan(p, 'microplate', 63).make).toBe(15100);
    expect(reagentPlan(p, 'microplate', 18).parts.map(x => x.volume)).toEqual([4200, 84]);
  });

  it('lists the six bench steps with Run-List’s details', () => {
    const steps = benchSteps(p, 'microplate');
    expect(steps.map(s => [s.title, stepDetail(p, s, { vials: 9, reagent: 10000, tubes: 21, loaded: 9 })])).toEqual([
      ['Standards', '9 vials'],
      ['Working reagent', '10 mL'],
      ['Load the plate', '9 of 21 tubes'],
      ['Add the reagent', '200 µL · shake 30 s'],
      ['Incubate', '37 °C · 30 min'],
      ['Read', '562 nm'],
    ]);
  });

  it('reads the built-in sample data back as Results-Swipe shows it', () => {
    const s = standardSeries(p, 'microplate', 2);
    const plan = plateMap({ standards: s.vials, standardReplicates: 2, samples: 12, sampleReplicates: 2 });
    const roles = wellRoles(plan);
    const a = analyzePlate(roles, sampleReadings(roles, p.analysis!.fit), p.analysis!.fit);
    expect(a.fit.kind).toBe('4pl');
    expect(a.fit.r2.toFixed(3)).toBe('0.999');
    expect(concentrationRows(a).map(r => `${r.value} ${r.side}`)).toEqual([
      '1,240 3 %', '860 5 %', '1,510 2 %', '420 7 %', '980 4 %', '1,130 3 %',
      '> 2,000 —', '650 6 %', '1,370 2 %', '740 4 %', '1,050 3 %', '590 8 %',
    ]);
    expect(a.samples[6]).toMatchObject({ flag: 'above', dilution: 5 });
    const m = massRows(a, 20);
    expect(m.most).toMatchObject({ ref: '4' });
    expect(m.most!.volume.toFixed(1)).toBe('47.6');
    expect(m.lane).toBe(50);
    expect(m.rows[6]).toMatchObject({ value: 'rerun', note: true });
    const c = commonRows(a)!;
    expect([c.target, c.lowest]).toEqual([400, '4']);
  });
});
