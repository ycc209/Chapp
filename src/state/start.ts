import type { Protocol } from '../../shared/protocol.ts';
import { startPath } from '../screens/protocol/content.ts';
import { runStarted, useRun } from './run.ts';

/**
 * Start the experiment, one way from everywhere (the Overview's Start, Start or plan, the plan's Start, the start
 * card, Chapp asked to start): where the run goes, after marking it begun. Back to the step it is at once it has
 * begun; else the manual's reagent prep when it has some; else step 1, or the step after the standards when they are
 * already made.
 */
export function beginRun(p: Protocol): string {
  const run = useRun.getState();
  if (runStarted(run)) {
    run.begin();
    return `/run/${run.step + 1}`;
  }
  run.begin();
  if (startPath(p, run.procedure, false) === '/run/prep') return '/run/prep';
  const step = run.standards === 'ready' ? 1 : 0;
  run.goTo(step);
  return `/run/${step + 1}`;
}
