import { isAssay, type Concentration, type Procedure, type Protocol, type Volume } from './protocol.ts';
import { convert, knownUnits, normalizeUnit, parseUnit, toMicroliters as microliters, unitKind, type Dim, type Parsed } from './units.ts';

/**
 * Run-dependent numbers. Pure functions of the protocol document and the user's conditions. The protocol keeps every
 * amount as printed; these work in µL and on the procedure's own scale (shared/units.ts: the unit its working range
 * is printed in, µg/mL for a mass concentration), and only for a procedure that is plannable.
 */

/** Units the manual defined itself, for this protocol's conversions. */
export const knownOf = (p: Protocol): Record<string, Parsed> => knownUnits(p.units ?? []);

/** A volume in µL; throws for one in a unit that is not a volume (isPlannable says beforehand). */
export function toMicroliters(v: Volume): number {
  // Nothing needs no unit ("0" in a table).
  const n = v.value === 0 ? 0 : microliters(v);
  if (n === null) throw new Error(`${v.value} ${v.unit} is not a volume Chapp can work with`);
  return n;
}

/** A concentration in µg/mL; throws for one that is not a mass per volume. */
export function toMicrogramsPerMl(c: Concentration): number {
  const n = c.value === 0 ? 0 : convert(c, 'µg/mL');
  if (n === null) throw new Error(`${c.value} ${c.unit} is not a concentration Chapp can work with`);
  return n;
}

/**
 * The scale a procedure's standards are worked out on: the unit the kit prints its working range in ("nmol/well",
 * "µM"), or µg/mL for any mass concentration (Results' mass pages read that). Every concentration the plan touches is
 * put on it (onScale): the same dimensions convert outright, and a per-litre concentration becomes a per-well amount
 * through the well's volume (10 mM stock in a 50 µL well is 500 nmol/well).
 */
export type Scale = { unit: string; dim: Dim };

function scaleOf(p: Protocol, proc: Procedure): Scale | null {
  const known = knownOf(p);
  const curve = p.standardCurves.find(c => c.id === proc.standardCurve);
  const printed = proc.range?.unit ?? curve?.range?.unit ?? curve?.points.find(pt => !pt.intermediate && pt.concentration.value > 0)?.concentration.unit;
  const parsed = printed === undefined ? null : parseUnit(printed, known);
  if (!parsed || printed === undefined) return null;
  return { unit: unitKind(printed, known) === 'mass-concentration' ? 'µg/mL' : normalizeUnit(printed), dim: parsed.dim };
}

/** The procedure's scale; throws when it has none (isPlannable says beforehand). */
export function scaleFor(p: Protocol, proc: Procedure): Scale {
  const s = scaleOf(p, proc);
  if (!s) throw new Error(`procedure "${proc.id}" has no scale to work its standards out on`);
  return s;
}

const perWellOf = (proc: Procedure) => (proc.sample ? (microliters(proc.sample) ?? undefined) : undefined);

/** `q` on the procedure's scale; null when it cannot be put there. */
export function onScaleOf(p: Protocol, proc: Procedure, q: Concentration): number | null {
  const s = scaleOf(p, proc);
  if (!s) return null;
  if (q.value === 0) return 0;
  return convert(q, s.unit, { perWell: perWellOf(proc), known: knownOf(p) });
}

/** `q` on the procedure's scale; throws when it cannot be (isPlannable says beforehand). */
export function onScale(p: Protocol, proc: Procedure, q: Concentration): number {
  const n = onScaleOf(p, proc, q);
  if (n === null) throw new Error(`${q.value} ${q.unit} cannot be put on the scale of procedure "${proc.id}"`);
  return n;
}

/**
 * Why the app cannot work out this procedure's amounts, in words fit to show ("the standards are in %"); null when
 * it can. Plan, Run and Results compute in µL and on the procedure's scale: the sample and reagent volumes, the
 * dilution table's volumes and concentrations, the stock, the working range and what each step adds all have to
 * convert. Never a guess: a unit Chapp cannot read leaves the run to the printed protocol.
 */
export function unitsProblem(p: Protocol, proc: Procedure): string | null {
  const unit = (q: { value: number; unit: string }) => `${q.value} ${q.unit}`;
  if (proc.sample && microliters(proc.sample) === null) return `the sample is ${unit(proc.sample)}`;
  if (proc.mixPerSample && microliters(proc.mixPerSample) === null) return `the reagent per sample is ${unit(proc.mixPerSample)}`;
  for (const step of proc.steps) for (const a of step.add ?? []) if (microliters(a.volume) === null) return `a step adds ${unit(a.volume)}`;
  if (proc.range && !parseUnit(proc.range.unit, knownOf(p))) return `the working range is in ${proc.range.unit}`;
  const curve = p.standardCurves.find(c => c.id === proc.standardCurve);
  if (proc.standardCurve && !curve) return `its standard curve "${proc.standardCurve}" is not in the protocol`;
  if (proc.mix && !p.mixes.some(m => m.id === proc.mix)) return `its reagent mix "${proc.mix}" is not in the protocol`;
  if (!curve) return null;
  const off = (q: Concentration) => q.value !== 0 && onScaleOf(p, proc, q) === null;
  const stock = p.components.find(c => c.id === curve.stock)?.concentration;
  if (stock && off(stock)) return `the standard is ${unit(stock)}`;
  for (const pt of curve.points) {
    if (off(pt.concentration)) return `the standards are in ${pt.concentration.unit}`;
    for (const v of [pt.take, pt.diluent]) if (microliters(v) === null && v.value !== 0) return `the dilution table measures in ${v.unit}`;
  }
  return null;
}

/** Can the app plan and run this procedure: an assay (standards, a reagent, a plate) whose amounts it can convert? */
export const isPlannable = (p: Protocol, proc: Procedure) => isAssay(proc) && unitsProblem(p, proc) === null;

/** 8235.3 → "8.24 mL", 164.7 → "165 µL", 4.25 → "4.3 µL". */
export function formatVolume(microliters: number): string {
  if (microliters >= 1000) return `${+(microliters / 1000).toFixed(2)} mL`;
  if (microliters >= 10) return `${Math.round(microliters)} µL`;
  return `${+microliters.toFixed(1)} µL`;
}

function procedureOf(p: Protocol, id: string) {
  const proc = p.procedures.find(x => x.id === id);
  if (!proc) throw new Error(`unknown procedure "${id}"`);
  const curve = p.standardCurves.find(c => c.id === proc.standardCurve);
  const mix = p.mixes.find(m => m.id === proc.mix);
  const { sample, mixPerSample } = proc;
  if (!curve || !mix || !sample || !mixPerSample) throw new Error(`procedure "${id}" is missing its standard curve or mix`);
  return { proc, curve, mix, sample, mixPerSample };
}

/** The sample : reagent ratio as the kit prints it ("1:8"), or from the volumes when it prints none (50 µL + 50 µL: "1:1"). */
export function ratioOf(proc: Pick<Procedure, 'ratio' | 'sample' | 'mixPerSample'>): string {
  if (proc.ratio) return proc.ratio;
  const a = proc.sample && microliters(proc.sample), b = proc.mixPerSample && microliters(proc.mixPerSample);
  if (!a || !b) return '';
  const gcd = (x: number, y: number): number => (y ? gcd(y, x % y) : x);
  const g = gcd(Math.round(a), Math.round(b)) || 1;
  return `${Math.round(a) / g}:${Math.round(b) / g}`;
}

/** The curve's standards that go on the plate: every vial but a working dilution (intermediate). */
export const plated = <T extends { intermediate?: boolean }>(curve: { points: T[] }): T[] => curve.points.filter(pt => !pt.intermediate);

/** The unit the procedure's standards and results are in ("µg/mL", "nmol/well"). */
export const unitOf = (p: Protocol, procedureId: string): string => scaleFor(p, procedureOf(p, procedureId).proc).unit;

/**
 * The working reagent a run needs, using the source's own formula:
 * (# standards + # unknowns) × (# replicates) × (volume of WR per sample).
 */
export function workingReagent(p: Protocol, procedureId: string, samples: number, replicates: number) {
  const { curve, mix, mixPerSample } = procedureOf(p, procedureId);
  const total = (plated(curve).length + samples) * replicates * toMicroliters(mixPerSample);
  const parts = mix.parts.reduce((sum, part) => sum + part.parts, 0);
  return {
    mix: mix.id,
    total,
    parts: mix.parts.map(part => ({ component: part.component, volume: (total * part.parts) / parts })),
  };
}

/** One vial of a sized series. Volumes in µL, concentration on the procedure's scale (unitOf). */
export type StandardVial = {
  id: string;
  concentration: number;
  blank: boolean;
  /** A working dilution later vials draw from: made, but not a standard on the plate. */
  intermediate?: boolean;
  /** A working dilution's concentration as the manual prints it ("1 mM"): it is never in a well, so never per well. */
  printed?: { value: number; unit: string };
  /** 'stock', an earlier vial, or null for the blank. */
  from: string | null;
  take: number;
  diluent: number;
  /** What the vial still holds once later vials have taken their share: this is what the plate draws on. */
  left: number;
};

/**
 * The dilution series sized for this run. Concentrations stay as printed; every volume is scaled by
 * the smallest whole fifth (1/5, 2/5, …) that leaves each vial enough for its replicates plus one
 * spare. Tables shared with a test-tube procedure make far more than a plate needs.
 */
export function standardSeries(p: Protocol, procedureId: string, replicates: number) {
  const { proc, curve, sample } = procedureOf(p, procedureId);
  const perWell = toMicroliters(sample);
  const need = replicates * perWell;
  const passedOn = new Map<string, number>();
  for (const pt of curve.points) {
    if (pt.from && pt.from !== 'stock') passedOn.set(pt.from, (passedOn.get(pt.from) ?? 0) + toMicroliters(pt.take));
  }
  const printed = curve.points.map(pt => ({
    id: pt.id,
    concentration: onScale(p, proc, pt.concentration),
    blank: pt.blank ?? false,
    intermediate: pt.intermediate ?? false,
    ...(pt.intermediate ? { printed: { value: pt.concentration.value, unit: normalizeUnit(pt.concentration.unit) } } : {}),
    from: pt.from,
    take: toMicroliters(pt.take),
    diluent: toMicroliters(pt.diluent),
    left: toMicroliters(pt.take) + toMicroliters(pt.diluent) - (passedOn.get(pt.id) ?? 0),
  }));
  // Whole fifths keep the BCA table's 25 µL steps whole. The epsilon keeps an exact fit from rounding up a step.
  const fifths = Math.ceil(((need + perWell) / Math.min(...printed.map(v => v.left))) * 5 - 1e-9);
  const size = (microliters: number) => (microliters * fifths) / 5;
  const vials: StandardVial[] = printed.map(v => ({ ...v, take: size(v.take), diluent: size(v.diluent), left: size(v.left) }));
  return {
    scale: fifths / 5,
    unit: scaleFor(p, proc).unit,
    /** What the plate takes from each vial. */
    need,
    minLeft: Math.min(...vials.map(v => v.left)),
    stock: vials.reduce((sum, v) => sum + (v.from === 'stock' ? v.take : 0), 0),
    diluent: vials.reduce((sum, v) => sum + v.diluent, 0),
    vials,
  };
}

export type Well = { well: string; kind: 'standard' | 'sample'; ref: string; replicate: number };

/** Standards first (in table order), then samples, each replicate in the next well, filling column by column. */
export function plateLayout(p: Protocol, procedureId: string, samples: number, replicates: number, rows = 8, cols = 12): Well[] {
  const { curve } = procedureOf(p, procedureId);
  const items = [
    ...plated(curve).map(pt => ({ kind: 'standard' as const, ref: pt.id })),
    ...Array.from({ length: samples }, (_, i) => ({ kind: 'sample' as const, ref: String(i + 1) })),
  ].flatMap(item => Array.from({ length: replicates }, (_, r) => ({ ...item, replicate: r + 1 })));
  if (items.length > rows * cols) throw new Error(`${items.length} wells do not fit a ${rows}×${cols} plate`);
  return items.map((item, i) => ({ ...item, well: `${String.fromCharCode(65 + (i % rows))}${Math.floor(i / rows) + 1}` }));
}
