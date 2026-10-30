import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import type { Box } from '../../../shared/ai.ts';
import { useRun } from '../../state/run.ts';
import type { How, Pick, Thing } from './matching.ts';
import type { Shot } from './photo.ts';
import { cutAlong, cutOut } from '../../components/bench/cutout.ts';
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
};

/**
 * A photo's bottles: SAM is finding them, found them, their labels are being read, were read; or it failed. `boxes`
 * are the bottles SAM found; `outlines` their masks, one per box, as SVG paths in fractions of the photo (none when
 * the server could not decode them).
 */
export type Look = { state: 'finding' | 'found' | 'reading' | 'read' | 'failed'; boxes: Box[]; outlines?: (string | undefined)[] };

/** SAM's outline of the bottle in `box` on a photo, by the box's place (a box kept in the session is a copy). */
export function outlineAt(look: Look | undefined, box: Box | null | undefined): string | undefined {
  if (!look?.outlines || !box) return undefined;
  const i = look.boxes.findIndex(b => b.x === box.x && b.y === box.y && b.width === box.width && b.height === box.height);
  return i >= 0 ? look.outlines[i] : undefined;
}

type KitActions = {
  addShots: (shots: Shot[]) => void;
  look: (shot: string, look: Look) => void;
  /** A reading's results: bottles read (kept unless the user already matched them) and things to ask about. */
  found: (picks: Record<string, Pick>, things: Thing[], said: string | null) => void;
  /** The thing is `component` (null: not for this run), as the user said or confirmed. */
  answer: (thing: string, component: string | null, how: How, said: string) => void;
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
 * SAM's outline of it when there is one (the mask is the cut), else by the phone's own means.
 */
function keep(component: string, pick: Pick, session: { shots: Shot[]; seen: Record<string, Look> }) {
  useRun.getState().setPhoto(component, pick.crop);
  const shot = session.shots.find(s => s.id === pick.shot);
  const outline = outlineAt(session.seen[pick.shot], pick.box);
  void (outline && shot ? cutAlong(pick.crop, outline, squareOn(pick.box, shot.width, shot.height)) : cutOut(pick.crop));
}

const empty: KitSession = { shots: [], seen: {}, picks: {}, things: [], skipped: {}, pending: null, asking: null, reassign: false, said: null, sample: false };

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
      look: (shot, look) => set(s => ({ seen: { ...s.seen, [shot]: look } })),
      found: (picks, things, said) => {
        const { sample } = get();
        const fresh = Object.entries(picks).filter(([id]) => !get().picks[id]);
        if (!sample) for (const [id, pick] of fresh) keep(id, pick, get());
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
      clear: () => set(empty),
    }),
    {
      name: 'chapp.kit',
      storage: createJSONStorage(() => quiet),
      partialize: s =>
        s.sample
          ? empty
          : { shots: s.shots, seen: keepable(s.seen), picks: s.picks, things: s.things, skipped: s.skipped, pending: s.pending, asking: s.asking, reassign: false, said: s.said, sample: false },
    },
  ),
);
