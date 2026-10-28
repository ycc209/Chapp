import type { Box } from '../../../shared/ai.ts';
import { formatVolume } from '../../../shared/calc.ts';
import type { Protocol } from '../../../shared/protocol.ts';
import { runSetup, type StandardsWay } from '../../components/lab/model.ts';
import { bottles, procedureFor, splitName } from '../protocol/content.ts';

/**
 * Matching photos to the kit's bottles. SAM 3.1 finds the bottles and Muse Spark reads their labels (found.ts,
 * analysis.ts): a label read is a match, the rest are things Chapp asks about (Recognized.dc.html: "Is the small vial
 * the Albumin Standard?", "What's the tall bottle?"). Whatever is left, or everything when the models are away, the
 * user shows by hand: Chapp asks where each bottle is, the user taps it on a photo, Chapp asks to confirm the square it
 * cut (Kit.dc.html). Pure, so it is tested.
 */

/**
 * How a bottle got matched: its label was read; the user confirmed Chapp's guess; the user named it ("you picked it");
 * or, unset, the user showed it by tapping a photo.
 */
export type How = 'read' | 'confirmed' | 'picked';

/** A bottle's picture: which photo, where on it (fractions; every bottle of it when several), and the square cut out. */
export type Pick = { shot: string; box: Box; crop: string; how?: How; boxes?: Box[] };

/** Something the models found whose label was not read: a guess to confirm, or a bottle to name ("none"). */
export type Thing = Pick & { id: string; looks: string; text: string; component: string | null; match: 'guess' | 'none' };

/** A bottle the run needs, as the kit screens name it. */
export type Need = { id: string; name: string; kit: boolean; role: string };

export function needsOf(p: Protocol): Need[] {
  return bottles(p).map(c => ({ id: c.id, name: splitName(c.name).name, kit: c.suppliedBy === 'kit', role: c.role }));
}

type Progress = { picks: Record<string, Pick | undefined>; skipped: Record<string, boolean | undefined> };

/** Bottles neither matched nor skipped, in the order Chapp asks about them. */
export function open(needs: Need[], { picks, skipped }: Progress): Need[] {
  return needs.filter(n => !picks[n.id] && !skipped[n.id]);
}

/** The bottle Chapp is asking about: the one the user picked, while it is still open, else the first open one. */
export function asked(needs: Need[], progress: Progress, asking: string | null): Need | null {
  const left = open(needs, progress);
  return left.find(n => n.id === asking) ?? left[0] ?? null;
}

/** Chapp's line before anything is matched: "I have 3 photos. Show me the 4 bottles." */
export function opening(shots: number, needs: number): string {
  return `I have ${shots} photo${shots === 1 ? '' : 's'}. Show me the ${needs} bottle${needs === 1 ? '' : 's'}.`;
}

/** "BCA Reagent A, got it. 3 more to check." (Kit.dc.html: "Diluent, got it. 1 more to check.") */
export function gotIt(name: string, left: number): string {
  return `${name}, got it.${left ? ` ${left} more to check.` : ''}`;
}

export function noPhoto(name: string, left: number): string {
  return `Okay, no photo of the ${name}.${left ? ` ${left} more to check.` : ''}`;
}

/**
 * The line under a row's name: where the picture came from, or what is still missing. The designs' words: "Kit · photo
 * 1" (read), "Kit · photo 2 · you confirmed", "Photo 3 · you picked it", "Photo 2 · maybe the Albumin Standard",
 * "Photo 3 · I can’t tell".
 */
export function rowDetail(need: Need, state: { pick?: Pick; pending?: Pick; skipped?: boolean; thing?: Thing }, shotNumber: (id: string) => number): string {
  const who = need.kit ? 'Kit' : 'Yours';
  if (state.pending) return `Photo ${shotNumber(state.pending.shot)} · is this it?`;
  if (state.pick) {
    const n = shotNumber(state.pick.shot);
    if (state.pick.how === 'picked') return n > 0 ? `Photo ${n} · you picked it` : 'You picked it';
    const where = n > 0 ? `${who} · photo ${n}` : `${who} · your photo`;
    return state.pick.how === 'confirmed' ? `${where} · you confirmed` : where;
  }
  if (state.thing) return `Photo ${shotNumber(state.thing.shot)} · ${state.thing.match === 'guess' ? `maybe the ${need.name}` : 'I can’t tell'}`;
  if (state.skipped) return `${who} · no photo`;
  return `${who} · not matched yet`;
}

/** "glass ampule" → "Glass ampule": a thing's row says what it looks like until it is named. */
export const thingTitle = (thing: { looks: string }) => thing.looks.charAt(0).toUpperCase() + thing.looks.slice(1);

/** While the models look: "Looking at your 3 photos…" */
export function looking(shots: number): string {
  return `Looking at your ${shots === 1 ? 'photo' : `${shots} photos`}…`;
}

/** Recognized.dc.html: "I found 4 things in 3 photos. I’m not sure about 2." */
export function recognized(things: number, shots: number, unsure: number): string {
  return `I found ${things} thing${things === 1 ? '' : 's'} in ${shots} photo${shots === 1 ? '' : 's'}.${unsure ? ` I’m not sure about ${unsure}.` : ''}`;
}

/** The models could not look (offline, or they failed): over to the user's taps. */
export function cantLook(needs: number): string {
  return `I can’t look at the photos right now. Show me the ${needs} bottle${needs === 1 ? '' : 's'}.`;
}

/** The models looked and found none of the run's bottles. */
export function noneFound(shots: number, needs: number): string {
  return `I couldn’t find the bottles in ${shots === 1 ? 'this photo' : 'these photos'}. Show me the ${needs} bottle${needs === 1 ? '' : 's'}.`;
}

/**
 * How much of each bottle this run takes (Kit-Filled.dc.html: 9.8 mL, 196 µL, 400 µL, 960 µL; the artboard rounds B to 200 µL): the mix's parts for
 * the working reagent to make and the stock and diluent for the standards, the same amounts Plan and Run show
 * (runSetup). Standards already made take nothing.
 */
export function amounts(
  p: Protocol,
  procedureId: string | null | undefined,
  samples: number,
  replicates: number,
  standardReplicates = replicates,
  standards: StandardsWay = 'kit',
): Record<string, string> {
  const proc = procedureFor(p, procedureId);
  const out: Record<string, number> = {};
  const add = (id: string, v: number) => v > 0 && (out[id] = (out[id] ?? 0) + v);
  try {
    const { reagent, series } = runSetup(p, { procedure: proc.id, samples, replicates, standardReplicates, standards });
    for (const part of reagent.parts) add(part.component, part.volume);
    const curve = p.standardCurves.find(c => c.id === proc.standardCurve);
    if (curve) {
      add(curve.stock, series.stock);
      add(curve.diluent, series.diluent);
    }
  } catch {
    return {};
  }
  return Object.fromEntries(Object.entries(out).map(([id, v]) => [id, formatVolume(v)]));
}

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9µ㐀-鿿 ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

/**
 * What a spoken or typed answer to Chapp's question means, when it is one of the answers on screen ("yes", "the
 * diluent", "reagent B", "not for this run"): the answer it picks, or null to pass the words on to Chapp.
 */
export function heardAnswer(text: string, answers: string[]): string | null {
  const said = words(text).join(' ');
  if (!said) return null;
  const exact = answers.find(a => words(a).join(' ') === said);
  if (exact) return exact;
  if (/^(yes|yeah|yep|correct|right|that s it|是|對|沒錯)/.test(said) && answers.includes('Yes')) return 'Yes';
  // "it's the albumin standard", "reagent b": all of an answer's words in order, or its last two for a long name.
  const phrases = (a: string) => {
    const w = words(a);
    return w.length >= 3 ? [w.join(' '), w.slice(-2).join(' ')] : [w.join(' ')];
  };
  const hits = answers.filter(a => phrases(a).some(p => ` ${said} `.includes(` ${p} `)));
  return hits.length === 1 ? hits[0] : null;
}

/** What Chapp asks about now. */
export type Subject =
  /** A square the user tapped: "Is this the BCA Reagent A?" */
  | { kind: 'pending'; need: Need }
  /** A guess: "Is the small vial the Albumin Standard?" */
  | { kind: 'guess'; thing: Thing; need: Need }
  /** A bottle nobody could tell: "What’s the tall bottle?" */
  | { kind: 'unknown'; thing: Thing }
  /** A bottle still to show by hand: "Where’s the Diluent?" */
  | { kind: 'where'; need: Need };

type Session = Progress & { pending: (Pick & { component: string }) | null; things: Thing[]; asking: string | null };

/**
 * The question on screen: the square the user just tapped; else what the models found but could not be sure of, the
 * bottles nobody could tell first (Recognized.dc.html asks about the tall bottle, then Kit.dc.html about the small
 * vial), or the one the user chose; else, once the models are done, where the next open bottle is.
 */
export function subjectOf(needs: Need[], s: Session, looking: boolean): Subject | null {
  const tapped = s.pending && needs.find(n => n.id === s.pending!.component);
  if (tapped) return { kind: 'pending', need: tapped };
  const chosen = s.things.find(t => t.id === s.asking);
  for (const thing of chosen ? [chosen] : [...s.things.filter(t => t.match === 'none'), ...s.things.filter(t => t.match === 'guess')]) {
    if (thing.match === 'none') return { kind: 'unknown', thing };
    const need = needs.find(n => n.id === thing.component);
    if (need) return { kind: 'guess', thing, need };
  }
  if (looking) return null;
  const need = asked(needs, s, s.asking);
  return need ? { kind: 'where', need } : null;
}

/**
 * Which row each bottle nobody could tell shows in: the rows of bottles still open (not matched, skipped, tapped or
 * guessed), in order, as Recognized.dc.html puts "Tall bottle · I can’t tell" where the Diluent's row is.
 */
export function slotsOf(needs: Need[], s: Session): Map<string, Thing> {
  const free = needs.filter(n => !s.picks[n.id] && !s.skipped[n.id] && s.pending?.component !== n.id && !s.things.some(t => t.match === 'guess' && t.component === n.id));
  const unknown = s.things.filter(t => t.match === 'none');
  return new Map(free.slice(0, unknown.length).map((n, i) => [n.id, unknown[i]]));
}

/** The bottles to offer for a thing nobody could tell: those still open, the ones nobody guessed first (Recognized.dc.html: Diluent, Albumin Standard). */
export function offered(needs: Need[], s: Session): Need[] {
  const left = open(needs, s);
  const guessed = (n: Need) => s.things.some(t => t.match === 'guess' && t.component === n.id);
  return [...left.filter(n => !guessed(n)), ...left.filter(guessed)];
}
