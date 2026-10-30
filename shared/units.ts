/**
 * Units as the manual prints them, worked out by their dimensions.
 *
 * A protocol keeps every quantity as printed: a number and its unit, whatever the unit is ("500 nL", "10 ng/mL",
 * "5 µM", "2 nmol/well", "0.5 %", "10 U/mL"). Only the places that work something out (Plan, Run, Results, Chapp's
 * run numbers) convert, and only through here. A unit is read as a product of base units with SI prefixes (g, mol,
 * M = mol/L, L, well), so anything made of those converts to anything of the same dimensions: µg/mL to mg/mL, mM to
 * µM, pmol/well to nmol/well. A concentration per litre becomes an amount per well through the well's volume (1 mM
 * in a 50 µL well is 50 nmol/well), and back. A unit the manual defines in its own words ("1 U = 0.5 µg", read by
 * the model and checked here) is added as `known`. Anything else is not converted (null), and whatever needed it
 * says so instead of guessing.
 */

/** "ul", "μL" (Greek mu), "ml", "ug/ml", " mg / mL " → "µL", "µL", "mL", "µg/mL", "mg/mL": the unit tidied for display. */
export function normalizeUnit(unit: string): string {
  const tidy = unit.trim().replace(/\s*\/\s*/g, '/').replace(/\s+/g, ' ');
  return tidy
    .split('/')
    .map(part =>
      part
        // A micro prefix (u or the Greek mu) before a litre, gram, mole or molar.
        .replace(/^[uμ](?=(?:l|L|g|M|mol)$)/, 'µ')
        // Litres take a capital L: "ml" → "mL", "µl" → "µL", "l" → "L".
        .replace(/^([pnµmcd]?)l$/, '$1L'),
    )
    .join('/');
}

/** The dimensions of a unit: powers of gram, mole, litre and well. */
export type Dim = { g: number; mol: number; L: number; well: number };
/** A unit read: a value in it is `value × mul × 10^pow` in base units (g, mol, L, well) of `dim`. */
export type Parsed = { pow: number; mul: number; dim: Dim };
type Quantity = { value: number; unit: string };

/** Each prefix as a power of ten, so conversions multiply or divide by whole powers and stay exact (1 mL = 1000 µL). */
const PREFIX: Record<string, number> = { p: -12, n: -9, 'µ': -6, m: -3, '': 0, k: 3 };
const NONE: Dim = { g: 0, mol: 0, L: 0, well: 0 };
/** The base units, each in its dimensions. M (molar) is a mole per litre. */
const BASE: Record<string, Partial<Dim>> = { g: { g: 1 }, mol: { mol: 1 }, M: { mol: 1, L: -1 }, L: { L: 1 }, well: { well: 1 } };

/** value × 10^power, dividing for a negative power so that 0.1 mL is 100 µL, not 100.00000000000001. */
const shift = (value: number, power: number) => (power >= 0 ? value * 10 ** power : value / 10 ** -power);

const sameDim = (a: Dim, b: Dim) => a.g === b.g && a.mol === b.mol && a.L === b.L && a.well === b.well;

/** One term of a unit ("µg", "mM", "well"): a prefix on a base unit, or a unit the manual defined. */
function term(t: string, known: Record<string, Parsed>): Parsed | null {
  if (known[t]) return known[t];
  for (const base of Object.keys(BASE)) {
    if (!t.endsWith(base)) continue;
    const pow = PREFIX[t.slice(0, -base.length)];
    if (pow !== undefined) return { pow, mul: 1, dim: { ...NONE, ...BASE[base] } };
  }
  return null;
}

/** The unit read into its dimensions ("µg/mL": g¹ L⁻¹ at 10⁻³ of g/L); null for one the app cannot read ("%", "U/mL"). */
export function parseUnit(unit: string, known: Record<string, Parsed> = {}): Parsed | null {
  const tidy = normalizeUnit(unit);
  if (!tidy) return null;
  const [top, ...unders] = tidy.split('/').map(t => term(t, known));
  if (!top || unders.some(u => u === null)) return null;
  const out: Parsed = { pow: top.pow, mul: top.mul, dim: { ...top.dim } };
  for (const u of unders as Parsed[]) {
    out.pow -= u.pow;
    out.mul /= u.mul;
    for (const k of Object.keys(NONE) as (keyof Dim)[]) out.dim[k] -= u.dim[k];
  }
  return out;
}

export type Convert = {
  /** The well's volume in µL: a concentration per litre becomes an amount per well through it, and back. */
  perWell?: number;
  /** Units the manual defines itself, read by the model and checked (knownUnits). */
  known?: Record<string, Parsed>;
};

/**
 * `q` in `unit`: the same dimensions, or a per-litre concentration as a per-well amount (and back) when the well's
 * volume is given. Null when it cannot be (mass against moles, a unit the app cannot read).
 */
export function convert(q: Quantity, unit: string, opts: Convert = {}): number | null {
  if (!Number.isFinite(q.value)) return null;
  const known = opts.known ?? {};
  const from = parseUnit(q.unit, known), to = parseUnit(unit, known);
  if (!from || !to) return null;
  const exact = (v: number) => Number(v.toPrecision(12));
  if (sameDim(from.dim, to.dim)) return exact(shift(q.value, from.pow - to.pow) * (from.mul / to.mul));
  if (!opts.perWell) return null;
  // Per litre → per well: × the well's litres (perWell µL = perWell × 10⁻⁶ L); per well → per litre: ÷.
  const litreToWell = { ...from.dim, L: from.dim.L + 1, well: from.dim.well - 1 };
  if (sameDim(litreToWell, to.dim)) return exact(shift(q.value * opts.perWell, from.pow - to.pow - 6) * (from.mul / to.mul));
  const wellToLitre = { ...from.dim, L: from.dim.L - 1, well: from.dim.well + 1 };
  if (sameDim(wellToLitre, to.dim)) return exact((shift(q.value, from.pow - to.pow + 6) / opts.perWell) * (from.mul / to.mul));
  return null;
}

/**
 * Units the manual defines in its own words, as the model read them ("1 U = 0.5 µg", "1 IU = 2.5 nmol"), each checked
 * here: its equivalent must be a unit the app reads, so a value in it converts like any other.
 */
export function knownUnits(defined: { unit: string; equals: Quantity }[]): Record<string, Parsed> {
  const known: Record<string, Parsed> = {};
  for (const d of defined) {
    const eq = parseUnit(d.equals.unit, known);
    if (!eq || !(d.equals.value > 0) || !/^[A-Za-z]+$/.test(d.unit.trim())) continue;
    known[d.unit.trim()] = { pow: eq.pow, mul: eq.mul * d.equals.value, dim: eq.dim };
  }
  return known;
}

/** pL, nL, µL, mL or L → µL; null for anything else ("1 vial", "96 wells", "0.5 %"). */
export const toMicroliters = (q: Quantity): number | null => convert(q, 'µL');

/** A mass per volume (pg, ng, µg, mg or g per µL, mL or L) → µg/mL; null for anything else (µM, %, U/mL). */
export const toMicrogramsPerMl = (q: Quantity): number | null => convert(q, 'µg/mL');

/** pM, nM, µM, mM or M → µM; null for anything else. Mass never turns into moles here. */
export const toMicromolar = (q: Quantity): number | null => convert(q, 'µM');

/** What kind of quantity a unit measures, as far as the app can compute with it. */
export function unitKind(unit: string, known?: Record<string, Parsed>): 'volume' | 'mass-concentration' | 'molar' | 'amount-per-well' | 'other' | null {
  const p = parseUnit(unit, known);
  if (!p) return null;
  const is = (d: Partial<Dim>) => sameDim(p.dim, { ...NONE, ...d });
  if (is({ L: 1 })) return 'volume';
  if (is({ g: 1, L: -1 })) return 'mass-concentration';
  if (is({ mol: 1, L: -1 })) return 'molar';
  if (is({ mol: 1, well: -1 })) return 'amount-per-well';
  return 'other';
}

/** The unit each kind of concentration is compared in. */
const CANON: Partial<Record<NonNullable<ReturnType<typeof unitKind>>, string>> = { 'mass-concentration': 'µg/mL', molar: 'µM', 'amount-per-well': 'nmol/well' };

/**
 * Two concentrations on one scale, so a dilution can be checked: mass in µg/mL, molar in µM, per-well amounts in
 * nmol/well, anything else of the same dimensions in the first's unit, or as printed when both have the same unit.
 * Null when they cannot be compared (mass against moles, or units the app does not know).
 */
export function comparable(a: Quantity, b: Quantity, known?: Record<string, Parsed>): [number, number] | null {
  const kind = unitKind(a.unit, known);
  const to = (kind && CANON[kind]) || a.unit;
  const ca = convert(a, to, { known }), cb = convert(b, to, { known });
  if (ca !== null && cb !== null) return [ca, cb];
  return normalizeUnit(a.unit) === normalizeUnit(b.unit) ? [a.value, b.value] : null;
}
