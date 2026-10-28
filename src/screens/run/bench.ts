import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useRun } from '../../state/run.ts';
import type { PlateCheck } from './model.ts';

/**
 * The run screen's own progress, beside useRun() (which keeps the ticks, the running timers and the readings): the
 * incubation length chosen, a timer stopped part-way, the timers already announced as done (so a reload does not ring
 * twice), the photo of the plate reader's screen, and readings waiting on Run-Read for the user's look (a model's
 * reading of that photo, or a file with wells left out). Cleared when the run starts over.
 */
type BenchState = {
  /** Seconds chosen for each timer (by step id): 1800, or the protocol's 2 h alternative. */
  lengths: Record<string, number>;
  /** A timer stopped part-way: the seconds that were left, by step id. */
  paused: Record<string, number>;
  /** The end time already announced for each timer, by step id. */
  announced: Record<string, number>;
  /** The photo of the reader's screen (a small JPEG data URL), or null. */
  platePhoto: string | null;
  /** Readings to check before Results uses them, or null. */
  check: PlateCheck | null;
  setLength: (id: string, seconds: number) => void;
  pause: (id: string, left: number) => void;
  unpause: (id: string) => void;
  announce: (id: string, endsAt: number) => void;
  setPlatePhoto: (src: string | null) => void;
  setCheck: (check: PlateCheck | null) => void;
  clear: () => void;
};

const without = (r: Record<string, number>, id: string) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== id));

export const useBench = create<BenchState>()(
  persist(
    set => ({
      lengths: {},
      paused: {},
      announced: {},
      platePhoto: null,
      check: null,
      setLength: (id, seconds) => set(s => ({ lengths: { ...s.lengths, [id]: seconds } })),
      pause: (id, left) => set(s => ({ paused: { ...s.paused, [id]: left } })),
      unpause: id => set(s => ({ paused: without(s.paused, id) })),
      announce: (id, endsAt) => set(s => ({ announced: { ...s.announced, [id]: endsAt } })),
      setPlatePhoto: platePhoto => set({ platePhoto }),
      setCheck: check => set({ check }),
      clear: () => set({ lengths: {}, paused: {}, announced: {}, platePhoto: null, check: null }),
    }),
    { name: 'chapp.run.bench' },
  ),
);

// A new run (setProtocol or reset clears the ticks and timers): start the bench over too.
if (typeof window !== 'undefined') {
  useRun.subscribe((now, before) => {
    const emptied = (a: object, b: object) => Object.keys(a).length === 0 && Object.keys(b).length > 0;
    if (emptied(now.done, before.done) && Object.keys(now.timers).length === 0) useBench.getState().clear();
  });
}
