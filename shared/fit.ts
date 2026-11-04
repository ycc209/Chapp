import type { Protocol } from './protocol.ts';

/**
 * Plate analysis, as the protocol's `analysis` section asks for it (BCA: subtract the blank's average from every
 * well, plot each standard's average blank-corrected reading against its concentration, fit a four-parameter or
 * best-fit curve, never a straight line) and read the samples off the curve. Pure functions: the numbers on the
 * results screens are computed here, never written by a model.
 */

export type Point = { x: number; y: number };

/** A fitted standard curve: x is concentration (µg/mL), y the blank-corrected reading. */
export type Fit =
  /** Four-parameter logistic: y = d + (a − d) / (1 + (x / c)^b). `a` is the response at 0, `d` the plateau. */
  | { kind: '4pl'; a: number; b: number; c: number; d: number; r2: number }
  /** y = p0 + p1·x + p2·x². */
  | { kind: 'quadratic'; p0: number; p1: number; p2: number; r2: number }
  | { kind: 'linear'; intercept: number; slope: number; r2: number }
  /** Straight lines between the points, the manual's by-hand method. */
  | { kind: 'point-to-point'; points: Point[]; r2: number };

export type FitKind = Fit['kind'];
export type FitPlan = NonNullable<Protocol['analysis']>['fit'];

/** The curve's reading at concentration x. */
export function predict(fit: Fit, x: number): number {
  switch (fit.kind) {
    case '4pl':
      return fit.d + (fit.a - fit.d) / (1 + Math.pow(Math.max(x, 0) / fit.c, fit.b));
    case 'quadratic':
      return fit.p0 + fit.p1 * x + fit.p2 * x * x;
    case 'linear':
      return fit.intercept + fit.slope * x;
    case 'point-to-point': {
      const pts = fit.points;
      if (x <= pts[0]!.x) return lerp(pts[0]!, pts[1]!, x);
      for (let i = 1; i < pts.length; i++) if (x <= pts[i]!.x) return lerp(pts[i - 1]!, pts[i]!, x);
      return lerp(pts[pts.length - 2]!, pts[pts.length - 1]!, x);
    }
  }
}

const lerp = (p: Point, q: Point, x: number) => (q.x === p.x ? p.y : p.y + ((q.y - p.y) * (x - p.x)) / (q.x - p.x));

/**
 * The concentration whose reading is y, searched between `min` and `max` (by default 0 to the top standard) on the
 * rising part of the curve; null when y is outside what the curve reaches there. Pass a larger `max` to extrapolate.
 */
export function solve(fit: Fit, y: number, range: { min?: number; max: number }): number | null {
  let lo = range.min ?? 0;
  let hi = range.max;
  // A quadratic that bends over before `hi` only answers below its peak.
  if (fit.kind === 'quadratic' && fit.p2 < 0) hi = Math.min(hi, -fit.p1 / (2 * fit.p2));
  if (!(hi > lo)) return null;
  const ylo = predict(fit, lo), yhi = predict(fit, hi);
  if (!(yhi > ylo) || y < ylo - 1e-12 || y > yhi + 1e-12) return null;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (predict(fit, mid) < y) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function rSquared(points: Point[], f: (x: number) => number) {
  const mean = points.reduce((s, p) => s + p.y, 0) / points.length;
  const tot = points.reduce((s, p) => s + (p.y - mean) ** 2, 0);
  const res = points.reduce((s, p) => s + (p.y - f(p.x)) ** 2, 0);
  return tot === 0 ? 1 : 1 - res / tot;
}

const ssr = (points: Point[], fit: Fit) => points.reduce((s, p) => s + (p.y - predict(fit, p.x)) ** 2, 0);

/** Solves A·x = b by Gaussian elimination with partial pivoting; null when A is singular. */
function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r]![col]!) > Math.abs(M[pivot]![col]!)) pivot = r;
    if (Math.abs(M[pivot]![col]!) < 1e-300) return null;
    [M[col], M[pivot]] = [M[pivot]!, M[col]!];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const k = M[r]![col]! / M[col]![col]!;
      for (let c = col; c <= n; c++) M[r]![c]! -= k * M[col]![c]!;
    }
  }
  return M.map((row, i) => row[n]! / row[i]!);
}

/** Least squares for a polynomial of the given degree, on x scaled to the top standard so the sums stay well conditioned. */
function polyfit(points: Point[], degree: number): number[] | null {
  const scale = Math.max(...points.map(p => Math.abs(p.x))) || 1;
  const n = degree + 1;
  const A = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const b = new Array<number>(n).fill(0);
  for (const p of points) {
    const x = p.x / scale;
    for (let i = 0; i < n; i++) {
      b[i]! += p.y * x ** i;
      for (let j = 0; j < n; j++) A[i]![j]! += x ** (i + j);
    }
  }
  const c = solveLinear(A, b);
  return c && c.map((v, i) => v / scale ** i);
}

export function fitLinear(points: Point[]): Fit | null {
  if (points.length < 2) return null;
  const c = polyfit(points, 1);
  if (!c) return null;
  const fit = { kind: 'linear', intercept: c[0]!, slope: c[1]!, r2: 0 } as const;
  return { ...fit, r2: rSquared(points, x => predict(fit, x)) };
}

export function fitQuadratic(points: Point[]): Fit | null {
  if (points.length < 3) return null;
  const c = polyfit(points, 2);
  if (!c) return null;
  const fit = { kind: 'quadratic', p0: c[0]!, p1: c[1]!, p2: c[2]!, r2: 0 } as const;
  return { ...fit, r2: rSquared(points, x => predict(fit, x)) };
}

export function fitPointToPoint(points: Point[]): Fit | null {
  const sorted = [...points].sort((p, q) => p.x - q.x);
  if (sorted.length < 2) return null;
  return { kind: 'point-to-point', points: sorted, r2: 1 };
}

/**
 * Four-parameter logistic by Levenberg–Marquardt. b and c are fitted as logarithms so they stay positive; the start
 * is the quadratic's shape (the response at 0, a plateau above the top standard, the middle of the range).
 */
export function fit4pl(points: Point[]): Fit | null {
  if (points.length < 5) return null; // four parameters need at least one point to spare
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  const top = Math.max(...xs);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  if (!(top > 0) || !(yMax > yMin)) return null;
  const model = (p: number[], x: number) => p[3]! + (p[0]! - p[3]!) / (1 + Math.pow(Math.max(x, 0) / Math.exp(p[2]!), Math.exp(p[1]!)));
  const cost = (p: number[]) => points.reduce((s, pt) => s + (pt.y - model(p, pt.x)) ** 2, 0);

  let best: { p: number[]; cost: number } | null = null;
  // A couple of starts: BCA curves bend gently, so the plateau can sit well above the top standard.
  for (const [plateau, middle] of [[2, 1], [4, 2], [1.3, 0.5]] as const) {
    let p = [yMin, Math.log(1), Math.log(top * middle), yMin + (yMax - yMin) * plateau];
    let c = cost(p);
    let lambda = 1e-3;
    for (let iter = 0; iter < 500 && Number.isFinite(c); iter++) {
      const r = points.map(pt => pt.y - model(p, pt.x));
      const J = points.map(pt =>
        p.map((v, k) => {
          const h = 1e-6 * Math.max(Math.abs(v), 1);
          const up = [...p], down = [...p];
          up[k] = v + h;
          down[k] = v - h;
          return (model(up, pt.x) - model(down, pt.x)) / (2 * h);
        }),
      );
      const JTJ = p.map((_, i) => p.map((__, j) => J.reduce((s, row) => s + row[i]! * row[j]!, 0)));
      const JTr = p.map((_, i) => J.reduce((s, row, n) => s + row[i]! * r[n]!, 0));
      let improved = false;
      while (lambda < 1e12) {
        const A = JTJ.map((row, i) => row.map((v, j) => (i === j ? v * (1 + lambda) + 1e-12 : v)));
        const step = solveLinear(A, JTr);
        if (!step) { lambda *= 10; continue; }
        const next = p.map((v, i) => v + step[i]!);
        const nc = cost(next);
        if (Number.isFinite(nc) && nc < c) {
          const gain = c - nc;
          p = next;
          c = nc;
          lambda = Math.max(lambda / 10, 1e-12);
          improved = gain > 1e-15 * (1 + c);
          break;
        }
        lambda *= 10;
      }
      if (!improved) break;
    }
    if (Number.isFinite(c) && (!best || c < best.cost)) best = { p, cost: c };
  }
  if (!best) return null;
  const [a, lb, lc, d] = best.p as [number, number, number, number];
  const fit = { kind: '4pl', a, b: Math.exp(lb), c: Math.exp(lc), d, r2: 0 } as const;
  if (![fit.a, fit.b, fit.c, fit.d].every(Number.isFinite)) return null;
  return { ...fit, r2: rSquared(points, x => predict(fit, x)) };
}

/** Rises across the standards: a curve that turns down inside the range cannot be read. */
function rises(fit: Fit, points: Point[]) {
  const xs = points.map(p => p.x);
  const lo = Math.min(...xs), hi = Math.max(...xs);
  let prev = predict(fit, lo);
  for (let i = 1; i <= 50; i++) {
    const y = predict(fit, lo + ((hi - lo) * i) / 50);
    if (!(y > prev)) return false;
    prev = y;
  }
  return true;
}

const PARAMS: Record<FitKind, number> = { '4pl': 4, quadratic: 3, linear: 2, 'point-to-point': 0 };

/** The candidate with the smallest residual standard error, which charges each extra parameter. */
function bestFit(points: Point[]): Fit | null {
  const candidates = [fit4pl(points), fitQuadratic(points)].filter((f): f is Fit => !!f && rises(f, points));
  const se = (f: Fit) => Math.sqrt(ssr(points, f) / Math.max(points.length - PARAMS[f.kind], 1));
  return candidates.sort((f, g) => se(f) - se(g))[0] ?? null;
}

/**
 * Fits the standards the way the protocol prefers (`analysis.fit.preferred`, in order: BCA asks for '4pl', then
 * 'best-fit'); a fit that fails or does not rise across the standards gives way to the next, and the by-hand
 * point-to-point curve is the last resort. A straight line is used only when the protocol does not rule it out.
 */
export function fitStandards(points: Point[], plan: FitPlan): Fit {
  for (const kind of plan.preferred) {
    const fit = kind === '4pl' ? fit4pl(points) : bestFit(points);
    if (fit && rises(fit, points)) return fit;
  }
  if (!plan.avoid.includes('linear')) {
    const line = fitLinear(points);
    if (line?.kind === 'linear' && line.slope > 0) return line;
  }
  const byHand = fitPointToPoint(points);
  if (!byHand) throw new Error('a standard curve needs at least two standards');
  return byHand;
}

/** What one well holds, from the plate layout: a standard (with its concentration, µg/mL) or a sample. */
export type WellRole = {
  well: string;
  kind: 'standard' | 'sample';
  /** The vial ("A") or the sample number ("1"). */
  ref: string;
  concentration?: number;
  blank?: boolean;
};

export type StandardResult = {
  ref: string;
  concentration: number;
  blank: boolean;
  wells: string[];
  raw: number[];
  /** Blank-corrected readings, one per replicate. */
  net: number[];
  mean: number;
  /** Coefficient of variation of the replicates' readings, %; null with one replicate. */
  cv: number | null;
};

export type SampleFlag = 'ok' | 'above' | 'below' | 'missing';

export type SampleResult = {
  ref: string;
  wells: string[];
  raw: number[];
  net: number[];
  /** Mean blank-corrected reading. */
  mean: number | null;
  /** µg/mL read off the curve from the mean reading; null when it is above the top standard or has no reading. */
  concentration: number | null;
  /** Each replicate read off the curve on its own (null where it is off the curve). */
  replicates: (number | null)[];
  /** CV of the replicates' concentrations, %; null with one replicate or when one is off the curve. */
  cv: number | null;
  /** 'above' the top standard or 'below' the lowest non-blank one: outside what the curve was made for. */
  flag: SampleFlag;
  /** Above the range: the curve carried past the top standard, as a guide for the dilution only. */
  estimate: number | null;
  /** Above the range: dilute 1 : this and run it again. */
  dilution: number | null;
};

export type PlateAnalysis = {
  blank: { wells: string[]; mean: number };
  standards: StandardResult[];
  fit: Fit;
  /** The standards' range: the lowest non-blank and the top concentration, µg/mL. */
  range: { min: number; max: number };
  samples: SampleResult[];
};

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

/** Coefficient of variation in %, from the sample standard deviation; null for fewer than two values. */
export function cv(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs);
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
  return m === 0 ? null : (Math.abs(sd / m) * 100);
}

/** Groups wells by what they hold, in the order the refs first appear. */
function group(wells: WellRole[], kind: WellRole['kind']) {
  const out = new Map<string, WellRole[]>();
  for (const w of wells) if (w.kind === kind) out.set(w.ref, [...(out.get(w.ref) ?? []), w]);
  return out;
}

/** Dilutions offered for a rerun: the smallest that brings the estimate down to half the top standard. */
const DILUTIONS = [2, 5, 10, 20, 50, 100];

/**
 * The whole analysis of one plate: subtract the blank's average from every well, average each standard's replicates,
 * fit them as the protocol asks, then read every sample off the curve and flag the ones outside the standards.
 */
export function analyzePlate(wells: WellRole[], readings: Record<string, number>, plan: FitPlan): PlateAnalysis {
  const read = (ws: WellRole[]) => ws.filter(w => Number.isFinite(readings[w.well]));
  const blanks = read(wells.filter(w => w.kind === 'standard' && w.blank));
  const blank = blanks.length ? mean(blanks.map(w => readings[w.well]!)) : 0;

  const standards: StandardResult[] = [];
  for (const [ref, ws] of group(wells, 'standard')) {
    const got = read(ws);
    const raw = got.map(w => readings[w.well]!);
    const net = raw.map(r => r - blank);
    if (!net.length) continue;
    standards.push({
      ref,
      concentration: ws[0]!.concentration ?? 0,
      blank: !!ws[0]!.blank,
      wells: got.map(w => w.well),
      raw,
      net,
      mean: mean(net),
      cv: ws[0]!.blank ? null : cv(net),
    });
  }
  const points = standards.map(s => ({ x: s.concentration, y: s.mean }));
  const fit = fitStandards(points, plan);
  const filled = standards.filter(s => !s.blank);
  const range = { min: Math.min(...filled.map(s => s.concentration)), max: Math.max(...filled.map(s => s.concentration)) };
  const top = filled.find(s => s.concentration === range.max)!;
  const bottom = filled.find(s => s.concentration === range.min)!;
  const onCurve = (y: number) => solve(fit, y, { max: range.max });

  const samples: SampleResult[] = [];
  for (const [ref, ws] of group(wells, 'sample')) {
    const got = read(ws);
    const raw = got.map(w => readings[w.well]!);
    const net = raw.map(r => r - blank);
    const base = { ref, wells: ws.map(w => w.well), raw, net, estimate: null, dilution: null };
    if (!net.length) {
      samples.push({ ...base, mean: null, concentration: null, replicates: [], cv: null, flag: 'missing' });
      continue;
    }
    const m = mean(net);
    const replicates = net.map(onCurve);
    const solved = replicates.every((r): r is number => r !== null) ? replicates : null;
    if (m > Math.max(top.mean, predict(fit, range.max))) {
      // Past the top standard the curve is a guess: no number, only how far to dilute for the rerun.
      const estimate = solve(fit, m, { max: range.max * 10 });
      const dilution = estimate === null ? 10 : (DILUTIONS.find(d => estimate / d <= range.max / 2) ?? 100);
      samples.push({ ...base, mean: m, concentration: null, replicates, cv: null, flag: 'above', estimate, dilution });
      continue;
    }
    const concentration = onCurve(m) ?? 0;
    samples.push({
      ...base,
      mean: m,
      concentration,
      replicates,
      cv: solved ? cv(solved) : null,
      flag: m < bottom.mean ? 'below' : 'ok',
    });
  }
  return { blank: { wells: blanks.map(w => w.well), mean: blank }, standards, fit, range, samples };
}

/** µL of a sample that hold `amount` µg, at `concentration` µg/mL. */
export const volumeForMass = (concentration: number, amount: number) => (amount / concentration) * 1000;

/** Gel lanes and tubes come in these volumes (µL); a lane plan takes the first one that fits the largest load. */
const LANES = [10, 20, 25, 50, 100, 150, 200, 250, 500];
export const laneFor = (microliters: number) => LANES.find(l => l >= microliters) ?? Math.ceil(microliters / 100) * 100;

/**
 * One concentration every sample can be brought to: the lowest in-range sample, rounded down to 0.1 mg/mL, and for
 * each sample how much to take (and how much buffer to add) for `final` µL at that concentration.
 */
export function commonConcentration(samples: SampleResult[], final = 100) {
  const ok = samples.filter(s => s.flag === 'ok' && s.concentration !== null && s.concentration > 0);
  if (!ok.length) return null;
  const lowest = ok.reduce((lo, s) => (s.concentration! < lo.concentration! ? s : lo));
  const target = Math.floor(lowest.concentration! / 100) * 100;
  if (!target) return null;
  return {
    /** µg/mL. */
    target,
    lowest: lowest.ref,
    rows: samples.map(s =>
      s.flag === 'ok' && s.concentration
        ? { ref: s.ref, take: (target / s.concentration) * final, buffer: final - (target / s.concentration) * final }
        : { ref: s.ref, take: null, buffer: null },
    ),
  };
}

// The built-in example: the BCA curve at 562 nm of the plate-reader sheet photographed in the demo
// (video/scripts/plate-sheet.ts), a blank near 0.1 and the reading rising nearly straight, bending a little at the top
// (1.74 above the blank at 2,000 µg/mL), so the straight regression line Results reads it with fits it as it fits a
// real plate. (Until 2026-11-04 it was a four-parameter curve after the design's artboard, which that line fits poorly.)
const EXAMPLE_BLANK = 0.098;
/** The example samples, µg/mL, and the CV % of their replicates (Results-Swipe.dc.html). Sample 7 is above the top standard. */
const EXAMPLE_SAMPLES: [number, number][] = [
  [1240, 3], [860, 5], [1510, 2], [420, 7], [980, 4], [1130, 3], [2600, 3], [650, 6], [1370, 2], [740, 4], [1050, 3], [590, 8],
];
/** Each standard's offset from the curve (a pipetting error per vial) and its replicates' spread. */
const STANDARD_ERROR = [0.026, -0.04, 0.02, -0.031, 0.035, -0.022, 0.029, -0.035, 0.024];
const STANDARD_SPREAD = 0.012;

const exampleNet = (c: number) => 1.12e-3 * c - 1.25e-7 * c * c;
const round4 = (x: number) => Math.round(x * 10000) / 10000;

/** Replicate offsets spaced evenly from −1 to 1, scaled so their sample standard deviation is 1. */
function spread(n: number): number[] {
  if (n === 1) return [0];
  const z = Array.from({ length: n }, (_, r) => -1 + (2 * r) / (n - 1));
  const sd = Math.sqrt(z.reduce((acc, v) => acc + v * v, 0) / (n - 1));
  return z.map(v => v / sd);
}

/**
 * Chapp's built-in example readings (absorbance, 4 decimals as plate readers export them, which keeps every number
 * the results pages work out to the Results artboards' own arithmetic) for a plate laid out as `wells`: what the mock
 * plate reader returns, and what every screen showing them must label "Sample data". Deterministic, so the same plan
 * always gives the same plate. The standards scatter 2–4 % around the demo sheet's BCA curve (the straight line's R²
 * 0.994 on the kit's nine standards, 0.997 on five); the samples are then placed on the straight regression line fitted
 * to those standards, as Results reads them (or on `plan`'s fit), so the example reads back as designed: 1,240, 860,
 * 1,510 … µg/mL with their CVs, and Sample 7 above the top standard.
 */
export function sampleReadings(wells: WellRole[], plan: FitPlan = { preferred: [], avoid: [] }): Record<string, number> {
  const out: Record<string, number> = {};
  const standards = group(wells, 'standard');
  let i = 0;
  for (const ws of standards.values()) {
    const first = ws[0]!;
    const z = spread(ws.length);
    ws.forEach((w, r) => {
      const net = first.blank ? 0.002 * z[r]! : exampleNet(first.concentration ?? 0) * (1 + STANDARD_ERROR[i % STANDARD_ERROR.length]! + STANDARD_SPREAD * z[r]!);
      out[w.well] = round4(EXAMPLE_BLANK + net);
    });
    if (!first.blank) i++;
  }
  // The curve those standards give, as analyzePlate() will fit it.
  const blank = mean(wells.filter(w => w.kind === 'standard' && w.blank).map(w => out[w.well]!));
  const points = [...standards.values()].map(ws => ({ x: ws[0]!.blank ? 0 : (ws[0]!.concentration ?? 0), y: mean(ws.map(w => out[w.well]! - (Number.isFinite(blank) ? blank : 0))) }));
  const fit = fitStandards(points, plan);
  for (const ws of group(wells, 'sample').values()) {
    const n = Number(ws[0]!.ref) - 1;
    const [c0, cvPercent] = EXAMPLE_SAMPLES[n % EXAMPLE_SAMPLES.length]!;
    // Past the twelfth sample the list repeats, shifted so the extra samples do not look copied.
    const c = c0 * (1 + 0.07 * Math.floor(n / EXAMPLE_SAMPLES.length));
    const z = spread(ws.length);
    const nets = z.map(v => predict(fit, c * (1 + (cvPercent / 100) * v)));
    // Shift the replicates together so their mean reads back exactly c.
    const shift = predict(fit, c) - mean(nets);
    ws.forEach((w, r) => {
      out[w.well] = round4((Number.isFinite(blank) ? blank : EXAMPLE_BLANK) + nets[r]! + shift);
    });
  }
  return out;
}
