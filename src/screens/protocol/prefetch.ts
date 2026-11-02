import type { FoundProtocol, ProtocolIntro } from '../../../shared/ai.ts';
import { api } from '../../api/client.ts';

type Run = {
  lines: string[];
  intro?: ProtocolIntro;
  result: Promise<FoundProtocol>;
  /** Who is watching the search go, once the Overview is on screen. */
  watchers: { heard: (line: string) => void; told: (intro: ProtocolIntro) => void }[];
};

/** Searches under way or done, by what they look for; a search that failed is forgotten, so the Overview tries again. */
const runs = new Map<string, Run>();

/**
 * Starts the search for a kit's manual before the Overview is on screen (a video of the kit still playing, Watch.tsx):
 * when the Overview opens for the same `ask`, findProtocol shows it what the search has said so far and the rest as
 * it comes, so no time is lost. Asked twice, it searches once.
 */
export function prefetchFinding(ask: string) {
  if (runs.has(ask)) return;
  const run: Run = { lines: [], watchers: [], result: null! };
  run.result = api.findProtocolLive(
    ask,
    line => {
      run.lines.push(line);
      run.watchers.forEach(w => w.heard(line));
    },
    undefined,
    intro => {
      run.intro = intro;
      run.watchers.forEach(w => w.told(intro));
    },
  );
  run.result.catch(() => runs.delete(ask));
  runs.set(ask, run);
}

/**
 * The search for `ask`, as api.findProtocolLive: one started ahead (prefetchFinding) is joined, what it said already
 * handed over at once; else it starts now. Aborting leaves a search started ahead running: its answer is kept.
 */
export function findProtocol(ask: string, heard: (line: string) => void, signal: AbortSignal | undefined, told: (intro: ProtocolIntro) => void): Promise<FoundProtocol> {
  const run = runs.get(ask);
  if (!run) return api.findProtocolLive(ask, heard, signal, told);
  let live = true;
  const watcher = { heard: (line: string) => live && heard(line), told: (intro: ProtocolIntro) => live && told(intro) };
  run.lines.forEach(heard);
  if (run.intro) told(run.intro);
  run.watchers.push(watcher);
  signal?.addEventListener('abort', () => {
    live = false;
    run.watchers = run.watchers.filter(w => w !== watcher);
  });
  return run.result.then(found => {
    if (!live) throw new DOMException('Aborted', 'AbortError');
    return found;
  });
}
