import { describe, expect, it } from 'vitest';
import { assemble } from '../server/ai/import.ts';
import { isPlannable, unitsProblem } from '../shared/calc.ts';
import { Protocol, problems } from '../shared/protocol.ts';
import { comparable, normalizeUnit, toMicrogramsPerMl, toMicroliters, toMicromolar, unitKind } from '../shared/units.ts';
import { parts } from './import-fixture.ts';

describe('units as printed', () => {
  it('tidies a unit for display and nothing more', () => {
    expect(['ul', 'μL', 'uL', 'ml', 'L', 'l', 'nl'].map(normalizeUnit)).toEqual(['µL', 'µL', 'µL', 'mL', 'L', 'L', 'nL']);
    expect(['ug/ml', 'μg / mL', 'ng/mL', 'pg/ml', 'mg/mL'].map(normalizeUnit)).toEqual(['µg/mL', 'µg/mL', 'ng/mL', 'pg/mL', 'mg/mL']);
    expect(['uM', 'μM', 'nM', 'mM'].map(normalizeUnit)).toEqual(['µM', 'µM', 'nM', 'mM']);
    // What it does not know stays as printed: enzyme units, percent, nanometres, micrometres, cells.
    expect(['U/mL', '%', 'nm', 'um', 'cells/well'].map(normalizeUnit)).toEqual(['U/mL', '%', 'nm', 'um', 'cells/well']);
  });

  it('converts volumes to µL, exactly', () => {
    expect(toMicroliters({ value: 0.1, unit: 'mL' })).toBe(100);
    expect(toMicroliters({ value: 2, unit: 'L' })).toBe(2_000_000);
    expect(toMicroliters({ value: 500, unit: 'nL' })).toBe(0.5);
    expect(toMicroliters({ value: 25, unit: 'uL' })).toBe(25);
    expect(toMicroliters({ value: 5, unit: 'pL' })).toBe(0.000005);
    for (const unit of ['vial', '%', 'mg/mL', 'µM', 'tests']) expect(toMicroliters({ value: 1, unit })).toBeNull();
  });

  it('converts mass concentrations to µg/mL and molar ones to µM, never one into the other', () => {
    expect(toMicrogramsPerMl({ value: 2, unit: 'mg/mL' })).toBe(2000);
    expect(toMicrogramsPerMl({ value: 1000, unit: 'pg/mL' })).toBe(0.001);
    expect(toMicrogramsPerMl({ value: 10, unit: 'ng/mL' })).toBe(0.01);
    expect(toMicrogramsPerMl({ value: 1, unit: 'mg/L' })).toBe(1);
    expect(toMicrogramsPerMl({ value: 1, unit: 'µg/µL' })).toBe(1000);
    expect(toMicrogramsPerMl({ value: 5, unit: 'µM' })).toBeNull();
    expect(toMicromolar({ value: 5, unit: 'mM' })).toBe(5000);
    expect(toMicromolar({ value: 500, unit: 'nM' })).toBe(0.5);
    expect(toMicromolar({ value: 2, unit: 'mg/mL' })).toBeNull();
    for (const unit of ['%', 'U/mL', 'X']) expect([toMicrogramsPerMl({ value: 1, unit }), toMicromolar({ value: 1, unit })]).toEqual([null, null]);
    expect(['µL', 'ng/mL', 'nM', '%'].map(unitKind)).toEqual(['volume', 'mass-concentration', 'molar', null]);
  });

  it('puts two concentrations on one scale when it can', () => {
    expect(comparable({ value: 2, unit: 'mg/mL' }, { value: 500, unit: 'µg/mL' })).toEqual([2000, 500]);
    expect(comparable({ value: 1, unit: 'mM' }, { value: 100, unit: 'µM' })).toEqual([1000, 100]);
    expect(comparable({ value: 10, unit: '%' }, { value: 5, unit: '%' })).toEqual([10, 5]);
    expect(comparable({ value: 10, unit: 'U/mL' }, { value: 5, unit: '%' })).toBeNull();
    expect(comparable({ value: 1, unit: 'mg/mL' }, { value: 1, unit: 'µM' })).toBeNull();
  });
});

/** The made-up kit (tests/import-fixture.ts) with its amounts in other units. */
function kitIn(units: { stock: string; points: [string, string, string]; range: string; sample?: string }) {
  const p = parts();
  p.inventory.components[2]!.concentration = units.stock;
  p.inventory.curves[0]!.range = units.range;
  p.inventory.procedures[0]!.range = units.range;
  if (units.sample) p.inventory.procedures[0]!.sample = units.sample;
  p.curves.points.forEach((pt, i) => (pt.concentration = units.points[i]!));
  return assemble(p, { sha256: 'a'.repeat(64), pages: 2, fetchedAt: '2026-10-28T00:00:00Z', seconds: 1 });
}

describe('a protocol in units other than µL and µg/mL', () => {
  it('keeps an ELISA table in pg/mL as printed, checks it, and can still plan it in µg/mL', () => {
    const { protocol, problems: found } = kitIn({ stock: '1 ng/mL', points: ['1000 pg/mL', '500 pg/mL', '0'], range: '10-1000 pg/mL' });
    expect(protocol.components.find(c => c.id === 'std')!.concentration).toEqual({ value: 1, unit: 'ng/mL' });
    expect(protocol.standardCurves[0]!.points.map(p => `${p.concentration.value} ${p.concentration.unit}`)).toEqual(['1000 pg/mL', '500 pg/mL', '0 pg/mL']);
    expect(protocol.standardCurves[0]!.range).toEqual({ min: 10, max: 1000, unit: 'pg/mL' });
    expect(found.filter(f => !f.startsWith('mix lonely') && !f.includes('no citation') && !f.startsWith('analysis') && !f.includes('without what it adds'))).toEqual([]);
    expect(Protocol.safeParse(JSON.parse(JSON.stringify(protocol))).success).toBe(true);
    expect(isPlannable(protocol, protocol.procedures[0]!)).toBe(true);
  });

  it('keeps a molar or percent table as printed, but does not plan what it cannot convert', () => {
    const molar = kitIn({ stock: '1 mM', points: ['1000 uM', '500 uM', '0'], range: '10-1000 uM' }).protocol;
    expect(molar.standardCurves[0]!.points[0]!.concentration).toEqual({ value: 1000, unit: 'µM' });
    expect(problems(molar).filter(x => x.includes('gives'))).toEqual([]);
    expect(unitsProblem(molar, molar.procedures[0]!)).toBe('the working range is in µM');
    expect(isPlannable(molar, molar.procedures[0]!)).toBe(false);

    const percent = kitIn({ stock: '10 %', points: ['10 %', '5 %', '0'], range: '1-10 %', sample: '1 well' }).protocol;
    expect(percent.procedures[0]!.sample).toEqual({ value: 1, unit: 'well' });
    expect(unitsProblem(percent, percent.procedures[0]!)).toBe('the sample is 1 well');
  });

  it('still reports a dilution that does not add up, in the units it was printed in', () => {
    const { protocol } = kitIn({ stock: '1 ng/mL', points: ['1000 pg/mL', '400 pg/mL', '0'], range: '10-1000 pg/mL' });
    expect(problems(protocol)).toContain('curve curve vial B: 50 µL of A + 50 µL diluent gives 500 pg/mL, not 400');
  });
});
