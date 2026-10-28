import { describe, expect, it } from 'vitest';
import type { Protocol } from '../shared/protocol.ts';
import { standardSeries } from '../shared/calc.ts';

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

