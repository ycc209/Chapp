import { describe, expect, it } from 'vitest';
import {
  analyzePlate,
  commonConcentration,
  cv,
  fit4pl,
  fitLinear,
  fitPointToPoint,
  fitQuadratic,
  fitStandards,
  laneFor,
  predict,
  solve,
  volumeForMass,
  type Fit,
  type FitPlan,
  type WellRole,
} from '../shared/fit.ts';

// The BCA manual's analysis section: a four-parameter or best-fit curve, the by-hand fallback, never a straight line.
const BCA: FitPlan = { preferred: ['4pl', 'best-fit'], byHand: 'point-to-point', avoid: ['linear'] };
const CONCS = [0, 25, 125, 250, 500, 750, 1000, 1500, 2000];
const TRUE: Fit = { kind: '4pl', a: 0.01, b: 1.1, c: 1600, d: 3.8, r2: 1 };

describe('curves', () => {
  it('solve() inverts predict() on the rising part of the curve', () => {
    for (const x of [10, 333, 1234, 1999]) expect(solve(TRUE, predict(TRUE, x), { max: 2000 })).toBeCloseTo(x, 6);
    // Beyond the top standard, only when asked to look there.
    expect(solve(TRUE, predict(TRUE, 2600), { max: 2000 })).toBeNull();
    expect(solve(TRUE, predict(TRUE, 2600), { max: 20000 })).toBeCloseTo(2600, 6);
  });

  it('a quadratic fit recovers exact coefficients', () => {
    const pts = CONCS.map(x => ({ x, y: 0.02 + 0.0018 * x - 3.5e-7 * x * x }));
    const f = fitQuadratic(pts)!;
    expect(f.kind).toBe('quadratic');
    if (f.kind !== 'quadratic') return;
    expect(f.p0).toBeCloseTo(0.02, 10);
    expect(f.p1).toBeCloseTo(0.0018, 12);
    expect(f.p2).toBeCloseTo(-3.5e-7, 15);
    expect(f.r2).toBeCloseTo(1, 12);
  });

  it('a four-parameter fit recovers a known 4PL from the BCA concentrations', () => {
    const pts = CONCS.map(x => ({ x, y: predict(TRUE, x) }));
    const f = fit4pl(pts)!;
    expect(f.kind).toBe('4pl');
    expect(f.r2).toBeGreaterThan(0.999999);
    // The parameters trade off a little; what matters is reading samples back.
    for (const x of [40, 420, 860, 1240, 1900]) expect(solve(f, predict(TRUE, x), { max: 2000 })).toBeCloseTo(x, 0);
  });

  it('a straight line and point to point', () => {
    const line = fitLinear([{ x: 0, y: 1 }, { x: 10, y: 21 }])!;
    expect(line.kind === 'linear' && [line.intercept, line.slope]).toEqual([1, 2]);
    const p2p = fitPointToPoint([{ x: 100, y: 1 }, { x: 0, y: 0 }, { x: 200, y: 1.5 }])!;
    expect(predict(p2p, 50)).toBeCloseTo(0.5);
    expect(predict(p2p, 150)).toBeCloseTo(1.25);
    expect(solve(p2p, 1.25, { max: 200 })).toBeCloseTo(150);
  });

  it('follows the protocol: 4PL first, then the best fit, then by hand; never a line when the protocol avoids it', () => {
    const curve = CONCS.map(x => ({ x, y: predict(TRUE, x) }));
    expect(fitStandards(curve, BCA).kind).toBe('4pl');
    // Three standards are too few for four parameters: the best fit is the quadratic.
    expect(fitStandards(curve.slice(0, 3), BCA).kind).toBe('quadratic');
    // Two standards: neither fits, and the line is ruled out, so point to point.
    expect(fitStandards(curve.slice(0, 2), BCA).kind).toBe('point-to-point');
    expect(fitStandards(curve.slice(0, 2), { preferred: ['4pl'], avoid: [] }).kind).toBe('linear');
  });
});

describe('cv', () => {
  it('uses the sample standard deviation', () => {
    // mean 1.05, sd 0.0707
    expect(cv([1, 1.1])).toBeCloseTo(6.734, 3);
    expect(cv([2])).toBeNull();
  });
});

describe('analyzePlate', () => {
  // A hand-sized plate: a blank and four standards in duplicate, three samples in duplicate.
  const std = (ref: string, concentration: number, wells: string[], blank = false): WellRole[] =>
    wells.map(well => ({ well, kind: 'standard', ref, concentration, blank }));
  const sample = (ref: string, wells: string[]): WellRole[] => wells.map(well => ({ well, kind: 'sample', ref }));
  const wells: WellRole[] = [
    ...std('A', 2000, ['A1', 'A2']),
    ...std('B', 1000, ['B1', 'B2']),
    ...std('C', 500, ['C1', 'C2']),
    ...std('D', 125, ['D1', 'D2']),
    ...std('E', 25, ['E1', 'E2']),
    ...std('F', 0, ['F1', 'F2'], true),
    ...sample('1', ['G1', 'G2']),
    ...sample('2', ['H1', 'H2']),
    ...sample('3', ['A3', 'A4']),
  ];
  const BLANK = [0.1, 0.12]; // mean 0.11
  // Above the blank, the true curve starts at 0.
  const net = (c: number) => predict(TRUE, c) - predict(TRUE, 0);
  const readings: Record<string, number> = { F1: BLANK[0]!, F2: BLANK[1]! };
  for (const [ref, c] of [['A', 2000], ['B', 1000], ['C', 500], ['D', 125], ['E', 25]] as const) {
    const w = wells.filter(x => x.ref === ref && x.kind === 'standard');
    readings[w[0]!.well] = 0.11 + net(c) * 1.01;
    readings[w[1]!.well] = 0.11 + net(c) * 0.99;
  }
  // Sample 1 in range (800 µg/mL, replicates on either side), 2 above the top standard, 3 below the lowest.
  readings.G1 = 0.11 + net(780);
  readings.G2 = 0.11 + net(820);
  readings.H1 = readings.H2 = 0.11 + net(3000);
  readings.A3 = readings.A4 = 0.11 + net(10);
  const a = analyzePlate(wells, readings, BCA);

  it('subtracts the average of the blank replicates from every well', () => {
    expect(a.blank).toEqual({ wells: ['F1', 'F2'], mean: 0.11 });
    const c = a.standards.find(s => s.ref === 'C')!;
    expect(c.net[0]).toBeCloseTo(net(500) * 1.01, 12);
    expect(c.net[1]).toBeCloseTo(net(500) * 0.99, 12);
  });

  it('averages each standard over its replicates and fits the averages', () => {
    const c = a.standards.find(s => s.ref === 'C')!;
    expect(c.mean).toBeCloseTo(net(500), 12);
    expect(c.cv).toBeCloseTo(cv([1.01, 0.99])!, 9);
    expect(a.fit.kind).toBe('4pl');
    expect(a.fit.r2).toBeGreaterThan(0.9999);
    expect(a.range).toEqual({ min: 25, max: 2000 });
  });

  it('reads samples off the curve and flags the ones outside the standards', () => {
    const [s1, s2, s3] = a.samples;
    expect(s1!.flag).toBe('ok');
    expect(s1!.replicates[0]).toBeCloseTo(780, 3);
    expect(s1!.replicates[1]).toBeCloseTo(820, 3);
    // The mean reading, read off the curve: a hair under the mean concentration, because the curve bends.
    expect(s1!.concentration).toBeGreaterThan(798);
    expect(s1!.concentration).toBeLessThan(800);
    expect(s1!.cv).toBeCloseTo(cv([780, 820])!, 6);
    expect(s2!.flag).toBe('above');
    expect(s2!.concentration).toBeNull();
    expect(s2!.estimate).toBeCloseTo(3000, 3);
    expect(s2!.dilution).toBe(5);
    expect(s3!.flag).toBe('below');
    expect(s3!.concentration).toBeCloseTo(10, 3);
  });

  it('keeps a sample with no reading, flagged missing', () => {
    const b = analyzePlate([...wells, ...sample('4', ['B3'])], readings, BCA);
    expect(b.samples[3]).toMatchObject({ ref: '4', flag: 'missing', concentration: null });
  });
});

describe('what the results screens compute', () => {
  it('µL for a mass, and the lane that holds it (Results-Swipe-Volume: 20 µg of a 420 µg/mL sample)', () => {
    expect(volumeForMass(420, 20)).toBeCloseTo(47.62, 2);
    expect(laneFor(47.6)).toBe(50);
    expect(laneFor(600)).toBe(600);
  });

  it('one concentration for all: the lowest sample, rounded down to 0.1 mg/mL', () => {
    const s = (ref: string, concentration: number | null, flag: 'ok' | 'above' = 'ok') =>
      ({ ref, concentration, flag, wells: [], raw: [], net: [], mean: 0, replicates: [], cv: null, estimate: null, dilution: null });
    const c = commonConcentration([s('1', 1240), s('2', 420), s('3', null, 'above')])!;
    expect(c.target).toBe(400);
    expect(c.lowest).toBe('2');
    expect(c.rows[0]!.take).toBeCloseTo(32.26, 2);
    expect(c.rows[0]!.buffer).toBeCloseTo(67.74, 2);
    expect(c.rows[2]).toEqual({ ref: '3', take: null, buffer: null });
  });
});
