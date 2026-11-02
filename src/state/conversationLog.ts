import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Action, FoundProtocol, Source } from '../../shared/ai.ts';
import type { A2uiMessage } from '../../shared/a2ui.ts';
import { useSession } from './session.ts';
import { useShown } from './shown.ts';

export type Go = { to: string; label: string };
export type Find = { query: string; progress: string[]; state: 'searching' | 'found' | 'notFound' | 'failed'; found?: FoundProtocol };
export type Exchange = {
  id: number; ask: string; phase: 'thinking' | 'reply' | 'error'; say: string; done: string[]; go: Go[];
  protocolPreviewId?: string;
  sources?: Source[]; progress?: string; a2ui?: A2uiMessage[]; confirm?: Action[]; find?: Find;
  /** Chapp was asked to start: the start card (the plan, Start or change it) for this protocol, under the answer. */
  start?: { protocolId: string };
  /** Not a turn: what the user did by hand on the run, its lines in `done` (src/state/runEvents.ts). */
  event?: boolean;
};
type Log = { exchanges: Exchange[]; set: (id: number, change: Partial<Exchange> | ((e: Exchange) => Partial<Exchange>)) => void; add: (e: Exchange) => void; clear: () => void };

/** All screens contribute to one visible conversation; only completed turns survive a reload. */
export const useChatLog = create<Log>()(persist(set => ({
  exchanges: [],
  add: e => set(s => ({ exchanges: [...s.exchanges, e] })),
  set: (id, change) => set(s => ({ exchanges: s.exchanges.map(e => e.id === id ? { ...e, ...(typeof change === 'function' ? change(e) : change) } : e) })),
  clear: () => set({ exchanges: [] }),
}), { name: 'chapp.conversation.log', partialize: s => ({ exchanges: s.exchanges.filter(e => e.phase === 'reply') }) }));

useSession.subscribe((now, before) => {
  if (now.generation !== before.generation) {
    useChatLog.getState().clear();
    useShown.getState().clear();
  }
});
