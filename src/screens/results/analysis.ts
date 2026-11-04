import { analyzePlate, type FitPlan, type PlateAnalysis, type WellRole } from '../../../shared/fit.ts';
import { analysisOf, type Protocol } from '../../../shared/protocol.ts';
import { concentrationRows, concentrationText, r2Text, runSetup, standardsFor, type PlatePlan, type StandardVial } from '../../components/lab/model.ts';
import type { RunState } from '../../state/run.ts';

/**
 * The results screen's numbers and words, worked out from the run's plan and readings: which well holds what
 * (plateMap, the same layout the run loaded), the analysis (shared/fit.ts), and Chapp's sentence above each page.
 * Pure, so the tests check exactly what the screen shows. Nothing here is typed in: every number comes from the
 * readings.
 */

/**
 * The two pages, in the order the tabs and the swipe show them, the curve first; `?page=` takes these names. Only
 * the standard curve and the samples' concentrations: the µL-for-an-amount and all-at-one-concentration pages were
 * taken out (2026-11-04), and a question about either goes to Chapp.
 */
export const PAGES = ['curve', 'conc'] as const;
export type PageId = (typeof PAGES)[number];

/** A CV above this, %, gets the highlighter (Results-Swipe's `cvLimit`). */
export const CV_LIMIT = 10;

export type RunPlan = Pick<RunState, 'procedure' | 'samples' | 'replicates' | 'standardReplicates' | 'standards'> & { edits?: RunState['edits'] };

/**
 * The standards on the plate, made the way the plan says (Plan.dc.html's ways, runSetup): the kit's dilution table
 * (also what "already made" holds), halving from the top of the kit's range into 8 vials, or five standards (four
 * halvings and the blank).
 */
export function planStandards(p: Protocol, run: RunPlan): StandardVial[] {
  return standardsFor(p, run.procedure, run.standards, run.standardReplicates).vials;
}

/**
 * The plate as the run laid it out (runSetup, the layout Plan drew and Run loaded), and what each well holds (the
 * input analyzePlate and sampleReadings take).
 */
export function runPlate(p: Protocol, run: RunPlan): { plan: PlatePlan; roles: WellRole[] } {
  const { plate, roles } = runSetup(p, run);
  return { plan: plate, roles };
}

/** True when the readings are for exactly these wells: the example plate is redrawn when the plan changes. */
export function sameWells(readings: Record<string, number>, roles: WellRole[]) {
  const keys = Object.keys(readings);
  return keys.length === roles.length && roles.every(r => Number.isFinite(readings[r.well]));
}

/**
 * How the samples are read off the standards: the straight regression line (least squares through each standard's
 * blank-corrected mean, the blank at 0), the dashed line on the curve page with its equation and R² (2026-11-04: the
 * user reads concentrations from that equation). A line that does not rise falls back to point to point.
 */
export const READ_FIT: FitPlan = { preferred: [], avoid: [] };

/**
 * The analysis of the run's readings, the samples read off the straight line (READ_FIT); null when they do not make
 * a curve (too few standards read) or the protocol has no readout. Results, Share and Chapp's answers all use it.
 */
export function analyzeRun(p: Protocol, roles: WellRole[], readings: Record<string, number>): PlateAnalysis | null {
  try {
    analysisOf(p);
    const a = analyzePlate(roles, readings, READ_FIT);
    return a.standards.some(s => !s.blank) && Number.isFinite(a.range.max) ? a : null;
  } catch {
    return null;
  }
}

// ─── What Chapp says ─────────────────────────────────────────────────────────────────────────────────────────────

/** A sentence with bold parts, as the artboards set them: plain strings and `{ b }` for bold. */
export type Say = (string | { b: string })[];
export const sayText = (say: Say) => say.map(x => (typeof x === 'string' ? x : x.b)).join('');

/** R² as every screen writes it (Results-Swipe-Curve, Share-QR, Scan-Import): the lab parts' r2Text. */
export { r2Text };

/** "Sample 7", "Samples 7 and 9", "Samples 3, 7 and 9". */
export function sampleNames(refs: string[]) {
  if (refs.length === 1) return `Sample ${refs[0]}`;
  return `Samples ${refs.slice(0, -1).join(', ')} and ${refs[refs.length - 1]}`;
}

const inRange = (a: PlateAnalysis) => a.samples.filter(s => s.flag === 'ok');
const above = (a: PlateAnalysis) => a.samples.filter(s => s.flag === 'above');

/** Page 1: how many are in range, and what to do about the rest (Results-Swipe). */
export function concentrationSay(a: PlateAnalysis, unit = 'µg/mL'): Say {
  const ok = inRange(a).length;
  const total = a.samples.length;
  const say: Say =
    ok < total ? [{ b: `${ok} of ${total}` }, ` sample${total === 1 ? ' is' : 's are'} in range.`]
    : total === 1 ? ['The sample is in range.']
    : [{ b: `All ${total}` }, ' samples are in range.'];
  const high = above(a);
  if (high.length) {
    const one = high.length === 1;
    say.push(' ', { b: sampleNames(high.map(s => s.ref)) }, ` ${one ? 'is' : 'are'} above the top standard: dilute `);
    const dilutions = [...new Set(high.map(s => s.dilution ?? 10))];
    if (dilutions.length === 1) say.push(one ? 'it ' : 'them ', { b: `1:${dilutions[0]}` }, ` and run ${one ? 'it' : 'them'} again.`);
    else {
      high.forEach((s, i) => say.push(i ? (i === high.length - 1 ? ' and ' : ', ') : '', `Sample ${s.ref} `, { b: `1:${s.dilution ?? 10}` }));
      say.push(', and run them again.');
    }
  }
  const low = a.samples.filter(s => s.flag === 'below');
  if (low.length) {
    say.push(` ${sampleNames(low.map(s => s.ref))} ${low.length === 1 ? 'is' : 'are'} below the lowest standard, ${concentrationText(a.range.min)} ${unit}.`);
  }
  const missing = a.samples.filter(s => s.flag === 'missing');
  if (missing.length) say.push(` ${sampleNames(missing.map(s => s.ref))} ${missing.length === 1 ? 'has no reading' : 'have no readings'}.`);
  const wide = a.samples.filter(s => s.flag === 'ok' && s.cv !== null && s.cv > CV_LIMIT);
  if (wide.length) {
    say.push(
      wide.length === 1
        ? ` Sample ${wide[0]!.ref}’s replicates disagree (CV ${Math.round(wide[0]!.cv!)} %).`
        : ` ${sampleNames(wide.map(s => s.ref))} have replicates that disagree (CV over ${CV_LIMIT} %).`,
    );
  }
  return say;
}

/**
 * The curve page: how well the curve fits, and who sits above it (Results-Swipe-Curve). No R² here: the only R² on
 * the page is the straight regression line's, under the plot (2026-11-04).
 */
export function curveSay(a: PlateAnalysis, unit = 'µg/mL'): Say {
  const good = a.fit.r2 >= 0.99;
  const say: Say = [good ? 'The curve fits well.' : 'The curve fits loosely.'];
  const high = above(a);
  if (high.length) say.push(` ${sampleNames(high.map(s => s.ref))} ${high.length === 1 ? 'sits' : 'sit'} above the top standard, ${concentrationText(a.range.max)} ${unit}.`);
  if (!good) say.push(' Check the standards’ wells before trusting the numbers.');
  return say;
}

/** The two tabs, in PAGES' order: Curve · µg/mL (or the kit's own unit). */
export const tabLabels = (unit = 'µg/mL') => ['Curve', unit];

/** Page 1's rows (concentration and CV), with the design's CV limit. */
export const concentrationList = (a: PlateAnalysis) => concentrationRows(a, CV_LIMIT);

/** The samples above the top standard, with the dilution for their rerun: what "Rerun Sample 7" takes to Plan. */
export const reruns = (a: PlateAnalysis) => above(a).map(s => ({ ref: s.ref, dilution: s.dilution }));

/** "Rerun Sample 7", "Rerun 2 samples"; null when every sample was on the curve. */
export function rerunLabel(a: PlateAnalysis) {
  const high = above(a);
  return high.length === 0 ? null : high.length === 1 ? `Rerun Sample ${high[0]!.ref}` : `Rerun ${high.length} samples`;
}

// ─── What was said, understood on the phone ──────────────────────────────────────────────────────────────────────

export type Heard =
  /** "Show the curve". */
  | { kind: 'page'; page: PageId }
  /** "Here's a sample plate-reader export": Chapp's example readings. */
  | { kind: 'sample' }
  | { kind: 'share' };

function normalize(text: string) {
  return text
    .toLowerCase()
    .replace(/[μµ]/g, 'µ')
    .replace(/[’‘`]/g, "'")
    .replace(/[-–—]/g, ' ')
    .replace(/[?？!.。,，;:]+(\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const PAGE_WORDS: [RegExp, PageId][] = [
  [/^(?:the )?(?:standard )?curve$|^(?:the )?fit$/, 'curve'],
  [/^(?:the )?(?:concentrations?|protein concentrations?|µg per ml|µg\/ml|micrograms per ml)$/, 'conc'],
];

/**
 * What a sentence said on the results screen asks for, when it can be answered here without Chapp's model: a page,
 * the example plate, or sharing. Anything else (µL for 30 µg, all at 0.25 mg/mL, why the curve bends) returns null
 * and goes to the server (useConverse).
 */
export function parseHeard(text: string): Heard | null {
  const said = normalize(text);
  if (!said) return null;

  if (/\b(?:a|the|your|chapp's|some)\s+sample\s+(?:plate\s?reader\s+|reader\s+)?(?:export|plate|data|readings?|file)\b|^sample data$/.test(said)) {
    return { kind: 'sample' };
  }

  if (/^(?:ok |okay )?(?:share|share (?:it|this|them|the results|the setup)|send (?:it|this) to (?:a )?labmate)(?: please)?$/.test(said)) {
    return { kind: 'share' };
  }

  const asked = said.replace(/^(?:ok |okay )?(?:show(?: me)?|go to|open|back to|switch to|let me see|see)\s+/, '').replace(/ (?:page|please)$/, '');
  for (const [re, page] of PAGE_WORDS) if (re.test(asked)) return { kind: 'page', page };
  return null;
}
