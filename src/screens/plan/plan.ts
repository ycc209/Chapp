import { standardSeries, toMicroliters } from '../../../shared/calc.ts';
import { assayOf, type Protocol } from '../../../shared/protocol.ts';
import { concentrationText, halvings, runSetup, samplesThatFit, standardsFor } from '../../components/lab/model.ts';
import type { RunState } from '../../state/run.ts';
import { procedureFor, splitName } from '../protocol/content.ts';

/**
 * What the plan screens say, worked out from the protocol and the run's plan: pure functions, so the screen, the
 * spoken answer and the tests get the same numbers. Wording and rounding follow Plan.dc.html's own logic.
 */

export type Way = RunState['standards'];
export type PlanNumbers = Pick<RunState, 'samples' | 'replicates' | 'standardReplicates' | 'standards'>;

/** The top of the halving series: the kit's range (Plan's "Halve from 2,000"). */
export const halvingTop = (p: Protocol, procedureId: string) => assayOf(procedureFor(p, procedureId)).range.max;

/** How many vials each way makes, for reading "five standards" or "the kit's 9" against. */
export function wayCounts(p: Protocol, procedureId: string): Record<'kit' | 'halve' | 'five', number> {
  return {
    kit: standardSeries(p, procedureId, 1).vials.length,
    halve: halvings(p, procedureId, 'halve') + 1,
    five: halvings(p, procedureId, 'five') + 1,
  };
}

/** The most samples that fit on one plate beside these standards, as the design clamps the count. */
export function maxSamples(p: Protocol, procedureId: string, plan: Omit<PlanNumbers, 'samples'>) {
  return samplesThatFit(standardsFor(p, procedureId, plan.standards, plan.standardReplicates).vials, plan.standardReplicates, plan.replicates);
}

/** A changed plan, with the sample count brought down to what fits (Plan.dc.html's clampN). */
export function fitPlan(p: Protocol, procedureId: string, plan: PlanNumbers): PlanNumbers {
  const max = maxSamples(p, procedureId, plan);
  return { ...plan, samples: Math.max(1, Math.min(plan.samples, max)) };
}

/** Everything the plan shows: the standards, the plate, the working reagent and their labels. */
export function planFor(p: Protocol, procedureId: string, plan: PlanNumbers) {
  const proc = assayOf(procedureFor(p, procedureId));
  const curve = p.standardCurves.find(c => c.id === proc.standardCurve);
  const stockPart = p.components.find(c => c.id === curve?.stock);
  const diluentPart = p.components.find(c => c.id === curve?.diluent);
  const { samples: n, replicates: nr, standardReplicates: sr, standards: way } = plan;
  // The same layout Run loads, Results reads back and Share counts (runSetup).
  const { series, plate, reagent } = runSetup(p, { procedure: procedureId, ...plan });
  const S = series.vials.length;
  const kitCount = standardSeries(p, procedureId, 1).vials.length;
  const firstSample = plate.tubes[S]?.wells ?? [];
  const shortLabel = (c?: (typeof p.components)[number]) =>
    c?.label?.length ? c.label.reduce((a, b) => (b.length < a.length ? b : a)) : c ? splitName(c.name).name : '';
  return {
    plan,
    procedure: proc,
    series,
    plate,
    reagent,
    /** Vials in the rack ("5 vials", "Kit's 9"). */
    vials: S,
    kitCount,
    /** Most samples that fit beside these standards. */
    max: samplesThatFit(series.vials, sr, nr),
    /** "Kit's 9", "8 vials", "Already made". */
    wayName: way === 'kit' ? `Kit’s ${S}` : way === 'ready' ? 'Already made' : `${S} vials`,
    /** "the kit's 9" or "5 vials" (Up to 36 samples fit beside …). */
    beside: way === 'kit' || way === 'ready' ? `the kit’s ${kitCount}` : `${S} vials`,
    /** The kit's range: "20 to 2,000 µg/mL". */
    range: `${concentrationText(proc.range.min)} to ${concentrationText(proc.range.max)} ${proc.range.unit}`,
    /** "BSA": the stock's shortest label. */
    stockName: shortLabel(stockPart),
    stockPart,
    diluentPart,
    /** "Same buffer as your samples": the diluent's own note in its name, if it has one. */
    diluentNote: diluentPart ? upperFirst(splitName(diluentPart.name).aside ?? '') : '',
    perWell: toMicroliters(proc.sample),
    /** "B3 · B4": where sample 1 goes. */
    firstSample: firstSample.join(' · '),
  };
}

export type PlanView = ReturnType<typeof planFor>;

/** What a change can be seen in: a number wears the highlighter for as long as it is the last thing that changed. */
export function planKeys(v: PlanView, picked: boolean) {
  return {
    way: picked ? v.plan.standards : '',
    n: v.plan.samples,
    nr: v.plan.replicates,
    sr: v.plan.standardReplicates,
    S: v.vials,
    wells: v.plate.wells,
    wr: v.reagent.make,
    std: `${v.series.stock}/${v.series.diluent}`,
  };
}

export type PlanKey = keyof ReturnType<typeof planKeys>;

/** Which keys differ between two plans. */
export function changedKeys(before: ReturnType<typeof planKeys>, after: ReturnType<typeof planKeys>): PlanKey[] {
  return (Object.keys(after) as PlanKey[]).filter(k => after[k] !== before[k]);
}

const REPS: Record<number, string> = { 1: 'once', 2: 'in duplicate', 3: 'in triplicate', 4: 'in quadruplicate' };
/** 1 → "once", 2 → "in duplicate", 3 → "in triplicate". */
export const repWord = (k: number) => REPS[k] ?? `${k} times each`;
/** Both the same: "all in duplicate", or "each once". */
export const allRepWord = (k: number) => (k === 1 ? 'each once' : `all ${repWord(k)}`);

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The order of Chapp's sentence (Plan.dc.html): samples and standards "all in duplicate" when their replicates match;
 * otherwise samples first, or standards first right after the user named them (Plan-Heard).
 */
export function sentenceOrder(plan: PlanNumbers, heard: boolean): 'same' | 'differ' | 'standardsFirst' {
  if (plan.replicates === plan.standardReplicates) return 'same';
  return heard ? 'standardsFirst' : 'differ';
}

/** The summary as Chapp says it aloud, the same words as on screen. */
export function planLine(v: PlanView, opts: { picked: boolean; heard: boolean; still: boolean }): string {
  const { samples: n, replicates: nr, standardReplicates: sr } = v.plan;
  const ns = plural(n, 'sample');
  if (!opts.picked) return `${ns}, ${repWord(nr)}. The kit reads ${v.range}. How do you want to make the standards?`;
  const ss = plural(v.vials, 'standard');
  const order = sentenceOrder(v.plan, opts.heard);
  const lead =
    order === 'same' ? `${ns} and ${ss}, ${allRepWord(nr)}`
    : order === 'differ' ? `${ns} ${repWord(nr)} and ${ss} ${repWord(sr)}`
    : `${ss} ${repWord(sr)} and ${ns} ${repWord(nr)}`;
  return `${upperFirst(lead)}: ${plural(v.plate.wells, 'well')}, ${opts.still ? 'still ' : ''}${mlText(v.reagent.make)} of ${v.reagent.name.toLowerCase()}.`;
}

/** 10000 µL → "10 mL"; 8400 → "8.4 mL" (one decimal, as Plan says "It needs 8.4 mL"). */
export const mlText = (microliters: number) => `${+(microliters / 1000).toFixed(1)} mL`;

/** Where Start goes: the first step, or the working reagent when the standards are already made (Plan.dc.html). */
export const startStep = (way: Way) => (way === 'ready' ? 1 : 0);

/** What the user said, as the "You said" line shows it: capitalized, ending in a stop. */
export function tidySaid(text: string): string {
  const t = upperFirst(text.trim());
  return /[.!?…]$/.test(t) ? t : `${t}.`;
}

function upperFirst(s: string) {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}
