import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * The run made small (src/app/RunDock.tsx): floating over the other screens, Home first, until it is opened again. Its
 * steps' titles are kept from when it was made small (the step itself is the run's, useRun().step, so it follows
 * Chapp moving the run on), and where it floats: the side of the screen and how far down (0 top … 1 bottom).
 */
export type Dock = {
  titles: string[] | null;
  side: 'left' | 'right';
  y: number;
};

type DockActions = {
  /** Makes the run small, with its steps' titles. */
  minimize: (titles: string[]) => void;
  /** Back to the run (or the run is over): no longer floating. */
  restore: () => void;
  place: (side: Dock['side'], y: number) => void;
};

export const useDock = create<Dock & DockActions>()(
  persist(
    set => ({
      titles: null,
      side: 'right',
      y: 0.66,
      minimize: titles => set({ titles }),
      restore: () => set({ titles: null }),
      place: (side, y) => set({ side, y }),
    }),
    { name: 'chapp.dock' },
  ),
);

/** How long is left on a timer, as the floating run shows it: "4:05", "1:20 h", "2 d 3 h". Pure, so it is tested. */
export function leftText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 3600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  if (s < 86400) return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')} h`;
  return `${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} h`;
}
