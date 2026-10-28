import type { Protocol } from '../../../shared/protocol.ts';
import type { PlanFit } from '../../../shared/plate.ts';
import type { Bench, PlateCheck, TimerPhase } from './model.ts';
import type { PushState } from './push.ts';

/** What a step draws, the same for the buttons layout (Run-*) and the gloves-on one (Gloves-*). */
export type View = {
  p: Protocol;
  bench: Bench;
  /** The step on screen, from 0. */
  at: number;
  /** Ticked vials (A–I), loaded tubes (tube:N) and finished steps, by id. */
  done: Record<string, boolean>;
  /** The last command the user said on this step ("C is OK"), shown above it; null when none. */
  heard: string | null;
  timer: {
    phase: TimerPhase;
    /** Seconds the incubation lasts: the length chosen, or the protocol's own. */
    total: number;
    endsAt: number | null;
    /** Seconds left, while stopped. */
    left: number | null;
    /** Gloves on, "stop" heard: Chapp asks first (Gloves-Timer, "Stop the timer?"). */
    confirm: boolean;
  };
  readings: { count: number; sample: boolean };
  /** The user's photo of each bottle, by component id (useRun().photos). */
  photos: Record<string, string>;
  /** Something just changed with what was said: the wells now (Run-Load), the end time (Run-Incubate). */
  flash: boolean;
  tickVial: (id: string) => void;
  tapTube: (index: number) => void;
  choose: (seconds: number) => void;
  /** Tap the time: end the incubation now (Run-Timer). */
  finish: () => void;
  toResults: () => void;
  /** Readings waiting on Run-Read for the user's look (a model's reading, or a file with wells left out), or null. */
  check: { check: PlateCheck; fit: PlanFit; wells: string[]; edit: (well: string, value: number | null) => void; confirm: () => void; again: () => void } | null;
  /** The name of a file being read right now, or null. */
  reading: string | null;
  /** Time's up on the lock screen: what this browser allows (src/screens/run/push.ts), and the tap that asks for it. */
  push: { state: PushState; enable: () => void };
};
