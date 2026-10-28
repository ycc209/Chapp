import { isAssay, type Concentration, type Procedure, type Protocol, type Volume } from './protocol.ts';
import { toMicrogramsPerMl as micrograms, toMicroliters as microliters } from './units.ts';

/**
 * Run-dependent numbers. Pure functions of the protocol document and the user's conditions. The protocol keeps every
 * amount as printed; these work in µL and µg/mL (shared/units.ts), and only for a procedure that is plannable.
 */

/** A volume in µL; throws for one in a unit that is not a volume (isPlannable says beforehand). */
export function toMicroliters(v: Volume): number {
  // Nothing needs no unit ("0" in a table).
  const n = v.value === 0 ? 0 : microliters(v);
  if (n === null) throw new Error(`${v.value} ${v.unit} is not a volume Chapp can work with`);
  return n;
}

/** A concentration in µg/mL; throws for one that is not a mass per volume (isPlannable says beforehand). */
export function toMicrogramsPerMl(c: Concentration): number {
  const n = c.value === 0 ? 0 : micrograms(c);
  if (n === null) throw new Error(`${c.value} ${c.unit} is not a concentration Chapp can work with`);
  return n;
}

/**
 * Why the app cannot work out this procedure's amounts, in words fit to show ("the standards are in µM"); null when
 * it can. Plan, Run and Results compute in µL and µg/mL: the sample and reagent volumes, the dilution table's volumes
 * and concentrations, the working range and what each step adds all have to convert. Never a guess: a unit Chapp
 * cannot convert leaves the run to the printed protocol.
 */
export function unitsProblem(p: Protocol, proc: Procedure): string | null {
  const unit = (q: { value: number; unit: string }) => `${q.value} ${q.unit}`;
  if (proc.sample && microliters(proc.sample) === null) return `the sample is ${unit(proc.sample)}`;
  if (proc.mixPerSample && microliters(proc.mixPerSample) === null) return `the reagent per sample is ${unit(proc.mixPerSample)}`;
  if (proc.range && micrograms({ value: proc.range.max, unit: proc.range.unit }) === null) return `the working range is in ${proc.range.unit}`;
  const curve = p.standardCurves.find(c => c.id === proc.standardCurve);
  const stock = curve && p.components.find(c => c.id === curve.stock)?.concentration;
  if (stock && micrograms(stock) === null) return `the standard is ${unit(stock)}`;
  for (const pt of curve?.points ?? []) {
    if (micrograms(pt.concentration) === null && pt.concentration.value !== 0) return `the standards are in ${pt.concentration.unit}`;
    for (const v of [pt.take, pt.diluent]) if (microliters(v) === null && v.value !== 0) return `the dilution table measures in ${v.unit}`;
  }
  for (const step of proc.steps) for (const a of step.add ?? []) if (microliters(a.volume) === null) return `a step adds ${unit(a.volume)}`;
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

/**
 * The working reagent a run needs, using the source's own formula:
 * (# standards + # unknowns) × (# replicates) × (volume of WR per sample).
 */
export function workingReagent(p: Protocol, procedureId: string, samples: number, replicates: number) {
  const { curve, mix, mixPerSample } = procedureOf(p, procedureId);
  const total = (curve.points.length + samples) * replicates * toMicroliters(mixPerSample);
  const parts = mix.parts.reduce((sum, part) => sum + part.parts, 0);
  return {
    mix: mix.id,
    total,
    parts: mix.parts.map(part => ({ component: part.component, volume: (total * part.parts) / parts })),
  };
}

/** One vial of a sized series. Volumes in µL, concentration in µg/mL. */
export type StandardVial = {
  id: string;
  concentration: number;
  blank: boolean;
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
  const { curve, sample } = procedureOf(p, procedureId);
  const perWell = toMicroliters(sample);
  const need = replicates * perWell;
  const passedOn = new Map<string, number>();
  for (const pt of curve.points) {
    if (pt.from && pt.from !== 'stock') passedOn.set(pt.from, (passedOn.get(pt.from) ?? 0) + toMicroliters(pt.take));
  }
  const printed = curve.points.map(pt => ({
    id: pt.id,
    concentration: toMicrogramsPerMl(pt.concentration),
    blank: pt.blank ?? false,
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
    ...curve.points.map(pt => ({ kind: 'standard' as const, ref: pt.id })),
    ...Array.from({ length: samples }, (_, i) => ({ kind: 'sample' as const, ref: String(i + 1) })),
  ].flatMap(item => Array.from({ length: replicates }, (_, r) => ({ ...item, replicate: r + 1 })));
  if (items.length > rows * cols) throw new Error(`${items.length} wells do not fit a ${rows}×${cols} plate`);
  return items.map((item, i) => ({ ...item, well: `${String.fromCharCode(65 + (i % rows))}${Math.floor(i / rows) + 1}` }));
}
