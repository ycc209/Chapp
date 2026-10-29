import { analyzePlate, type WellRole } from '../../../shared/fit.ts';
import { analysisOf, type Protocol } from '../../../shared/protocol.ts';
import { SHARE_FORMAT, type SharedComponent, type SharedPlan, type SharedSetup, type ShareScope, type StoredShare } from '../../../shared/share.ts';
import { NO_EDITS, runSetup, type RunPlan } from '../../components/lab/model.ts';
import type { RunState } from '../../state/run.ts';

/**
 * Between the phone's run and a shared setup (shared/share.ts): what Share-QR sends for each trim, what Scan-Import
 * lists, and what importing writes into the labmate's run. Pure, so tests check them without a browser.
 */

export type RunSnapshot = Pick<
  RunState,
  'protocolId' | 'procedure' | 'samples' | 'replicates' | 'standardReplicates' | 'standards' | 'photos' | 'readings'
> & { edits?: RunState['edits'] };

/** "Pierce BCA Protein Assay" → "Pierce BCA": the name Chapp says (header subtitle, "a Pierce BCA run"). */
export const shortName = (p: Protocol) => p.title.replace(/\s+(?:Protein\s+)?Assay(?:\s+Kit)?$/i, '') || p.title;

/** The kit's main catalog number, the one to search the shared library by ("23225"). */
export const catalog = (p: Protocol) => p.kit.variants[0]?.catalog ?? '';

/**
 * The kit's bottles as the share lists them: the name on the label and a line beside it (Scan-Import's Kit row).
 * "Albumin Standard (BSA)" with labels [Albumin Standard, BSA] at 2 mg/mL → Albumin Standard · "BSA · 2 mg/mL";
 * "BCA Reagent A" with labels [BCA Reagent A, Reagent A] → BCA Reagent A alone;
 * "Diluent (same buffer as your samples)" → Diluent · "Same buffer as your samples".
 */
export function kitRows(p: Protocol): SharedComponent[] {
  return p.components.map(c => {
    const [, named, aside] = /^(.*?)\s*(?:\((.*)\))?$/.exec(c.name) ?? [];
    const label = c.label?.[0] ?? named ?? c.name;
    const concentration = c.concentration ? `${c.concentration.value} ${c.concentration.unit}` : '';
    // A second label that only repeats the first ("Reagent A" of "BCA Reagent A") adds nothing beside it.
    const also = c.label?.[1] && !label.toLowerCase().includes(c.label[1].toLowerCase()) ? c.label[1] : '';
    const detail = c.label
      ? [also, concentration].filter(Boolean).join(' · ')
      : [aside && aside[0]!.toUpperCase() + aside.slice(1), concentration].filter(Boolean).join(' · ');
    return detail ? { id: c.id, label, detail } : { id: c.id, label };
  });
}

export const hasResults = (run: Pick<RunState, 'readings'>) => Object.keys(run.readings).length > 0;

/** A kit photo the share can carry: a JPEG, PNG or WebP data URL (the kit screen's crops are small JPEGs). */
const PHOTO = /^data:image\/(?:jpeg|png|webp);base64,/;

/**
 * The setup to share for one trim. The plan travels unless it is just the protocol; the results only with everything,
 * and only when there are readings. The kit photos travel with any trim unless the user leaves them out (10/28: on by
 * default). `from` names the sharer ("CJ Yu shared…").
 */
export function buildShare(
  scope: ShareScope,
  run: RunSnapshot,
  protocol: Protocol,
  results: { r2?: number; sampleData?: boolean } = {},
  options: { photos?: boolean; from?: string } = {},
): SharedSetup {
  const photos = options.photos ?? true;
  const setup: SharedSetup = {
    format: SHARE_FORMAT,
    scope,
    protocolId: protocol.id,
    procedure: run.procedure,
    kit: kitRows(protocol).map(c => {
      const photo = run.photos[c.id];
      return photos && photo && PHOTO.test(photo) ? { ...c, photo } : c;
    }),
  };
  if (options.from) setup.from = options.from;
  if (scope !== 'protocol') {
    setup.plan = { samples: run.samples, replicates: run.replicates, standardReplicates: run.standardReplicates, standards: run.standards };
    if (run.edits && (Object.keys(run.edits.moved).length || run.edits.added.length)) setup.plan.edits = run.edits;
  }
  if (scope === 'all' && hasResults(run)) {
    setup.results = { readings: { ...run.readings } };
    if (results.sampleData !== undefined) setup.results.sampleData = results.sampleData;
    if (results.r2 !== undefined) setup.results.r2 = results.r2;
  }
  return setup;
}

/**
 * The run's plan as a share carries it. A share from before the plan carried its standards ran the kit's table, the
 * standards in the samples' replicates.
 */
export function sharedRunPlan(procedure: string, plan: SharedPlan): RunPlan {
  return {
    procedure,
    samples: plan.samples,
    replicates: plan.replicates,
    standardReplicates: plan.standardReplicates ?? plan.replicates,
    standards: plan.standards ?? 'kit',
    ...(plan.edits ? { edits: plan.edits } : {}),
  };
}

/**
 * The plate the shared plan lays out: runSetup, the same layout Plan drew, Run loaded and Results read back, so the
 * readings land in the wells they were read from. Null when the plan does not make a plate.
 */
export function sharePlate(protocol: Protocol, plan: RunPlan) {
  try {
    return runSetup(protocol, plan);
  } catch {
    return null;
  }
}

/**
 * The standard curve's R² for the run's readings, fitted as the protocol asks (shared/fit.ts, the same analysis the
 * results screens show); undefined when the readings do not make a curve.
 */
export function standardR2(
  protocol: Protocol,
  run: Pick<RunSnapshot, 'procedure' | 'samples' | 'replicates' | 'standardReplicates' | 'standards' | 'readings'>,
): number | undefined {
  if (!hasResults(run)) return undefined;
  const plate = sharePlate(protocol, run);
  if (!plate) return undefined;
  try {
    const r2 = analyzePlate(plate.roles, run.readings, analysisOf(protocol).fit).fit.r2;
    return Number.isFinite(r2) ? Math.min(1, Math.max(0, r2)) : undefined;
  } catch {
    return undefined;
  }
}

/** What a share brings, line by line: Share-QR's "What travels" and Scan-Import's "You get". */
export type Travels = {
  steps: number;
  plan?: { standards: number; standardReplicates: number; samples: number; replicates: number; reagentMl: number };
  results?: { samples: number; r2?: number };
  /** How many bottles' photos come along. */
  photos?: number;
};

type Shareable = Pick<SharedSetup, 'procedure' | 'plan' | 'results'> & { kit?: SharedComponent[] };

export function travels(share: Shareable, protocol: Protocol): Travels {
  const procedure = protocol.procedures.find(p => p.id === share.procedure) ?? protocol.procedures[0]!;
  const curve = protocol.standardCurves.find(c => c.id === procedure.standardCurve);
  const out: Travels = { steps: procedure.steps.length };
  const run = share.plan ? sharedRunPlan(procedure.id, share.plan) : null;
  const plate = run ? sharePlate(protocol, run) : null;
  if (run) {
    out.plan = {
      standards: plate?.series.vials.length ?? curve?.points.length ?? 0,
      standardReplicates: run.standardReplicates,
      samples: run.samples,
      replicates: run.replicates,
      // The working reagent Plan says to make (reagentPlan: the need plus 10 %, up to a round number of mL).
      reagentMl: plate ? plate.reagent.make / 1000 : 0,
    };
  }
  if (share.results) {
    out.results = { samples: run ? measuredSamples(plate?.roles ?? null, run.samples, share.results.readings) : 0 };
    if (share.results.r2 !== undefined) out.results.r2 = share.results.r2;
  }
  const photos = share.kit?.filter(c => c.photo).length ?? 0;
  if (photos > 0) out.photos = photos;
  return out;
}

/** How many of the plan's samples have at least one reading, by the plate layout the run used. */
function measuredSamples(roles: WellRole[] | null, samples: number, readings: Record<string, number>) {
  if (!roles) return samples;
  return new Set(roles.filter(w => w.kind === 'sample' && readings[w.well] !== undefined).map(w => w.ref)).size;
}

/** "in duplicate", as the Plan artboards say it (repWord), for the sentence about a plan. */
export function replicatesWords(n: number) {
  return ({ 1: 'once each', 2: 'in duplicate', 3: 'in triplicate', 4: 'in quadruplicate' } as Record<number, string>)[n] ?? `${n} times each`;
}

/** "today", "yesterday" or "Oct 27": when the results were shared, said the way the import screen says it. */
export function whenSaid(iso: string, now = new Date()) {
  const then = new Date(iso);
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(then)) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return then.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * What importing writes into the labmate's run: the protocol, procedure and plan, the results when they came along,
 * and a fresh start (step 0, nothing ticked, no timers). A trimmed share keeps the labmate's own plan. Their own kit
 * photos stay when the protocol is the same; photos that came with the share fill the bottles they have none of.
 */
export function importPatch(share: StoredShare, current: RunSnapshot): Partial<RunState> {
  const sameKit = current.protocolId === share.protocolId;
  const photos: Record<string, string> = sameKit ? { ...current.photos } : {};
  for (const c of share.kit) if (c.photo && !photos[c.id]) photos[c.id] = c.photo;
  const plan = share.plan ? sharedRunPlan(share.procedure, share.plan) : current;
  return {
    protocolId: share.protocolId,
    procedure: share.procedure,
    samples: plan.samples,
    replicates: plan.replicates,
    standardReplicates: plan.standardReplicates,
    standards: plan.standards,
    edits: plan.edits ?? NO_EDITS,
    step: 0,
    done: {},
    timers: {},
    photos,
    readings: share.results ? { ...share.results.readings } : {},
    // Chapp's example readings stay labeled "Sample data" on the labmate's phone too.
    readingsFrom: share.results ? (share.results.sampleData ? 'sample' : 'plate') : null,
  };
}

/**
 * Whether to send the kit photos, when that is what was said on Share-QR: "without the photos" → false, "send the
 * photos too" → true; null for anything else.
 */
export function parsePhotos(text: string): boolean | null {
  const said = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!/\b(?:photos?|pictures?|pics?|images?)\b/.test(said)) return null;
  if (/\b(?:no|without|leave out|drop|skip|not|don t send|keep)\b/.test(said)) return false;
  if (/\b(?:with|include|add|send|share)\b/.test(said)) return true;
  return null;
}

/**
 * The trim asked for by voice or typing on Share-QR, or null when it is not one: "without the results" →
 * noresults, "just the protocol" → protocol, "send everything" → all. Anything else goes to Chapp.
 */
export function parseTrim(text: string): ShareScope | null {
  const said = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!said) return null;
  if (/\b(?:just|only)\s+(?:send\s+)?(?:the\s+)?protocol\b|\bprotocol\s+only\b|\b(?:no|without|leave out|drop|skip)\s+(?:the\s+)?plan\b/.test(said)) return 'protocol';
  if (/\b(?:no|without|leave out|drop|skip|not)\s+(?:the\s+)?(?:results?|data|readings?)\b|\b(?:results?|data)\s+(?:stay|stays)\b/.test(said)) return 'noresults';
  if (/\b(?:everything|all of it|the whole thing|whole setup|send it all|send all)\b|\b(?:with|include|add)\s+(?:the\s+)?results?\b/.test(said)) return 'all';
  return null;
}
