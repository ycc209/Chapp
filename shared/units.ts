/**
 * Units as the manual prints them, and the few the app can compute with.
 *
 * A protocol keeps every quantity as printed: a number and its unit, whatever the unit is ("500 nL", "10 ng/mL",
 * "5 µM", "0.5 %", "10 U/mL"). Only the places that work something out (Plan, Run, Results, Chapp's run numbers)
 * convert, and only through here: volumes to µL, mass concentrations to µg/mL, molar concentrations to µM. Anything
 * else is not converted (null), and whatever needed it says so instead of guessing.
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

/** Each prefix as a power of ten, so conversions multiply or divide by whole powers and stay exact (1 mL = 1000 µL). */
const PREFIX: Record<string, number> = { p: -12, n: -9, 'µ': -6, m: -3, '': 0 };

/** The prefix's power of ten when `unit` is that prefix on `base` ("nL" on "L" → −9), else null. */
function scale(unit: string, base: string): number | null {
  if (!unit.endsWith(base)) return null;
  return PREFIX[unit.slice(0, -base.length)] ?? null;
}

/** value × 10^power, dividing for a negative power so that 0.1 mL is 100 µL, not 100.00000000000001. */
const shift = (value: number, power: number) => (power >= 0 ? value * 10 ** power : value / 10 ** -power);

type Quantity = { value: number; unit: string };

/** pL, nL, µL, mL or L → µL; null for anything else ("1 vial", "96 wells", "0.5 %"). */
export function toMicroliters(q: Quantity): number | null {
  const f = scale(normalizeUnit(q.unit), 'L');
  return f === null || !Number.isFinite(q.value) ? null : shift(q.value, f + 6);
}

/** A mass per volume (pg, ng, µg, mg or g per µL, mL or L) → µg/mL; null for anything else (µM, %, U/mL). */
export function toMicrogramsPerMl(q: Quantity): number | null {
  const [mass, volume, ...rest] = normalizeUnit(q.unit).split('/');
  if (!mass || !volume || rest.length || !Number.isFinite(q.value)) return null;
  const m = scale(mass, 'g'), v = scale(volume, 'L');
  return m === null || v === null ? null : shift(q.value, m + 6 - (v + 3));
}

/** pM, nM, µM, mM or M → µM; null for anything else. Kept apart from mass: the app never turns one into the other. */
export function toMicromolar(q: Quantity): number | null {
  const f = scale(normalizeUnit(q.unit), 'M');
  return f === null || !Number.isFinite(q.value) ? null : shift(q.value, f + 6);
}

/** What kind of quantity a unit measures, as far as the app can compute with it. */
export function unitKind(unit: string): 'volume' | 'mass-concentration' | 'molar' | null {
  if (toMicroliters({ value: 1, unit }) !== null) return 'volume';
  if (toMicrogramsPerMl({ value: 1, unit }) !== null) return 'mass-concentration';
  if (toMicromolar({ value: 1, unit }) !== null) return 'molar';
  return null;
}

/**
 * Two concentrations on one scale, so a dilution can be checked: mass to µg/mL, molar to µM, or as printed when both
 * have the same unit. Null when they cannot be compared (different kinds, or different units the app does not know).
 */
export function comparable(a: Quantity, b: Quantity): [number, number] | null {
  const ma = toMicrogramsPerMl(a), mb = toMicrogramsPerMl(b);
  if (ma !== null && mb !== null) return [ma, mb];
  const ca = toMicromolar(a), cb = toMicromolar(b);
  if (ca !== null && cb !== null) return [ca, cb];
  return normalizeUnit(a.unit) === normalizeUnit(b.unit) ? [a.value, b.value] : null;
}
