import { formatVolume, standardSeries, toMicrogramsPerMl, toMicroliters, type StandardVial } from '../../../shared/calc.ts';
import { commonConcentration, laneFor, volumeForMass, type PlateAnalysis, type WellRole } from '../../../shared/fit.ts';
import { assayOf, type Protocol, type Step } from '../../../shared/protocol.ts';

/**
 * What the bench parts draw, worked out from the protocol and the plan: pure functions, so the screens and the tests
 * get the same numbers. Layout and rounding follow the design's own logic (Plan-Heard.dc.html, Run-Load.dc.html).
 */

export type { StandardVial };

/** A dilution series ready to draw: the vials, plus what the bench needs in total (µL). `standardSeries()` fits. */
export type Series = { vials: StandardVial[]; stock: number; diluent: number; need: number; minLeft: number };

// ─── Shades ──────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Each vial's blue, 8 (darkest) to 1, by rank of concentration; 0 for the blank. The design spreads any number of
 * standards over its eight blues: rank i of m gets blue round(i·7 / (m − 1)), so the kit's 9 use every shade and five
 * standards skip some.
 */
export function shadeLevels(vials: readonly { concentration: number; blank: boolean }[]): number[] {
  const filled = vials.map((v, i) => ({ v, i })).filter(x => !x.v.blank).sort((a, b) => b.v.concentration - a.v.concentration);
  const m = filled.length;
  const levels = vials.map(() => 0);
  filled.forEach((x, rank) => {
    levels[x.i] = 8 - (m <= 1 ? 0 : Math.round((rank * 7) / (m - 1)));
  });
  return levels;
}

/** The CSS color of a shade level: --std-8 … --std-1; the blank (0) is white on a vial, --std-0 in a well. */
export const shadeColor = (level: number, where: 'vial' | 'well' = 'vial') =>
  level === 0 ? (where === 'vial' ? '#ffffff' : 'var(--std-0)') : `var(--std-${level})`;

/** Ink on a shade: white on the four darkest blues of a vial card, the three darkest in a well (as drawn). */
export const shadeInk = (level: number, where: 'vial' | 'well' = 'vial') => (level >= (where === 'vial' ? 5 : 6) ? '#ffffff' : 'var(--ink)');

// ─── Numbers as the bench reads them ─────────────────────────────────────────────────────────────────────────────

/** A volume as a bare number of µL: 120, 62.5. */
export const microliters = (x: number) => (Math.abs(x - Math.round(x)) < 1e-9 || x >= 100 ? String(Math.round(x)) : String(+x.toFixed(1)));

/** 2000 → "2,000", 62.5 → "62.5". */
export const concentrationText = (x: number) => x.toLocaleString('en-US', { maximumFractionDigits: 2 });

/** A result to three significant figures: 1238.6 → "1,240", 47.62 → "47.6". */
export const threeFigures = (x: number) => Number(x.toPrecision(3)).toLocaleString('en-US', { maximumFractionDigits: 1 });

/** Where a vial's volume comes from, as the table's From column says it: "Stock", "B", or "—" for the blank. */
export const vialSource = (v: StandardVial) => (v.blank || !v.from ? '—' : v.from === 'stock' ? 'Stock' : v.from);

/** The two lines on a vial card (Run-Standards): ["Stock 120", "Diluent 0"], ["From B 70", "Diluent 70"], ["Diluent 160", "Blank"]. */
export function vialRecipe(v: StandardVial): [string, string] {
  if (v.blank || !v.from) return [`Diluent ${microliters(v.diluent)}`, 'Blank'];
  return [`${v.from === 'stock' ? 'Stock' : `From ${v.from}`} ${microliters(v.take)}`, `Diluent ${microliters(v.diluent)}`];
}

/** The same, as Chapp says it: ["70 µL from B", "70 µL of diluent"], ["120 µL of stock", "no diluent"]. */
export function vialSay(v: StandardVial): [string, string] {
  if (v.blank || !v.from) return [`${microliters(v.diluent)} µL of diluent`, 'nothing else'];
  const take = `${microliters(v.take)} µL ${v.from === 'stock' ? 'of stock' : `from ${v.from}`}`;
  return [take, v.diluent > 0 ? `${microliters(v.diluent)} µL of diluent` : 'no diluent'];
}

/**
 * A series that halves from `top` (µg/mL) `count` times, plus a blank: "Halve from 2,000" and "five standards" in
 * Plan.dc.html. Each vial passes `step` µL on and keeps `step`, where `step` is the plate's need (replicates plus one
 * spare well) rounded up to 50 µL; the first vial is undiluted stock.
 */
export function halvingSeries(top: number, count: number, replicates: number, perWell: number): Series {
  const need = replicates * perWell;
  const step = Math.ceil((need + perWell) / 50) * 50;
  const ids = (i: number) => String.fromCharCode(65 + i);
  const vials: StandardVial[] = [];
  for (let i = 0; i < count; i++) {
    const last = i === count - 1;
    vials.push(
      i === 0
        ? { id: 'A', concentration: top, blank: false, from: 'stock', take: 2 * step, diluent: 0, left: last ? 2 * step : step }
        : { id: ids(i), concentration: top / 2 ** i, blank: false, from: ids(i - 1), take: step, diluent: step, left: last ? 2 * step : step },
    );
  }
  vials.push({ id: ids(count), concentration: 0, blank: true, from: null, take: 0, diluent: step, left: step });
  return {
    vials,
    need,
    stock: 2 * step,
    diluent: vials.reduce((s, v) => s + v.diluent, 0),
    minLeft: Math.min(...vials.map(v => v.left)),
  };
}

// ─── The plate ───────────────────────────────────────────────────────────────────────────────────────────────────

/** One standard vial or one sample: everything that goes onto the plate from one tube, in loading order. */
export type Tube = {
  index: number;
  kind: 'standard' | 'sample';
  /** "A" or "1": what the well shows. */
  ref: string;
  /** "Standard A" or "Sample 1". */
  name: string;
  blank: boolean;
  /** µg/mL, standards only. */
  concentration?: number;
  /** Shade level for standards (see shadeLevels), 0 for the blank and for samples. */
  level: number;
  wells: string[];
};

export type PlateCell = { well: string; row: number; col: number; tube: number; replicate: number };

export type PlatePlan = {
  rows: number;
  cols: number;
  tubes: Tube[];
  cells: PlateCell[];
  /** Columns used; more than `cols` means the plan does not fit one plate (the extra wells are left off `cells`). */
  columns: number;
  fits: boolean;
  wells: number;
};

const ROWS = 'ABCDEFGHIJKLMNOP';

/**
 * The plate as the design lays it out: replicates side by side, standards first, walking down column blocks as wide as
 * the replicate count; samples carry on in the standards' block when their replicate count matches, and start a new
 * block when it does not. "Tube 10 of 21 · Sample 1 → B3 · B4" for 9 standards and 12 samples in duplicate.
 */
export function plateMap(opts: {
  standards: readonly { id: string; concentration: number; blank: boolean }[];
  standardReplicates: number;
  samples: number;
  sampleReplicates: number;
  rows?: number;
  cols?: number;
}): PlatePlan {
  const { standards, standardReplicates, samples, sampleReplicates, rows = 8, cols = 12 } = opts;
  const levels = shadeLevels(standards);
  const tubes: Tube[] = [
    ...standards.map((s, i) => ({ index: i, kind: 'standard' as const, ref: s.id, name: `Standard ${s.id}`, blank: s.blank, concentration: s.concentration, level: levels[i]!, wells: [] as string[] })),
    ...Array.from({ length: samples }, (_, i) => ({ index: standards.length + i, kind: 'sample' as const, ref: String(i + 1), name: `Sample ${i + 1}`, blank: false, level: 0, wells: [] as string[] })),
  ];
  const cells: PlateCell[] = [];
  let row = 0, base = 0, width = 0;
  const place = (from: number, count: number, k: number) => {
    if (width && k !== width) {
      base += width;
      row = 0;
    }
    width = k;
    for (let i = 0; i < count; i++) {
      if (row === rows) {
        base += width;
        row = 0;
      }
      for (let j = 0; j < k; j++) {
        const col = base + j;
        if (col >= cols) continue;
        const well = `${ROWS[row]}${col + 1}`;
        cells.push({ well, row, col, tube: from + i, replicate: j + 1 });
        tubes[from + i]!.wells.push(well);
      }
      row++;
    }
  };
  place(0, standards.length, standardReplicates);
  place(standards.length, samples, sampleReplicates);
  const columns = base + (row ? width : 0);
  return { rows, cols, tubes, cells, columns, fits: columns <= cols, wells: standards.length * standardReplicates + samples * sampleReplicates };
}

/** The most samples that fit beside these standards ("Up to 36 samples fit beside the kit's 9"). */
export function samplesThatFit(standards: Parameters<typeof plateMap>[0]['standards'], standardReplicates: number, sampleReplicates: number, rows = 8, cols = 12) {
  let n = 0;
  while (n < rows * cols && plateMap({ standards, standardReplicates, samples: n + 1, sampleReplicates, rows, cols }).fits) n++;
  return n;
}

/** What each well holds, for shared/fit.ts's analyzePlate(). */
export function wellRoles(plan: PlatePlan): WellRole[] {
  return plan.cells.map(c => {
    const t = plan.tubes[c.tube]!;
    return t.kind === 'standard'
      ? { well: c.well, kind: 'standard', ref: t.ref, concentration: t.concentration ?? 0, blank: t.blank }
      : { well: c.well, kind: 'sample', ref: t.ref };
  });
}

// ─── Working reagent ─────────────────────────────────────────────────────────────────────────────────────────────

/** Amounts worth making (mL): the need plus 10 % for the tips and the trough, rounded up to one of these. */
const NICE_ML = [3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 60, 80, 100];

/**
 * The working reagent to make for `wells` wells (or tubes): the protocol's volume per well, 10 % spare, rounded up to
 * an amount worth measuring, then split by the mix's parts. The main part rounds to 0.1 mL and the small parts follow
 * it at the exact ratio, to the µL: 42 wells × 200 µL = 8.4 mL → make 10 mL = 9.8 mL A + 196 µL B (the manual's 50:1;
 * Run-Mix draws 200 µL, which would be 49:1).
 */
export function reagentPlan(p: Protocol, procedureId: string, wells: number) {
  const found = p.procedures.find(x => x.id === procedureId);
  const proc = found && assayOf(found);
  const mix = proc && p.mixes.find(m => m.id === proc.mix);
  if (!proc || !mix) throw new Error(`procedure "${procedureId}" has no mix`);
  const perWell = toMicroliters(proc.mixPerSample);
  const need = wells * perWell;
  const ml = (need * 1.1) / 1000;
  const make = (NICE_ML.find(v => v >= ml - 1e-9) ?? Math.ceil(ml / 10) * 10) * 1000;
  const total = mix.parts.reduce((s, x) => s + x.parts, 0);
  const main = mix.parts.reduce((a, b) => (b.parts > a.parts ? b : a));
  const mainVolume = Math.round((make * main.parts) / total / 100) * 100;
  const minor = mix.parts.filter(x => x !== main).map(x => ({ ...x, volume: Math.round((mainVolume * x.parts) / main.parts) }));
  const name = (id: string) => {
    const c = p.components.find(x => x.id === id);
    return c?.label?.length ? c.label.reduce((a, b) => (b.length < a.length ? b : a)) : (c?.name ?? id);
  };
  return {
    mix: mix.id,
    /** "Working Reagent". */
    name: mix.name,
    /** "WR". */
    short: mix.short,
    wells,
    /** µL per well (or tube). */
    perWell,
    /** µL the run uses. */
    need,
    /** µL to make. */
    make,
    /** In the mix's order (A, then B), each with the volume to measure (µL) and its exact share of `make` (µL). */
    parts: mix.parts.map(x => ({
      component: x.component,
      name: name(x.component),
      parts: x.parts,
      volume: x === main ? mainVolume : minor.find(m => m.component === x.component)!.volume,
      exact: (make * x.parts) / total,
    })),
    /** "50 : 1". */
    ratio: mix.parts.map(x => x.parts).join(' : '),
  };
}

export type ReagentPlan = ReturnType<typeof reagentPlan>;

// ─── The run: plan → standards → plate ───────────────────────────────────────────────────────────────────────────

/** How the standards are made, Plan-Ask's four ways: the kit's table, halving from the top, five standards, already made. */
export type StandardsWay = 'kit' | 'halve' | 'five' | 'ready';

/** The plan a run is laid out from, as useRun() keeps it: Plan sets it; Run, Results and Share read it back. */
export type RunPlan = { procedure: string; samples: number; replicates: number; standardReplicates: number; standards: StandardsWay };

function procedureOf(p: Protocol, procedureId: string) {
  const proc = p.procedures.find(x => x.id === procedureId);
  if (!proc) throw new Error(`unknown procedure "${procedureId}"`);
  return assayOf(proc);
}

/**
 * How many times the procedure's top standard is halved: as often as it stays inside the kit's range (2,000 → 31.25
 * µg/mL for 20–2,000: seven, plus the blank, "8 vials"), or four for "five standards".
 */
export function halvings(p: Protocol, procedureId: string, way: 'halve' | 'five') {
  const range = procedureOf(p, procedureId).range;
  return way === 'five' ? 4 : Math.floor(Math.log2(range.max / range.min)) + 1;
}

/**
 * The standard vials for a way of making them, sized for `replicates` wells each (Plan.dc.html's ways): the kit's own
 * dilution table (standardSeries), or halving from the top of the kit's range ("Halve from 2,000", "five standards").
 * "Already made" is the kit's vials with nothing to make.
 */
export function standardsFor(p: Protocol, procedureId: string, way: StandardsWay, replicates: number): Series {
  if (way === 'halve' || way === 'five') {
    const proc = procedureOf(p, procedureId);
    // The series is worked out in µg/mL, whatever unit the kit prints its range in.
    const top = toMicrogramsPerMl({ value: proc.range.max, unit: proc.range.unit });
    return halvingSeries(top, halvings(p, procedureId, way), replicates, toMicroliters(proc.sample));
  }
  const s = standardSeries(p, procedureId, replicates);
  return way === 'ready' ? { ...s, stock: 0, diluent: 0 } : s;
}

/**
 * The one source of a run's layout: its standards, the plate (plateMap, standards and samples each with their own
 * replicates), what each well holds (the input of analyzePlate and sampleReadings) and the working reagent to make.
 * Plan draws it, Run loads it, Results reads it back and Share counts it, so all four agree on every well.
 */
export function runSetup(p: Protocol, plan: RunPlan) {
  const series = standardsFor(p, plan.procedure, plan.standards, plan.standardReplicates);
  const plate = plateMap({ standards: series.vials, standardReplicates: plan.standardReplicates, samples: plan.samples, sampleReplicates: plan.replicates });
  return { series, plate, roles: wellRoles(plate), reagent: reagentPlan(p, plan.procedure, plate.wells) };
}

export type RunSetup = ReturnType<typeof runSetup>;

/** 9800 → "9.8 mL", 200 → "200 µL", 10000 → "10 mL". */
export const amountText = (microliters: number) => formatVolume(microliters);

// ─── Steps ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** A step at the bench, with the short name the run screens use ("Load the plate"). */
export type BenchStep = { id: string; stage: Step['stage']; title: string; step: Step };

/**
 * The steps done at the bench, in order: the protocol's steps without the analysis, which is the results screen. For
 * the BCA microplate procedure these are the design's six: Standards, Working reagent, Load the plate, Add the
 * reagent, Incubate, Read.
 */
export function benchSteps(p: Protocol, procedureId: string): BenchStep[] {
  const proc = p.procedures.find(x => x.id === procedureId);
  if (!proc) throw new Error(`unknown procedure "${procedureId}"`);
  const plate = proc.format === 'microplate';
  return proc.steps
    .filter(s => s.stage !== 'analyze')
    .map(s => {
      const adds = s.add ?? [];
      const title =
        s.stage === 'standards' ? 'Standards'
        : s.stage === 'mix' ? 'Working reagent'
        : s.stage === 'load' && adds.some(a => a.what === 'standards-and-samples') ? (plate ? 'Load the plate' : 'Load the tubes')
        : s.stage === 'load' && adds.some(a => a.what === 'mix') ? 'Add the reagent'
        : s.stage === 'incubate' ? 'Incubate'
        : s.stage === 'read' && s.equipment?.length ? 'Read'
        : s.title;
      return { id: s.id, stage: s.stage, title, step: s };
    });
}

const unitText = { s: 's', min: 'min', h: 'h' } as const;
export const durationText = (d: { value: number; unit: 's' | 'min' | 'h' }) => `${d.value} ${unitText[d.unit]}`;
export const temperatureText = (t: { value: number; max?: number }) => (t.max === undefined ? `${t.value} °C` : `${t.value}–${t.max} °C`);

/**
 * The right-hand detail on Run-List: "9 vials", "10 mL", "9 of 21 tubes", "200 µL · shake 30 s", "37 °C · 30 min",
 * "562 nm". `loaded` is how many tubes are on the plate so far, while that step is under way.
 */
export function stepDetail(p: Protocol, step: BenchStep, run: { vials: number; reagent: number; tubes: number; loaded?: number }): string {
  const s = step.step;
  const adds = s.add ?? [];
  if (s.stage === 'standards') return `${run.vials} vials`;
  if (s.stage === 'mix') return amountText(run.reagent);
  if (adds.some(a => a.what === 'standards-and-samples')) return run.loaded === undefined ? `${run.tubes} tubes` : `${run.loaded} of ${run.tubes} tubes`;
  const mix = adds.find(a => a.what === 'mix');
  if (mix) return [formatVolume(toMicroliters(mix.volume)), s.timer && `${s.timer.label.toLowerCase()} ${durationText(s.timer.duration)}`].filter(Boolean).join(' · ');
  if (s.stage === 'incubate' && s.timer) return [s.timer.temperature && temperatureText(s.timer.temperature), durationText(s.timer.duration)].filter(Boolean).join(' · ');
  if (s.stage === 'read' && s.equipment?.length && p.analysis) return `${p.analysis.readout.value} nm`;
  return '';
}

/** "Step 3 of 6 · Load the plate": the line under Chapp's name on the run screens. `index` counts from 0. */
export const stepLabel = (index: number, total: number, title: string) => `Step ${index + 1} of ${total} · ${title}`;

// ─── Time ────────────────────────────────────────────────────────────────────────────────────────────────────────

const pad = (n: number) => (n < 10 ? '0' : '') + n;
/** A wall-clock time as the design writes it: "11:17". */
export const clockText = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
/** Seconds as "24:37" (minutes may pass 59: "120:00"). */
export const countdownText = (seconds: number) => `${Math.floor(seconds / 60)}:${pad(Math.floor(seconds % 60))}`;
/** 1800 → "30 min", 7200 → "2 h". */
export const lengthText = (seconds: number) => (seconds >= 3600 ? `${+(seconds / 3600).toFixed(2)} h` : `${Math.round(seconds / 60)} min`);

// ─── Results ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** One row of a results list (Results-Swipe): number, name, value, and an optional column at the right. */
export type ResultRow = {
  n: string;
  name: string;
  value: string;
  side?: string;
  /** Wears the highlighter: off the curve, too spread, or the one the sentence above is about. */
  mark?: boolean;
  /** A word instead of a number ("rerun"): drawn smaller. */
  note?: boolean;
};

/** Page 1: µg/mL and CV. Above the range shows "> 2,000"; a CV over `cvLimit` % is marked too. */
export function concentrationRows(a: PlateAnalysis, cvLimit = 10): ResultRow[] {
  return a.samples.map(s => ({
    n: s.ref,
    name: `Sample ${s.ref}`,
    value:
      s.flag === 'above' ? `> ${concentrationText(a.range.max)}`
      : s.flag === 'missing' || s.concentration === null ? '—'
      : s.flag === 'below' ? `< ${concentrationText(a.range.min)}`
      : threeFigures(s.concentration),
    side: s.cv === null ? '—' : `${Math.round(s.cv)} %`,
    mark: s.flag !== 'ok' || (s.cv !== null && s.cv > cvLimit),
  }));
}

/** Page 2: µL of each sample that hold `amount` µg; the largest is marked, and gives the lane to plan for. */
export function massRows(a: PlateAnalysis, amount: number) {
  const vols = a.samples.map(s => (s.flag === 'ok' && s.concentration ? volumeForMass(s.concentration, amount) : null));
  const most = vols.reduce<number>((m, v, i) => (v !== null && (m < 0 || v > vols[m]!) ? i : m), -1);
  const rows: ResultRow[] = a.samples.map((s, i) => {
    const v = vols[i];
    return v === null ? { n: s.ref, name: `Sample ${s.ref}`, value: 'rerun', note: true } : { n: s.ref, name: `Sample ${s.ref}`, value: v.toFixed(1), mark: i === most };
  });
  return { rows, most: most >= 0 ? { ref: a.samples[most]!.ref, volume: vols[most]! } : null, lane: most >= 0 ? laneFor(vols[most]!) : null };
}

/** Page 3: one concentration for all, and per `final` µL how much of each to take and how much buffer to add. */
export function commonRows(a: PlateAnalysis, final = 100) {
  const c = commonConcentration(a.samples, final);
  if (!c) return null;
  const rows: ResultRow[] = c.rows.map(r =>
    r.take === null
      ? { n: r.ref, name: `Sample ${r.ref}`, value: 'rerun', note: true, side: '' }
      : { n: r.ref, name: `Sample ${r.ref}`, value: r.take.toFixed(1), side: r.buffer!.toFixed(1), mark: r.ref === c.lowest },
  );
  return { target: c.target, lowest: c.lowest, rows };
}

/**
 * R² to three places, as Results-Swipe-Curve and Share-QR show it (0.9979 → "0.998"), except that a fit short of
 * perfect never rounds up to 1.000. The one formatter for R² on every screen.
 */
export const r2Text = (r2: number) => {
  const x = Math.min(1, Math.max(0, r2));
  return x < 1 && x >= 0.9995 ? '0.999' : x.toFixed(3);
};

/** The curve's axis labels from the protocol: "BSA, µg/mL" (the standard's short label) and "Net A562". */
export function curveLabels(p: Protocol, procedureId: string) {
  const proc = p.procedures.find(x => x.id === procedureId);
  const curve = p.standardCurves.find(c => c.id === proc?.standardCurve);
  const stock = p.components.find(c => c.id === curve?.stock);
  const short = stock?.label?.length ? stock.label.reduce((a, b) => (b.length < a.length ? b : a)) : (stock?.name ?? 'Standard');
  // The curve is drawn in µg/mL (shared/calc.ts works out every standard in it), whatever the kit prints.
  return { x: `${short}, µg/mL`, y: `Net A${p.analysis?.readout.value ?? ''}` };
}
