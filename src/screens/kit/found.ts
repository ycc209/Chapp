import type { Box, LabelMatch, LabelTarget, ReadLabels } from '../../../shared/ai.ts';
import { area } from '../../../shared/kit.ts';
import type { Protocol } from '../../../shared/protocol.ts';
import { bottles } from '../protocol/content.ts';
import type { Need, Pick as KitPick, Thing } from './matching.ts';

/**
 * What the models found on the photos, turned into what the kit screen shows (Recognized.dc.html): bottles whose
 * label was read become matched rows; the rest become things Chapp asks about ("Is the small vial the Albumin
 * Standard?", "What's the tall bottle?"). Pure, so it is tested; the cropping lives in analysis.ts.
 */

/** The run's bottles as /api/kit/labels takes them: the kit's own, then the user's. */
export function labelTargets(p: Protocol): LabelTarget[] {
  return bottles(p).map(c => ({ id: c.id, name: c.name, role: c.role, kit: c.suppliedBy === 'kit', labels: c.label ?? [] }));
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
