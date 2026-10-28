import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * This run of a kit: the protocol, the plan, how far along it is and what was measured. Kept on the phone, so a
 * reload in the middle of a run loses nothing.
 */
export type RunState = {
  protocolId: string | null;
  procedure: string;
  samples: number;
  /** Replicates for the samples. */
  replicates: number;
  /** Replicates for the standards (Plan-Heard: "five standards once, samples ×3"). "Make it triplicates" sets both. */
  standardReplicates: number;
  /** How the standards are made, Plan-Ask's four ways: the kit's dilution table, halving from the top, five standards, or already made. */
  standards: 'kit' | 'halve' | 'five' | 'ready';
  /** The step on screen, from 0. */
  step: number;
  /** Ticked things, by id: a standard vial, a well, a step. */
  done: Record<string, boolean>;
  /** Running timers, by id, as the time they end (ms since epoch). */
  timers: Record<string, number>;
  /** The user's photo of each component, by component id. */
  photos: Record<string, string>;
  /** Plate-reader values, by well id (wells as plateMap() in src/components/lab/model.ts lays them out). */
  readings: Record<string, number>;
  /** Where the readings came from: built-in example values must always be labeled "Sample data". */
  readingsFrom: 'sample' | 'plate' | null;
  /**
   * A new conversation set this run aside: Chapp on Home no longer assumes it, until the user opens the run again
   * (the sidebar, or a run screen) or a kit is found.
   */
  aside: boolean;
};

type RunActions = {
  setProtocol: (protocolId: string | null) => void;
  setPlan: (plan: Partial<Pick<RunState, 'procedure' | 'samples' | 'replicates' | 'standardReplicates' | 'standards'>>) => void;
  goTo: (step: number) => void;
  next: () => void;
  previous: () => void;
  setDone: (id: string, done?: boolean) => void;
  startTimer: (id: string, seconds: number) => void;
  stopTimer: (id: string) => void;
  setPhoto: (componentId: string, photo: string) => void;
  setReading: (wellId: string, value: number) => void;
  /** Replaces every reading at once, saying where they came from. */
  setReadings: (readings: Record<string, number>, from: 'sample' | 'plate') => void;
  setAside: (aside: boolean) => void;
  reset: () => void;
};

// No kit until the user names or finds one (screens that need one show the BCA kit); the storyboard's plan, a
// microplate with 12 samples in duplicate.
const fresh: RunState = {
  protocolId: null,
  procedure: 'microplate',
  samples: 12,
  replicates: 2,
  standardReplicates: 2,
  standards: 'kit',
  step: 0,
  done: {},
  timers: {},
  photos: {},
  readings: {},
  readingsFrom: null,
  aside: false,
};

export const useRun = create<RunState & RunActions>()(
  persist(
    set => ({
      ...fresh,
      setProtocol: protocolId => set({ protocolId, step: 0, done: {}, timers: {}, aside: false }),
      setPlan: plan => set(plan),
      goTo: step => set({ step: Math.max(0, step) }),
      next: () => set(s => ({ step: s.step + 1 })),
      previous: () => set(s => ({ step: Math.max(0, s.step - 1) })),
      setDone: (id, done = true) => set(s => ({ done: { ...s.done, [id]: done } })),
      startTimer: (id, seconds) => set(s => ({ timers: { ...s.timers, [id]: Date.now() + seconds * 1000 } })),
      stopTimer: id => set(s => ({ timers: Object.fromEntries(Object.entries(s.timers).filter(([k]) => k !== id)) })),
      setPhoto: (componentId, photo) => set(s => ({ photos: { ...s.photos, [componentId]: photo } })),
      setReading: (wellId, value) => set(s => ({ readings: { ...s.readings, [wellId]: value }, readingsFrom: 'plate' })),
      setReadings: (readings, from) => set({ readings, readingsFrom: from }),
      setAside: aside => set({ aside }),
      reset: () => set(fresh),
    }),
    { name: 'chapp.run' },
  ),
);
