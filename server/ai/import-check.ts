import type { Concentration, Procedure, Protocol, Volume } from '../../shared/protocol.ts';
import { toMicrogramsPerMl, toMicroliters } from '../../shared/units.ts';

/**
 * How close an imported protocol is to a hand-made one of the same manual: the numbers the bench depends on, one
 * check each. Used by scripts/import-protocol.ts (the BCA benchmark) and the import tests.
 */

export type Check = { what: string; ok: boolean; expected: string; got: string };

// Compared on one scale (µL, µg/mL) when the units convert, else as printed (shared/units.ts).
const ul = (v?: Volume) => (v ? (toMicroliters(v) ?? `${v.value} ${v.unit}`) : NaN);
const ugml = (c?: Concentration) => (c ? (toMicrogramsPerMl(c) ?? `${c.value} ${c.unit}`) : NaN);
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const temp = (t?: { value: number; max?: number }) => (t ? (t.max === undefined ? `${t.value} °C` : `${t.value}–${t.max} °C`) : 'none');
const seconds = (d?: { value: number; unit: string }) => (d ? d.value * ({ s: 1, min: 60, h: 3600 } as Record<string, number>)[d.unit]! : NaN);

/**
 * How many steps a procedure has, counting a read step that also lets things reach room temperature ("Equilibrate to
 * room temperature, then read at 562 nm") as the two steps it folds together: the steps prompt asks for that, and the
 * hand-made BCA protocol has it both ways (cool and read in one microplate step, in two test-tube steps). Changed on
 * 2026-10-28; before, those reads made the test-tube count 7 against 8.
 */
function stepCount(proc: Procedure): number {
  const cools = /room temperature|equilibrat|\bcool/i, reads = /\bread|measure|absorbance/i;
  return proc.steps.reduce((n, s) => n + (s.stage === 'read' && cools.test(`${s.title} ${s.key}`) && reads.test(`${s.title} ${s.key}`) ? 2 : 1), 0);
}

/** The imported procedure that is the hand-made one: same format, else same name. */
function procedureLike(got: Protocol, proc: Procedure) {
  return got.procedures.find(p => p.format === proc.format) ?? got.procedures.find(p => words(p.name) === words(proc.name));
}

export function compareProtocols(gold: Protocol, got: Protocol): Check[] {
  const checks: Check[] = [];
  const check = (what: string, expected: unknown, actual: unknown) => {
    const e = typeof expected === 'string' ? expected : JSON.stringify(expected);
    const a = typeof actual === 'string' ? actual : JSON.stringify(actual);
    checks.push({ what, ok: e === a, expected: e, got: a ?? 'none' });
  };

  // The document and the kit.
  for (const key of ['publisher', 'docId', 'revision', 'date', 'pages'] as const) check(`source ${key}`, gold.source[key], got.source[key]);
  check('kit catalog numbers', gold.kit.variants.map(v => v.catalog).sort(), got.kit.variants.map(v => v.catalog).sort());
  check('overview lines', gold.overview.steps.map(words), got.overview.steps.map(words));

  // The bottles: each hand-made component has one of the same role and concentration.
  check('kit bottles', gold.components.filter(c => c.suppliedBy === 'kit').length, got.components.filter(c => c.suppliedBy === 'kit').length);
  for (const c of gold.components.filter(x => x.concentration)) {
    const same = got.components.find(x => x.role === c.role && ugml(x.concentration) === ugml(c.concentration));
    check(`${c.name} at ${ugml(c.concentration)} µg/mL`, true, Boolean(same));
  }

  // The mixes: the same parts.
  for (const m of gold.mixes) {
    const parts = (x: { parts: { parts: number }[] }) => x.parts.map(p => p.parts).sort((a, b) => b - a).join(':');
    check(`${m.name} ${parts(m)}`, parts(m), got.mixes.map(parts).find(p => p === parts(m)) ?? got.mixes.map(parts).join(', '));
  }

  // Each procedure's volumes, range, timers and steps.
  for (const proc of gold.procedures) {
    const p = procedureLike(got, proc);
    const at = proc.name.toLowerCase();
    if (!p) {
      check(`${at} procedure`, proc.format, 'missing');
      continue;
    }
    check(`${at} sample per ${proc.format === 'tube' ? 'tube' : 'well'} (µL)`, ul(proc.sample), ul(p.sample));
    check(`${at} working reagent per ${proc.format === 'tube' ? 'tube' : 'well'} (µL)`, ul(proc.mixPerSample), ul(p.mixPerSample));
    check(`${at} ratio`, proc.ratio, p.ratio ?? 'none');
    check(`${at} working range`, proc.range, p.range ?? 'none');
    check(`${at} steps`, stepCount(proc), stepCount(p));
    const incubate = (x: Procedure) => x.steps.find(s => s.stage === 'incubate' && s.timer)?.timer;
    const gi = incubate(proc), pi = incubate(p);
    check(`${at} incubation`, `${temp(gi?.temperature)} · ${seconds(gi?.duration)} s`, `${temp(pi?.temperature)} · ${seconds(pi?.duration)} s`);
    const alts = (t?: typeof gi) => (t?.alternatives ?? []).map(a => `${temp(a.temperature)} · ${seconds(a.duration)} s`).sort();
    check(`${at} other incubations`, alts(gi), alts(pi));
    const shake = (x: Procedure) => x.steps.flatMap(s => (s.timer && s.stage !== 'incubate' ? [seconds(s.timer.duration)] : []));
    check(`${at} other timers (s)`, shake(proc), shake(p));
    const adds = (x: Procedure) => x.steps.flatMap(s => (s.add ?? []).map(a => `${a.what} ${ul(a.volume)} µL per ${a.per}`));
    check(`${at} additions`, adds(proc), adds(p));
  }

  // The dilution tables, vial by vial.
  for (const curve of gold.standardCurves) {
    const same = got.standardCurves.find(c => ugml({ value: c.range.max, unit: c.range.unit }) === ugml({ value: curve.range.max, unit: curve.range.unit }));
    const rows = (c: typeof curve) => c.points.map(pt => `${pt.id}: ${ul(pt.diluent)} + ${ul(pt.take)} of ${pt.from ?? 'none'} = ${ugml(pt.concentration)}${pt.blank ? ' blank' : ''}`);
    if (!same) {
      check(`${curve.name} table`, rows(curve).length, 'missing');
      continue;
    }
    check(`${curve.name} range`, curve.range, same.range);
    const gotRows = rows(same);
    rows(curve).forEach((row, i) => check(`${curve.name} vial ${curve.points[i]!.id}`, row, gotRows[i] ?? 'missing'));
    if (gotRows.length > curve.points.length) check(`${curve.name} vials`, curve.points.length, gotRows.length);
  }

  // Reading and fitting.
  check('readout (nm)', gold.analysis?.readout.value, got.analysis?.readout.value);
  check('acceptable wavelengths', gold.analysis?.acceptable ?? 'none', got.analysis?.acceptable ?? 'none');
  check('preferred fits', [...(gold.analysis?.fit.preferred ?? [])].sort(), [...(got.analysis?.fit.preferred ?? [])].sort());
  check('example run', `${gold.defaults.samples} × ${gold.defaults.replicates}`, `${got.defaults.samples} × ${got.defaults.replicates}`);
  return checks;
}
