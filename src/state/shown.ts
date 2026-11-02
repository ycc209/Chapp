import { create } from 'zustand';

/**
 * The plan on the card the user last changed by hand under an answer (Chapp's ReagentCard, PlateCard or Compare):
 * what the next thing said is about ("is that enough?"), so it goes along with it (ConverseContext.shown) until a new
 * card is drawn. Not the run's plan: that changes only with "Use this plan".
 */
type Shown = {
  plan: { samples: number; replicates: number; standardReplicates?: number } | null;
  set: (plan: { samples: number; replicates: number; standardReplicates?: number }) => void;
  clear: () => void;
};

export const useShown = create<Shown>()(set => ({
  plan: null,
  set: plan => set({ plan }),
  clear: () => set({ plan: null }),
}));
