import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import type { Box, LabelTarget } from '../../../shared/ai.ts';
import { rememberCover } from '../../state/library.ts';
import { useRun } from '../../state/run.ts';
import { isContents, type How, type Pick, type Thing } from './matching.ts';
import type { Shot } from './photo.ts';
import { benchCut, cutAlong, cutOut } from '../../components/bench/cutout.ts';
import { squareOn } from '../../../shared/kit.ts';

/**
 * This round of photographing the kit: the photos, what the models found on them, which bottle is where, and what
 * Chapp is asking. Kept for the browser tab (sessionStorage), so a reload mid-way keeps the photos; each matched
 * bottle's crop goes into the run (useRun().photos), which is what every other screen shows. Sample sessions (review
 * by address) are never kept and never touch the run.
 */
export type KitSession = {
  shots: Shot[];
  /** What SAM found on each photo (by shot id), and how far reading their labels got. */
  seen: Record<string, Look>;
  /** Matched bottles, by component id: read on their label, or confirmed by the user. */
  picks: Record<string, Pick>;
  /** What the models found but could not be sure of, in the order Chapp asks: guesses to confirm, bottles to name. */
  things: Thing[];
  /** Bottles the user has no photo of ("Not in my photos"). */
  skipped: Record<string, boolean>;
  /** A crop waiting for "Is this the …?". */
  pending: (Pick & { component: string }) | null;
  /** The bottle (component id) or thing (its id) the user chose to answer next; null asks for the first open one. */
  asking: string | null;
  /** "Something else": Chapp asks which bottle the pending crop (or the thing asked about) is. */
  reassign: boolean;
  /** Chapp's last line; null for its opening line. */
  said: string | null;
  sample: boolean;
  /** SAM is following the bottles through a sweep or a video (analysis.ts followBottles); its photos come after. */
  following: 'sweep' | 'video' | null;
  /**
   * A kit new to Chapp: what it holds as its manual's first read lists it (found.ts contentsTargets), the labels read
   * against it, and `picks` keyed by its ids, until the kit's protocol is read (adopt). Null until the manual says;
   * empty when it said nothing of it, or no manual was found.
   */
  contents: LabelTarget[] | null;
};

/**
 * A photo's bottles: SAM is finding them, found them, their labels are being read, were read; or it failed. `boxes`
 * are the bottles SAM found; `outlines` their masks, one per box, as SVG paths in fractions of the photo (none when
 * the server could not decode them); `ids`, which bottle SAM followed through a video each box is (TrackedBottles).
 */
export type Look = { state: 'finding' | 'found' | 'reading' | 'read' | 'failed'; boxes: Box[]; outlines?: (string | undefined)[]; ids?: number[] };

/** SAM's outline of the bottle in `box` on a photo, by the box's place (a box kept in the session is a copy). */
export function outlineAt(look: Look | undefined, box: Box | null | undefined): string | undefined {
  if (!look?.outlines || !box) return undefined;
  const i = look.boxes.findIndex(b => b.x === box.x && b.y === box.y && b.width === box.width && b.height === box.height);
  return i >= 0 ? look.outlines[i] : undefined;
}

type KitActions = {
  addShots: (shots: Shot[]) => void;
  /** Photos with what SAM found on them already (the frames a followed video's bottles are read from). */
  addLooked: (shots: Shot[], looks: Look[]) => void;
  follow: (following: KitSession['following']) => void;
  look: (shot: string, look: Look) => void;
  setContents: (contents: LabelTarget[]) => void;
  /**
   * The kit's protocol is read: what was matched to its contents moves to its bottles (`ids`, found.ts sameBottles),
   * and into the run; one with no bottle like it is asked about instead.
   */
  adopt: (ids: Record<string, string | null>) => void;
  /** A reading's results: bottles read (kept unless the user already matched them) and things to ask about. */
  found: (picks: Record<string, Pick>, things: Thing[], said: string | null) => void;
  /** The thing is `component` (null: not for this run), as the user said or confirmed. */
  answer: (thing: string, component: string | null, how: How, said: string) => void;
  /**
   * The user named a bottle on a photo themselves (a tap on it on the video): it is `component`, or none of the run's
   * (null). Whatever it was matched to or asked about before, it is not any more.
   */
  name: (pick: Pick, component: string | null, said: string) => void;
  propose: (component: string, pick: Pick) => void;
  /** The pending crop is `component` (the one asked, or another the user named). */
  accept: (component: string, said: string) => void;
  /** "Not for this run": drop the pending crop. */
  reject: (said: string) => void;
  setReassign: (reassign: boolean) => void;
  skip: (component: string, said: string) => void;
  /** The bottle's picture did not come out whole: its match is dropped and Chapp asks for it again, on the next photo. */
  retake: (component: string, said: string) => void;
  ask: (component: string | null) => void;
  say: (said: string | null) => void;
  seed: (session: Partial<KitSession>) => void;
  clear: () => void;
};

/**
 * A matched bottle's crop goes into the run, and is cut out of its background right away (bench/cutout.ts): along
 * SAM's outline of it when there is one (the mask is the cut), else by the phone's own means. Then, in the
 * background, it is made ready for the step pictures (benchCut): turned upright, and made whole by Muse Image, so it
 * is done by the time a step shows it.
 */
function keep(component: string, pick: Pick, session: { shots: Shot[]; seen: Record<string, Look> }) {
  useRun.getState().setPhoto(component, pick.crop);
  noteAdded({ photo: [component, pick.crop] });
  const shot = session.shots.find(s => s.id === pick.shot);
  const outline = outlineAt(session.seen[pick.shot], pick.box);
  void (outline && shot ? cutAlong(pick.crop, outline, squareOn(pick.box, shot.width, shot.height)) : cutOut(pick.crop));
  void benchCut(pick.crop);
}

const empty: KitSession = { shots: [], seen: {}, picks: {}, things: [], skipped: {}, pending: null, asking: null, reassign: false, said: null, sample: false, following: null, contents: null };

/** Guesses about a bottle the user has now matched are moot. */
const settled = (things: Thing[], component: string) => things.filter(t => !(t.match === 'guess' && t.component === component));

/** In-flight looks don't survive a reload: a photo still being looked at is looked at again, its labels read again. */
function keepable(seen: Record<string, Look>): Record<string, Look> {
  return Object.fromEntries(
    Object.entries(seen)
      .filter(([, l]) => l.state !== 'finding')
      .map(([id, l]) => [id, l.state === 'reading' ? { ...l, state: 'found' as const } : l]),
  );
}

// Photos are a few hundred kB: if the tab's storage is full the session just isn't kept.
const quiet: StateStorage = {
  getItem: name => {
    try {
      return sessionStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem: (name, value) => {
    try {
      sessionStorage.setItem(name, value);
    } catch {
      /* not kept */
    }
  },
  removeItem: name => {
    try {
      sessionStorage.removeItem(name);
    } catch {
      /* nothing kept */
    }
  },
};

export const useKit = create<KitSession & KitActions>()(
  persist(
    (set, get) => ({
      ...empty,
      addShots: shots => set(s => ({ shots: [...s.shots, ...shots] })),
      addLooked: (shots, looks) =>
        set(s => ({ shots: [...s.shots, ...shots], seen: { ...s.seen, ...Object.fromEntries(shots.map((shot, i) => [shot.id, looks[i]!])) } })),
      follow: following => set({ following }),
      look: (shot, look) => set(s => ({ seen: { ...s.seen, [shot]: look } })),
      setContents: contents => set({ contents }),
      adopt: ids => {
        const s = get();
        const picks: Record<string, Pick> = {};
        const moved: [string, Pick][] = [];
        const unlike: Thing[] = [];
        for (const [id, pick] of Object.entries(s.picks)) {
          if (!isContents(id)) picks[id] = pick;
          else if (ids[id]) moved.push([ids[id], pick]);
          else unlike.push({ ...pick, id: `thing-${Date.now().toString(36)}-${(s.things.length + unlike.length).toString(36)}`, looks: 'bottle', text: '', component: null, match: 'none' });
        }
        const fresh = moved.filter(([id], i) => !picks[id] && moved.findIndex(([other]) => other === id) === i);
        for (const [id, pick] of fresh) picks[id] = pick;
        if (!s.sample) for (const [id, pick] of fresh) keep(id, pick, s);
        const things = s.things.map(t => (!t.component || !isContents(t.component) ? t : ids[t.component] ? { ...t, component: ids[t.component] } : { ...t, component: null, match: 'none' as const }));
        set({ picks, things: [...things, ...unlike], contents: null });
      },
      found: (picks, things, said) => {
        const { sample } = get();
        const fresh = Object.entries(picks).filter(([id]) => !get().picks[id]);
        // Matched to a kit's contents, not yet to its protocol's bottles: into the run once they are (adopt).
        if (!sample) for (const [id, pick] of fresh) if (!isContents(id)) keep(id, pick, get());
        set(s => ({ picks: { ...s.picks, ...Object.fromEntries(fresh) }, things: [...s.things, ...things], ...(said === null ? {} : { said }) }));
      },
      answer: (id, component, how, said) => {
        const { things, sample } = get();
        const thing = things.find(t => t.id === id);
        if (!thing) return;
        const rest = things.filter(t => t !== thing);
        if (!component) return set({ things: rest, asking: null, reassign: false, said });
        const pick: Pick = { shot: thing.shot, box: thing.box, boxes: thing.boxes, crop: thing.crop, how };
        if (!sample) keep(component, pick, get());
        set(s => ({
          picks: { ...s.picks, [component]: pick },
          skipped: { ...s.skipped, [component]: false },
          things: settled(rest, component),
          asking: null,
          reassign: false,
          said,
        }));
      },
      name: (pick, component, said) => {
        const { sample, picks } = get();
        const same = (a: Box, b: Box) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
        const on = (p: Pick) => p.shot === pick.shot && [p.box, ...(p.boxes ?? [])].some(b => same(b, pick.box));
        // The run's photo of what it was matched to before goes, unless that is what it still is.
        const was = Object.entries(picks).filter(([id, p]) => on(p) && id !== component);
        if (!sample) {
          const photos = { ...useRun.getState().photos };
          for (const [id, p] of was) if (photos[id] === p.crop) delete photos[id];
          if (was.length) useRun.setState({ photos });
        }
        const named: Pick = { ...pick, how: 'picked' };
        if (component && !sample) keep(component, named, get());
        set(s => ({
          picks: { ...Object.fromEntries(Object.entries(s.picks).filter(([id]) => !was.some(([w]) => w === id))), ...(component ? { [component]: named } : {}) },
          skipped: component ? { ...s.skipped, [component]: false } : s.skipped,
          things: component ? settled(s.things.filter(t => !on(t)), component) : s.things.filter(t => !on(t)),
          said,
        }));
      },
      propose: (component, pick) => set({ pending: { ...pick, component }, asking: component, reassign: false }),
      accept: (component, said) => {
        const { pending, sample } = get();
        if (!pending) return;
        const pick: Pick = { shot: pending.shot, box: pending.box, crop: pending.crop };
        if (!sample) keep(component, pick, get());
        set(s => ({
          picks: { ...s.picks, [component]: pick },
          skipped: { ...s.skipped, [component]: false },
          things: settled(s.things, component),
          pending: null,
          reassign: false,
          // Named as something else: the bottle asked about is still to find.
          asking: component === pending.component ? null : pending.component,
          said,
        }));
      },
      reject: said => set({ pending: null, reassign: false, said }),
      setReassign: reassign => set({ reassign }),
      skip: (component, said) => set(s => ({ skipped: { ...s.skipped, [component]: true }, asking: null, said })),
      retake: (component, said) =>
        set(s => {
          const picks = { ...s.picks };
          delete picks[component];
          return { picks, skipped: { ...s.skipped, [component]: false }, pending: null, asking: component, reassign: false, said };
        }),
      ask: component => set({ asking: component, pending: null, reassign: false }),
      say: said => set({ said }),
      seed: session => set({ ...empty, ...session }),
      clear: () => {
        // What the round still has under way (SAM following a video, a cover) is for a round that is over.
        round++;
        set(empty);
      },
    }),
    {
      name: 'chapp.kit',
      storage: createJSONStorage(() => quiet),
      partialize: s =>
        s.sample
          ? empty
          : { shots: s.shots, seen: keepable(s.seen), picks: s.picks, things: s.things, skipped: s.skipped, pending: s.pending, asking: s.asking, reassign: false, said: s.said, sample: false, following: null, contents: s.contents },
    },
  ),
);

/** Which round of photos this is: a new one each time a round is cleared, so work still under way for one that is over is dropped. */
let round = 0;
export const roundNow = () => round;

// ---------------------------------------------------------------------------------------------------------------
// What this tab's rounds put into the run's kit

/**
 * What this tab's rounds of photos and videos added to the run's kit: each bottle's photo (its crop) and whether they
 * gave the kit its cover. Kept for the tab (sessionStorage), so the protocol's × can take back what was just
 * photographed or uploaded (forgetAdded) and nothing older.
 */
export type Added = { protocolId: string | null; photos: Record<string, string>; cover: boolean };

const nothing: Added = { protocolId: null, photos: {}, cover: false };
export const useAdded = create<Added>()(persist(() => nothing, { name: 'chapp.added', storage: createJSONStorage(() => quiet) }));

/** Notes a bottle's photo or the cover a round gave the run's kit (another kit's notes go). */
export function noteAdded(what: { photo?: [string, string]; cover?: string }) {
  const protocolId = what.cover ?? useRun.getState().protocolId;
  if (!protocolId) return;
  useAdded.setState(s => {
    const base = s.protocolId === protocolId ? s : { ...nothing, protocolId };
    return { ...base, photos: what.photo ? { ...base.photos, [what.photo[0]]: what.photo[1] } : base.photos, cover: base.cover || Boolean(what.cover) };
  });
}

/** Whether this tab's rounds added anything to `protocolId`'s kit: a photo or the cover, or a round still under way. */
export function addedTo(added: Added, protocolId: string | null | undefined, shots: number): boolean {
  if (!protocolId) return false;
  return shots > 0 || (added.protocolId === protocolId && (Object.keys(added.photos).length > 0 || added.cover));
}

/**
 * Takes back what this tab's rounds added to the kit: the round under way (its photos, what the models are still
 * doing), each bottle's photo that is still the one it gave (a later one stays), and the cover it gave.
 */
export function forgetAdded() {
  const added = useAdded.getState();
  useKit.getState().clear();
  const run = useRun.getState();
  if (added.protocolId && run.protocolId === added.protocolId) {
    const photos = Object.fromEntries(Object.entries(run.photos).filter(([id, src]) => added.photos[id] !== src));
    useRun.setState({ photos });
  }
  if (added.protocolId && added.cover) rememberCover(added.protocolId, null);
  useAdded.setState(nothing);
}
