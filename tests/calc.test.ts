import { describe, expect, it } from 'vitest';
import type { Protocol } from '../shared/protocol.ts';
import { existsSync, readFileSync } from 'node:fs';
import { isPlannable, plateLayout, standardSeries, unitOf, unitsProblem, workingReagent } from '../shared/calc.ts';
import { Protocol as ProtocolSchema } from '../shared/protocol.ts';

// A made-up series small enough to check by hand, so the sizing rule is tested even without the
// vendor data in data/. Only the parts calc.ts reads are filled in.
const uL = (value: number) => ({ value, unit: 'µL' });
const doc = {
  procedures: [{ id: 'plate', sample: uL(25), mixPerSample: uL(200), mix: 'wr', standardCurve: 'curve' }],
  mixes: [{ id: 'wr', parts: [] }],
  standardCurves: [{
    id: 'curve',
    stock: 'bsa',
    diluent: 'buffer',
    points: [
      { id: 'A', from: 'stock', take: uL(200), diluent: uL(0), concentration: { value: 1, unit: 'mg/mL' } },
      { id: 'B', from: 'A', take: uL(100), diluent: uL(100), concentration: { value: 500, unit: 'µg/mL' } },
      { id: 'C', from: null, take: uL(0), diluent: uL(150), concentration: { value: 0, unit: 'µg/mL' }, blank: true },
    ],
  }],
} as unknown as Protocol;

describe('standardSeries', () => {
  it('scales by the smallest fifth that leaves every vial its replicates plus one spare well', () => {
    // As printed, A keeps 100 µL once B has taken its share. Duplicates need 50 µL plus a 25 µL spare, so 4/5.
    const s = standardSeries(doc, 'plate', 2);
    expect(s.scale).toBe(0.8);
    expect(s.vials.map(v => [v.id, v.take, v.diluent, v.left])).toEqual([['A', 160, 0, 80], ['B', 80, 80, 160], ['C', 0, 120, 120]]);
    expect([s.need, s.minLeft, s.stock, s.diluent]).toEqual([50, 80, 160, 200]);
  });

  it('keeps the printed concentrations, in µg/mL', () => {
    expect(standardSeries(doc, 'plate', 2).vials.map(v => [v.concentration, v.blank])).toEqual([[1000, false], [500, false], [0, true]]);
  });

  it('does not step up when the printed volumes are an exact fit', () => {
    // Three replicates: 75 µL plus the spare is exactly the 100 µL A keeps as printed.
    expect(standardSeries(doc, 'plate', 3).scale).toBe(1);
  });

  it('grows past the printed table when the run needs more', () => {
    // Six replicates: 150 µL plus 25 µL spare is 175 µL, so 9/5 of the printed volumes.
    const s = standardSeries(doc, 'plate', 6);
    expect(s.scale).toBe(1.8);
    expect(s.minLeft).toBeGreaterThanOrEqual(175);
  });
});

// The ATP assay (data/protocols/atp-assay.json, as Muse Spark read it): standards made in the wells from a 10 mM
// stock, read in nmol/well. The manual leaves the fluorometric working dilution to the user (0.01–0.1 mM), so that
// procedure has no curve to plan.
const atpFile = new URL('../data/protocols/atp-assay.json', import.meta.url);
describe.skipIf(!existsSync(atpFile))('a kit in nmol/well', () => {
  const atp = () => ProtocolSchema.parse(JSON.parse(readFileSync(atpFile, 'utf8')));

  it('plans the colorimetric procedure on the kit’s own scale; the fluorometric one has no curve to plan', () => {
    const p = atp();
    const [colorimetric, fluorometric] = p.procedures;
    expect(unitsProblem(p, colorimetric!)).toBeNull();
    expect(isPlannable(p, colorimetric!)).toBe(true);
    expect(unitOf(p, colorimetric!.id)).toBe('nmol/well');
    expect(fluorometric!.standardCurve).toBeUndefined();
    expect(isPlannable(p, fluorometric!)).toBe(false);
  });

  it('makes the working dilution, then the standards in the wells, and keeps the working dilution off the plate', () => {
    const p = atp();
    const s = standardSeries(p, 'colorimetric-assay', 2);
    const w = s.vials.find(v => v.intermediate)!;
    // 10 µL of 10 mM + 90 µL = 1 mM: 50 nmol in a 50 µL well, but shown as the manual prints it, since it is never in one
    // (the reading of 2026-10-31 calls the working stock "Ws" and numbers the standards 1–6, as the manual's table does).
    expect([w.id, w.concentration, w.from]).toEqual(['Ws', 50, 'stock']);
    expect(w.printed).toEqual({ value: 1, unit: 'mM' });
    expect(s.vials.find(v => !v.intermediate)?.printed).toBeUndefined();
    expect(s.vials.filter(v => !v.intermediate).map(v => v.concentration)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(s.unit).toBe('nmol/well');
    const wells = plateLayout(p, 'colorimetric-assay', 2, 2);
    expect(wells.filter(x => x.kind === 'standard').map(x => x.ref)).toEqual(['1', '1', '2', '2', '3', '3', '4', '4', '5', '5', '6', '6']);
    expect(workingReagent(p, 'colorimetric-assay', 2, 2).total).toBe((6 + 2) * 2 * 50);
  });

  it('says when a procedure points at a curve the protocol does not have', () => {
    const p = atp();
    p.procedures[0]!.standardCurve = 'gone';
    expect(unitsProblem(p, p.procedures[0]!)).toBe('its standard curve "gone" is not in the protocol');
    expect(isPlannable(p, p.procedures[0]!)).toBe(false);
  });
});
