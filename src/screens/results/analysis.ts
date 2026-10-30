import { analyzePlate, type PlateAnalysis, type SampleResult, type WellRole } from '../../../shared/fit.ts';
import { analysisOf, type Protocol } from '../../../shared/protocol.ts';
import {
  commonRows,
  concentrationRows,
  concentrationText,
  massRows,
  r2Text,
  runSetup,
  standardsFor,
  threeFigures,
  type PlatePlan,
  type ResultRow,
  type StandardVial,
} from '../../components/lab/model.ts';
import type { RunState } from '../../state/run.ts';
import { count } from '../../voice/commands.ts';

/**
 * The results screen's numbers and words, worked out from the run's plan and readings: which well holds what
 * (plateMap, the same layout the run loaded), the analysis (shared/fit.ts), and Chapp's sentence above each page.
 * Pure, so the tests check exactly what the screen shows. Nothing here is typed in: every number comes from the
 * readings.
 */

/** The four pages, in the order the tabs and the swipe show them; `?page=` takes these names. */
export const PAGES = ['conc', 'volume', 'same', 'curve'] as const;
export type PageId = (typeof PAGES)[number];

/** The design's starting amount: µL that hold 20 µg (Results-Swipe-Volume). */
export const DEFAULT_AMOUNT = 20;
/** What each sample is brought up to on the "all at one concentration" page, µL. */
export const FINAL_VOLUME = 100;
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

/** The analysis of the run's readings; null when they do not make a curve (too few standards read). */
export function analyzeRun(p: Protocol, roles: WellRole[], readings: Record<string, number>): PlateAnalysis | null {
  try {
    const a = analyzePlate(roles, readings, analysisOf(p).fit);
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

/** µg as said and shown: 20, 2.5. */
export const amountText = (micrograms: number) => String(+micrograms.toFixed(2));

/** µg/mL as mg/mL: 400 → "0.4", 250 → "0.25". */
export const mgText = (microgramsPerMl: number) => String(+(microgramsPerMl / 1000).toFixed(3));

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
/** Small counts in words, as the design writes "all eleven". */
export const countWord = (n: number) => WORDS[n] ?? String(n);

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

/** Page 2: µL for `amount` µg, and the lane that holds the largest load (Results-Swipe-Volume). */
export function volumeSay(a: PlateAnalysis, amount: number): Say {
  const m = massRows(a, amount);
  if (!m.most) return ['No sample is in range, so there is nothing to load yet.'];
  return [
    'For ',
    { b: `${amountText(amount)} µg` },
    ', ',
    { b: `Sample ${m.most.ref}` },
    ' needs the most: ',
    { b: `${m.most.volume.toFixed(1)} µL` },
    `. Plan lanes of at least ${m.lane} µL.`,
  ];
}

/** Page 3's rows and its ceiling: every in-range sample at one concentration, `final` µL of each. */
export type Common = { ceiling: number; target: number; lowest: string; low: number; count: number; rows: ResultRow[] };

/**
 * The common concentration: commonConcentration()'s ceiling (the lowest sample, rounded down to 0.1 mg/mL), or a
 * lower one the user asked for. Null when no sample is in range.
 */
export function common(a: PlateAnalysis, asked: number | null = null, final = FINAL_VOLUME): Common | null {
  const c = commonRows(a, final);
  if (!c) return null;
  const low = a.samples.find(s => s.ref === c.lowest)!.concentration!;
  const base = { ceiling: c.target, lowest: c.lowest, low, count: inRange(a).length };
  if (asked === null || asked >= c.target) return { ...base, target: c.target, rows: c.rows };
  const rows: ResultRow[] = a.samples.map((s: SampleResult) => {
    if (s.flag !== 'ok' || !s.concentration) return { n: s.ref, name: `Sample ${s.ref}`, value: 'rerun', note: true, side: '' };
    const take = (asked / s.concentration) * final;
    return { n: s.ref, name: `Sample ${s.ref}`, value: take.toFixed(1), side: (final - take).toFixed(1), mark: s.ref === c.lowest };
  });
  return { ...base, target: asked, rows };
}

/** Page 3's sentence (Results-Swipe-Same), or how it reads after a lower concentration was asked for. */
export function commonSay(c: Common | null, final = FINAL_VOLUME): Say {
  if (!c) return ['No sample is in range, so there is nothing to bring to one concentration yet.'];
  const tail = ` For ${final} µL of each: take, then buffer.`;
  if (c.target < c.ceiling) return [`All ${countWord(c.count)} at `, { b: `${mgText(c.target)} mg/mL` }, '.', tail];
  return [{ b: `${mgText(c.target)} mg/mL` }, ` is the highest all ${countWord(c.count)} can reach; Sample ${c.lowest} is only ${threeFigures(c.low)} µg/mL.`, tail];
}

/** Asked for more than the lowest sample allows: why not, and the highest there is. */
export function tooHighSay(c: Common, asked: number): Say {
  return [
    `${mgText(asked)} mg/mL is too high: Sample ${c.lowest} is only ${threeFigures(c.low)} µg/mL. `,
    { b: `${mgText(c.ceiling)} mg/mL` },
    ` is the highest all ${countWord(c.count)} can reach.`,
  ];
}

/** Page 4: how well the curve fits, and who sits above it (Results-Swipe-Curve). */
export function curveSay(a: PlateAnalysis, unit = 'µg/mL'): Say {
  const good = a.fit.r2 >= 0.99;
  const say: Say = [good ? 'The curve fits well: ' : 'The curve fits loosely: ', { b: `R² ${r2Text(a.fit.r2)}` }, '.'];
  const high = above(a);
  if (high.length) say.push(` ${sampleNames(high.map(s => s.ref))} ${high.length === 1 ? 'sits' : 'sit'} above the top standard, ${concentrationText(a.range.max)} ${unit}.`);
  if (!good) say.push(' Check the standards’ wells before trusting the numbers.');
  return say;
}

/** The four tabs: µg/mL · 20 µg · 0.4 mg/mL · Curve. */
export function tabLabels(amount: number, c: Common | null, unit = 'µg/mL') {
  return [unit, `${amountText(amount)} µg`, c ? `${mgText(c.target)} mg/mL` : 'Same', 'Curve'];
}

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
  /** "How much for 30 µg?": the µL page for another amount. */
  | { kind: 'amount'; micrograms: number }
  /** "All at 0.25 mg/mL": the one-concentration page at that concentration. */
  | { kind: 'common'; microgramsPerMl: number }
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

const NUMBER = String.raw`(\d+(?:\.\d+)?|\.\d+|[a-z]+(?:\s[a-z]+)?)`;
const MICRO = String.raw`(?:µg|ug|mcg|micrograms?|micro\s?grams?)`;
const MILLI = String.raw`(?:mg|milligrams?|milli\s?grams?)`;
const PER_ML = String.raw`\s*(?:\/|per|a)\s*(?:ml|mls|milliliters?|millilitres?|mil)\b`;

/** "30", "2.5", "thirty", "twenty five" → a number. Words go through the bench commands' own counting. */
function amountOf(words: string): number | null {
  if (/^\d*\.?\d+$/.test(words)) return Number(words);
  // A number in words is at most two of them; the regex may have taken a word before it ("for thirty").
  const parts = words.split(' ');
  return count(words) ?? (parts.length === 2 ? count(parts[1]!) : null);
}

const PAGE_WORDS: [RegExp, PageId][] = [
  [/^(?:the )?(?:standard )?curve$|^(?:the )?fit$/, 'curve'],
  [/^(?:the )?(?:concentrations?|µg per ml|µg\/ml|micrograms per ml)$/, 'conc'],
  [/^(?:the )?(?:volumes?|µl|microliters?|microlitres?|loading volumes?)$/, 'volume'],
  [/^(?:the )?(?:same concentration|one concentration|common concentration|dilutions?)$/, 'same'],
];

/**
 * What a sentence said on the results screen asks for, when it can be answered here without Chapp's model: another
 * amount, another common concentration, a page, the example plate, or sharing. Anything else returns null and goes
 * to the server (useConverse).
 */
export function parseHeard(text: string): Heard | null {
  const said = normalize(text);
  if (!said) return null;

  // A concentration first, so "0.4 mg/mL" is never read as an amount.
  const conc = said.match(new RegExp(`${NUMBER}\\s*(${MICRO}|${MILLI})${PER_ML}`));
  if (conc) {
    const n = amountOf(conc[1]!);
    if (n !== null && n > 0) {
      const perMl = new RegExp(`^${MILLI}$`).test(conc[2]!) ? n * 1000 : n;
      if (perMl <= 100000) return { kind: 'common', microgramsPerMl: perMl };
    }
  }

  const mass = said.match(new RegExp(`${NUMBER}\\s*${MICRO}(?!\\s*(?:\\/|per|a)\\s*(?:ml|mls|milliliters?|millilitres?|mil)\\b)`));
  if (mass) {
    const n = amountOf(mass[1]!);
    if (n !== null && n > 0 && n <= 10000) return { kind: 'amount', micrograms: n };
  }

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
