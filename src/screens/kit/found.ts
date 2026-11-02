import type { Box, LabelMatch, LabelTarget, ProtocolIntro, ReadLabels } from '../../../shared/ai.ts';
import { area } from '../../../shared/kit.ts';
import type { Protocol } from '../../../shared/protocol.ts';
import { bottles } from '../protocol/content.ts';
import { contentsId, needsOf, type Need, type Pick as KitPick, type Thing } from './matching.ts';

/**
 * What the models found on the photos, turned into what the kit screen shows (Recognized.dc.html): bottles whose
 * label was read become matched rows; the rest become things Chapp asks about ("Is the small vial the Albumin
 * Standard?", "What's the tall bottle?"). Pure, so it is tested; the cropping lives in analysis.ts.
 */

/** The run's bottles as /api/kit/labels takes them: the kit's own, then the user's. */
export function labelTargets(p: Protocol): LabelTarget[] {
  return bottles(p).map(c => {
    // The volumes the kit's sizes have it in: a label prints its bottle's ("25 mL" is Reagent B, not A's 500 mL).
    const volumes = [...new Set(p.kit.variants.flatMap(v => v.contents.filter(x => x.component === c.id && x.amount).map(x => `${x.amount!.value} ${x.amount!.unit}`)))];
    return { id: c.id, name: c.name, role: c.role, kit: c.suppliedBy === 'kit', labels: c.label ?? [], ...(volumes.length ? { volumes } : {}) };
  });
}

/** What the bottles' labels are read against: the bottles as the kit screens name them, and as /api/kit/labels takes them. */
export type ReadTarget = { needs: Need[]; components: LabelTarget[] };

export const targetOf = (p: Protocol): ReadTarget => ({ needs: needsOf(p), components: labelTargets(p) });

/**
 * What a kit new to Chapp holds, as its manual's first read lists it (ProtocolIntro.contents: "Insulin", "1 mL"), as
 * /api/kit/labels takes it: the labels are read against these as soon as the manual says them, long before its steps
 * are written, and what they matched moves to the protocol's own bottles once it is read (sameBottles). An amount is
 * the volume the bottle comes in only when it is one ("10 × 1 mL" is not).
 */
export function contentsTargets(contents: ProtocolIntro['contents']): LabelTarget[] {
  return contents
    .map(c => ({ name: c.name.trim(), amount: c.amount.trim() }))
    .filter(c => c.name)
    .map((c, i) => ({ id: contentsId(i), name: c.name, role: 'kit component', kit: true, labels: [c.name], ...(/^\d+(\.\d+)?\s*(µl|ul|ml|l)$/i.test(c.amount) ? { volumes: [c.amount] } : {}) }));
}

/** The kit's contents as the kit screens name them. */
export const contentsTarget = (contents: LabelTarget[]): ReadTarget => ({ needs: contents.map(c => ({ id: c.id, name: c.name, kit: true, role: c.role })), components: contents });

const nameWords = (s: string) => new Set(s.normalize('NFKC').toLowerCase().replace(/[^a-z0-9µ]+/g, ' ').split(' ').filter(Boolean));

/** How alike two names are: 2 for the same words, else the share of the shorter name's words the other has. */
function alike(a: string, b: string): number {
  const x = nameWords(a);
  const y = nameWords(b);
  if (!x.size || !y.size) return 0;
  const shared = [...x].filter(w => y.has(w)).length;
  return shared === x.size && shared === y.size ? 2 : shared / Math.min(x.size, y.size);
}

/**
 * Which of the protocol's bottles each of the kit's contents is, by their words: the manual's first read and its
 * protocol name them alike ("1000X Differentiation Cocktail", "Differentiation Cocktail (1000X)"). The most alike pairs
 * first, each bottle once, more than half the shorter name's words shared ("Buffer A" is not "Buffer B"); null for
 * one the protocol has no bottle like. Pure, so it is tested.
 */
export function sameBottles(contents: LabelTarget[], targets: LabelTarget[]): Record<string, string | null> {
  const pairs = contents
    .flatMap(c => targets.map(t => ({ c: c.id, t: t.id, score: Math.max(...[t.name, ...t.labels].map(n => alike(c.name, n))) })))
    .filter(p => p.score > 0.5)
    .sort((p, q) => q.score - p.score);
  const ids: Record<string, string | null> = Object.fromEntries(contents.map(c => [c.id, null]));
  const taken = new Set<string>();
  for (const p of pairs) {
    if (ids[p.c] !== null || taken.has(p.t)) continue;
    ids[p.c] = p.t;
    taken.add(p.t);
  }
  return ids;
}

/** One bottle SAM found and what its label said. */
export type Seen = { shot: string; box: Box; label: ReadLabels['labels'][number] };

/**
 * Bottles shown as one: those on a photo whose labels name the same component, or one bottle nobody could tell.
 * `boxes` are all of them (drawn on the photo), `box` the biggest (its picture).
 */
export type Group = { shot: string; boxes: Box[]; box: Box; match: Exclude<LabelMatch, 'other'>; component: string | null; looks: string; text: string };

/**
 * Groups the bottles of each photo: all read as one component together (two bottles of Reagent A, ten ampules guessed
 * to be the standard), each bottle neither read nor guessed on its own. Labels naming something not in this run are
 * left out. In photo order, then left to right.
 */
export function groupLabels(seen: Seen[]): Group[] {
  const groups: Group[] = [];
  for (const s of seen) {
    const { match, componentId, looks, text } = s.label;
    if (match === 'other') continue;
    const same = match !== 'none' && groups.find(g => g.shot === s.shot && g.match === match && g.component === componentId);
    if (same) {
      same.boxes.push(s.box);
      if (area(s.box) > area(same.box)) same.box = s.box;
      if (!same.text && text) same.text = text;
    } else {
      groups.push({ shot: s.shot, boxes: [s.box], box: s.box, match, component: match === 'none' ? null : componentId, looks, text });
    }
  }
  return groups;
}

/** A group that becomes a pick or a thing; its picture is cut later, so `crop` is left empty here. */
export type Planned = { picks: Record<string, Omit<KitPick, 'crop'>>; things: Omit<Thing, 'crop'>[] };

/**
 * What a reading adds to the session, leaving alone what the user already chose:
 * - a component read on a label is matched (its biggest picture, when it was read on several photos);
 * - a guess becomes a thing to confirm, once per component (its biggest picture), unless that component is matched;
 * - a bottle nobody could tell becomes a thing to name, the biggest first, as many as there are bottles left to find.
 */
export function planFound(groups: Group[], needs: Need[], taken: { picks: Record<string, unknown>; things: Pick<Thing, 'component' | 'match'>[]; skipped?: Record<string, boolean | undefined> }, nextId: () => string): Planned {
  const ids = new Set(needs.map(n => n.id));
  const picks: Planned['picks'] = {};
  const things: Planned['things'] = [];
  const matched = (id: string) => Boolean(taken.picks[id] || picks[id]);
  const biggest = [...groups].sort((a, b) => area(b.box) - area(a.box));
  for (const g of biggest) {
    if (g.match !== 'read' || !g.component || !ids.has(g.component) || matched(g.component)) continue;
    picks[g.component] = { shot: g.shot, box: g.box, boxes: g.boxes, how: 'read' };
  }
  const guessed = (id: string) => [...taken.things, ...things].some(t => t.match === 'guess' && t.component === id);
  for (const g of groups.filter(g => biggest.find(b => b.match === 'guess' && b.component === g.component) === g)) {
    if (g.match !== 'guess' || !g.component || !ids.has(g.component) || matched(g.component) || guessed(g.component)) continue;
    things.push({ id: nextId(), shot: g.shot, box: g.box, boxes: g.boxes, looks: g.looks, text: g.text, component: g.component, match: 'guess' });
  }
  // Bottles left to find: neither matched, skipped, nor someone's guess.
  const free = needs.filter(n => !matched(n.id) && !taken.skipped?.[n.id] && !guessed(n.id)).length - taken.things.filter(t => t.match === 'none').length;
  const unknown = groups.filter(g => g.match === 'none').sort((a, b) => area(b.box) - area(a.box)).slice(0, Math.max(0, free));
  for (const g of groups.filter(g => unknown.includes(g))) {
    things.push({ id: nextId(), shot: g.shot, box: g.box, boxes: g.boxes, looks: g.looks, text: g.text, component: null, match: 'none' });
  }
  return { picks, things };
}
