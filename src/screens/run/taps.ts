/** How long a first tap waits for a second, to tell a tap from a double tap. */
export const DOUBLE_TAP_MS = 280;

/** What a tap on a run step's page means: its right side is Next, its left Back, two taps anywhere Skip. */
export type StepTap = 'next' | 'back' | 'skip';

/** What a tap on the page is not for: something with its own tap (a button, a link, a field, a bottle to tick). */
export const OWN_TAP = 'button, a, input, textarea, select, label, [role="button"], [data-own-tap]';

type Timers = { set: (fn: () => void, ms: number) => unknown; clear: (id: unknown) => void };
const realTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: id => clearTimeout(id as ReturnType<typeof setTimeout>) };

/**
 * Tells taps on a step's page apart, each given as where it fell across the page (0 left … 1 right): a tap with no
 * second one within DOUBLE_TAP_MS is Next or Back by its side; a second tap within it makes the two a Skip. `cancel`
 * drops a tap still waiting (the screen is going). Timers are injected for tests. Pure of the DOM, so it is tested.
 */
export function tapReader(onTap: (tap: StepTap) => void, timers: Timers = realTimers) {
  let waiting: unknown = null;
  const read = (across: number) => {
    if (waiting !== null) {
      timers.clear(waiting);
      waiting = null;
      onTap('skip');
      return;
    }
    const side: StepTap = across >= 0.5 ? 'next' : 'back';
    waiting = timers.set(() => {
      waiting = null;
      onTap(side);
    }, DOUBLE_TAP_MS);
  };
  read.cancel = () => {
    if (waiting !== null) timers.clear(waiting);
    waiting = null;
  };
  return read;
}
