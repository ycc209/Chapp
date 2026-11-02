/**
 * Keeps the phone's screen on while Chapp is working on an answer. A long answer (a manual read in, a science question
 * with its sources) runs past the phone's auto-lock, and iOS cuts a locked page's connection: the answer then never
 * arrives, though the server finishes it. One lock is shared by whoever asks; it is let go when the last one is done.
 * Phones without the Screen Wake Lock API, or that refuse it, are simply not kept awake.
 */
let holders = 0;
let sentinel: Promise<{ release(): Promise<void> } | null> | null = null;

export function keepAwake(): () => void {
  holders++;
  if (holders === 1 && typeof navigator !== 'undefined' && 'wakeLock' in navigator) {
    sentinel = (navigator as Navigator & { wakeLock: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock.request('screen').catch(() => null);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders--;
    if (holders > 0) return;
    const held = sentinel;
    sentinel = null;
    void held?.then(lock => lock?.release().catch(() => {}));
  };
}
