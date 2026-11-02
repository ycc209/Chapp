import { useRun } from '../../state/run.ts';

/** Commit progress before routing, so another action in the same batch sees the new step immediately. */
export function goToRunStep(steps: readonly { id: string }[], requested: number, navigate: (to: string) => void, suffix = '') {
  const run = useRun.getState();
  const to = Math.max(0, Math.min(steps.length - 1, requested));
  if (to === run.step + 1 && steps[run.step]) run.setDone(steps[run.step]!.id);
  run.goTo(to);
  navigate(`/run/${to + 1}${suffix}`);
}

/**
 * Skip: the step after `from` by its address alone, so the step skipped is left unticked (the screens bring the run to
 * the step the address says, ticking nothing).
 */
export function skipRunStep(steps: readonly { id: string }[], from: number, navigate: (to: string) => void, suffix = '') {
  navigate(`/run/${Math.min(steps.length - 1, from + 1) + 1}${suffix}`);
}
