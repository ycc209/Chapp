import type { Box } from '../../../shared/ai.ts';
import type { Shot } from './photo.ts';
import type { KitSession } from './store.ts';

/** Who does a piece of the kit's work: SAM finds and follows the bottles, Muse Spark reads them. */
export type Model = 'SAM 3.1' | 'Muse Spark';

/**
 * What Chapp is doing with the kit's photos, as lines to tick off, which model each one is (`by`, line for line), and
 * whether any of it is still under way.
 */
export type KitProgress = { lines: string[]; by: Model[]; busy: boolean };

/**
 * The round's photos as work in progress, for a screen to show while the models look at them in the background (the
 * protocol after a video): SAM following the bottles through the video, finding them on the photos, Muse Spark reading
 * the labels, and how many of the bottles in the kit's box or bag (`inKit`, their ids) they matched; the user's own
 * bottles are theirs to show or not. The last line is the one under way when `busy`. Nothing for a round with no
 * photos. Pure, so it is tested.
 */
export function kitProgress(kit: Pick<KitSession, 'shots' | 'seen' | 'picks' | 'following' | 'sample'>, inKit: string[]): KitProgress {
  const lines: string[] = [];
  const by: Model[] = [];
  const say = (line: string, model: Model) => {
    lines.push(line);
    by.push(model);
  };
  const result = (busy: boolean): KitProgress => ({ lines, by, busy });
  if (kit.sample) return result(false);
  const footage = kit.following ?? (kit.shots.some(s => s.video) ? 'video' : kit.shots.some(s => s.sweep) ? 'sweep' : null);
  if (kit.following) {
    say(`Following the bottles through your ${footage}`, 'SAM 3.1');
    return result(true);
  }
  if (!kit.shots.length) return result(false);
  if (footage) say(`Followed the bottles through your ${footage}`, 'SAM 3.1');

  const looks = kit.shots.map(s => kit.seen[s.id]);
  const photos = footage ? 'frames' : 'photos';
  const n = kit.shots.length;
  const finding = looks.some(l => !l || l.state === 'finding');
  const found = looks.filter(l => l && l.state !== 'finding' && l.state !== 'failed').length;
  if (finding) {
    say(n === 1 ? `Finding the bottles on your ${photos.slice(0, -1)}` : `Finding the bottles on ${n} ${photos}`, 'SAM 3.1');
    return result(true);
  }
  if (found) say(found === 1 ? `Found the bottles on ${n === 1 ? `your ${photos.slice(0, -1)}` : `1 of ${n} ${photos}`}` : `Found the bottles on ${found === n ? `${n} ${photos}` : `${found} of ${n} ${photos}`}`, 'SAM 3.1');
  else {
    say(`I couldn’t find any bottles on your ${n === 1 ? photos.slice(0, -1) : photos}`, 'SAM 3.1');
    return result(false);
  }

  const reading = looks.some(l => l?.state === 'reading');
  const read = looks.some(l => l?.state === 'read');
  if (reading) {
    say('Reading the labels', 'Muse Spark');
    return result(true);
  }
  if (!read) return result(false);
  // Not how many: which of them, the screen shows. The kit's bottles not known yet (its manual still being read): any.
  const matched = inKit.length ? inKit.filter(id => kit.picks[id]).length : Object.keys(kit.picks).length;
  say(!matched ? 'Read the labels, but none matched the kit' : matched === inKit.length ? 'Matched every bottle in the kit' : 'Matched the labels to the kit', 'Muse Spark');
  return result(false);
}

/**
 * What to call each bottle SAM followed through a video (TrackedBottles ids), by the kit's bottles its label matched
 * (`picks`, by component id) and which followed bottle each matched box was (Look.ids): for the names drawn on the
 * bottles as the video plays again. Pure, so it is tested.
 */
export function trackNames(kit: Pick<KitSession, 'picks' | 'seen'>, components: { id: string; name: string }[]): Map<number, string> {
  return new Map([...trackMatches(kit, components)].map(([id, m]) => [id, m.name]));
}

/** The same, with which of the kit's bottles each is (its component id): for its colour too. */
export function trackMatches(kit: Pick<KitSession, 'picks' | 'seen'>, components: { id: string; name: string }[]): Map<number, { component: string; name: string }> {
  const matches = new Map<number, { component: string; name: string }>();
  for (const [component, pick] of Object.entries(kit.picks)) {
    const look = kit.seen[pick.shot];
    const k = look?.boxes.findIndex(b => b.x === pick.box.x && b.y === pick.box.y && b.width === pick.box.width && b.height === pick.box.height) ?? -1;
    const id = k >= 0 ? look?.ids?.[k] : undefined;
    const name = components.find(c => c.id === component)?.name;
    if (id !== undefined && name) matches.set(id, { component, name });
  }
  return matches;
}

/**
 * Each of the kit's bottles in a colour of its own (by its place in the kit's list), the same wherever it is drawn on
 * the video and in the strip of bottles found. Deep enough for white words on it; none of them the recording red.
 */
export const BOTTLE_COLOURS = ['#1f6feb', '#1a7f37', '#c2410c', '#be185d', '#7c3aed', '#0e7490', '#a16207', '#4d7c0f'];
export const colourOf = (component: string, components: { id: string }[]) => {
  const i = components.findIndex(c => c.id === component);
  return BOTTLE_COLOURS[(i < 0 ? 0 : i) % BOTTLE_COLOURS.length]!;
};

/** One bottle the models found on the round's photos, for the strip at the end of a video. */
export type FoundBottle = { key: string; shot: Shot; box: Box; outline?: string; component?: string; name?: string; unsure: boolean };

const sameBox = (a: Box, b: Box) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/**
 * Every bottle found on the round's photos (a video's frames), in order: its photo and box, its name once its label
 * matched one of the kit's bottles (`components`), and whether Chapp is still unsure of it (a guess or a bottle nobody
 * could tell, asked about later). Once every label is read, a bottle that is neither (the same bottle again, from
 * another moment of the video, or one the run does not use) is left out. Pure, so it is tested.
 */
export function foundBottles(kit: Pick<KitSession, 'shots' | 'seen' | 'picks' | 'things'>, components: { id: string; name: string }[]): FoundBottle[] {
  const all: FoundBottle[] = [];
  for (const shot of kit.shots) {
    const look = kit.seen[shot.id];
    if (!look || look.state === 'finding' || look.state === 'failed') continue;
    look.boxes.forEach((box, k) => {
      const on = (p: { shot: string; box: Box; boxes?: Box[] }) => p.shot === shot.id && (sameBox(p.box, box) || Boolean(p.boxes?.some(b => sameBox(b, box))));
      const component = Object.entries(kit.picks).find(([, pick]) => on(pick))?.[0];
      const name = components.find(c => c.id === component)?.name;
      const outline = look.outlines?.[k];
      all.push({ key: `${shot.id}:${k}`, shot, box, ...(outline ? { outline } : {}), ...(name && component ? { component, name } : {}), unsure: !name && kit.things.some(on) });
    });
  }
  const read = kit.shots.every(s => ['read', 'failed'].includes(kit.seen[s.id]?.state ?? ''));
  return read ? all.filter(b => b.name || b.unsure) : all;
}

/**
 * Bottles side by side that would carry the same label (five ampules of one standard, or five still being read): one
 * label over them all, not five on top of each other. Bottles go together when their boxes stand next to each other
 * (a gap under a quarter of their width, mostly level) and their names are the same. Left to right. Pure.
 */
export function labelGroups<T extends { box: Box; name?: string }>(bottles: T[]): { box: Box; bottles: T[] }[] {
  const groups: { box: Box; bottles: T[] }[] = [];
  for (const b of [...bottles].sort((a, c) => a.box.x - c.box.x)) {
    const g = groups.at(-1);
    const prev = g?.bottles.at(-1);
    const gap = prev ? b.box.x - (prev.box.x + prev.box.width) : Infinity;
    const level = prev ? Math.min(prev.box.y + prev.box.height, b.box.y + b.box.height) - Math.max(prev.box.y, b.box.y) : 0;
    if (g && prev && (prev.name ?? '') === (b.name ?? '') && gap < 0.25 * Math.min(prev.box.width, b.box.width) && level > 0.5 * Math.min(prev.box.height, b.box.height)) {
      const x = Math.min(g.box.x, b.box.x);
      const y = Math.min(g.box.y, b.box.y);
      g.box = { x, y, width: Math.max(g.box.x + g.box.width, b.box.x + b.box.width) - x, height: Math.max(g.box.y + g.box.height, b.box.y + b.box.height) - y };
      g.bottles.push(b);
    } else groups.push({ box: { ...b.box }, bottles: [b] });
  }
  return groups;
}
