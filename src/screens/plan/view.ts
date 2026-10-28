import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';

/**
 * What the plan screen remembers besides the run's numbers: whether the user has chosen how to make the standards.
 * The run starts on the kit's own table, but Plan asks first (Plan.dc.html) until a way is picked or said. Kept for
 * the browser tab, so leaving for the run and coming back shows the plan, not the question again.
 */
type PlanViewState = { picked: boolean; setPicked: (picked: boolean) => void };

// sessionStorage can throw (private windows, blocked storage): then it is simply not kept.
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
      /* nothing to remove */
    }
  },
};

export const usePlanView = create<PlanViewState>()(
  persist(set => ({ picked: false, setPicked: picked => set({ picked }) }), { name: 'chapp.plan', storage: createJSONStorage(() => quiet) }),
);
