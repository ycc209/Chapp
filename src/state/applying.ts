/**
 * Whether a change to the run is not the user's own tap: Chapp carrying out what was asked (its receipt already says
 * what changed), or the app swapping one experiment's run for another's (src/state/threads.ts). What the user does by
 * hand is written into the conversation (src/state/runEvents.ts); these are not.
 */
let depth = 0;

export const applying = () => depth > 0;

/** Runs `work` (a promise's whole length) as a change that is not the user's own. */
export async function asAssistant<T>(work: () => Promise<T>): Promise<T> {
  depth++;
  try {
    return await work();
  } finally {
    depth--;
  }
}

/** The same for a change made at once. */
export function quietly<T>(work: () => T): T {
  depth++;
  try {
    return work();
  } finally {
    depth--;
  }
}
