import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import type { ConverseTurn } from '../../shared/ai.ts';
import { useBench } from '../screens/run/bench.ts';
import { quietly } from './applying.ts';
import { useChatLog, type Exchange } from './conversationLog.ts';
import { kitPhotos } from './library.ts';
import { useRun, type RunState } from './run.ts';
import { useSession } from './session.ts';

/**
 * Every conversation on this phone, one per experiment (ChatGPT's and Claude's history: many threads, not one): a
 * conversation becomes an experiment's when a protocol is opened or started in it, and keeps everything said and done
 * in that run, so it is the run's record too. New conversation starts a plain one (a question, a chat); the run under
 * way stays the phone's and keeps its own conversation, and the sidebar lists them all to go back to.
 *
 * Live, one conversation is on screen (useChatLog and useSession hold it: `active`) and one run is under way (useRun
 * holds it: `runThread`, the conversation it belongs to). They are the same unless New conversation set the run aside.
 * Every other conversation, and its run, waits here as it was left. Opening one from the sidebar swaps it in.
 */

export type Chat = { exchanges: Exchange[]; history: ConverseTurn[]; summary: string; thread: { id: string; replies: number } | null };
/** A run as kept: its photos come back from the kit (state/library.ts), and whether it is aside is the live one's. */
export type RunData = Omit<RunState, 'photos' | 'aside'>;
type BenchData = { lengths: Record<string, number>; paused: Record<string, number>; announced: Record<string, number> };
export type Thread = {
  id: string;
  createdAt: number;
  updatedAt: number;
  /** The experiment's run, once the conversation became one; null for a plain conversation. */
  run: RunData | null;
  bench?: BenchData;
  chat: Chat;
};
type Threads = { threads: Thread[]; active: string | null; runThread: string | null };

/** Kept on the phone: the oldest conversations go first beyond this. */
const KEEP = 40;
const EMPTY_CHAT: Chat = { exchanges: [], history: [], summary: '', thread: null };

const storage: StateStorage = {
  getItem: name => {
    try {
      return localStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem: (name, value) => {
    try {
      localStorage.setItem(name, value);
    } catch {
      // A full phone keeps the conversations it had.
    }
  },
  removeItem: name => {
    try {
      localStorage.removeItem(name);
    } catch {
      // Nothing to remove.
    }
  },
};

export const useThreads = create<Threads>()(
  persist(() => ({ threads: [], active: null, runThread: null }) as Threads, { name: 'chapp.threads', storage: createJSONStorage(() => storage) }),
);

let made = 0;
const newId = () => `c-${Date.now().toString(36)}-${(made++).toString(36)}`;
const find = (id: string | null) => (id ? useThreads.getState().threads.find(t => t.id === id) ?? null : null);

function liveChat(): Chat {
  const s = useSession.getState();
  return structuredClone({ exchanges: useChatLog.getState().exchanges.filter(e => e.phase !== 'thinking'), history: s.history, summary: s.summary, thread: s.thread });
}

function liveRun(): RunData | null {
  const { photos: _photos, aside: _aside, ...run } = useRun.getState();
  if (!run.protocolId) return null;
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(run)) if (typeof v !== 'function') data[k] = v;
  return structuredClone(data) as RunData;
}

function liveBench(): BenchData {
  const b = useBench.getState();
  return structuredClone({ lengths: b.lengths, paused: b.paused, announced: b.announced });
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Writes what is live into its conversations, so a swap or a reload loses nothing. */
function save() {
  const { active, runThread } = useThreads.getState();
  const now = Date.now();
  const chat = active ? liveChat() : null;
  const run = runThread ? liveRun() : null;
  const bench = runThread ? liveBench() : null;
  useThreads.setState(s => ({
    threads: s.threads.map(t => {
      let next = t;
      if (t.id === active && chat && !sameJson(t.chat, chat)) next = { ...next, chat, updatedAt: now };
      if (t.id === runThread && run && (!sameJson(t.run, run) || !sameJson(t.bench, bench))) next = { ...next, run, bench: bench ?? undefined, updatedAt: now };
      return next;
    }),
  }));
}

/** The oldest conversations beyond KEEP, and plain ones nothing was said in, go; the live ones stay. */
function prune(threads: Thread[], keep: (string | null)[]): Thread[] {
  const live = new Set(keep.filter(Boolean));
  const kept = threads.filter(t => live.has(t.id) || t.run || t.chat.exchanges.length > 0);
  const old = kept.filter(t => !live.has(t.id)).sort((a, b) => b.updatedAt - a.updatedAt).slice(KEEP);
  return kept.filter(t => !old.includes(t));
}

function showChat(chat: Chat) {
  // A new generation ends any answer still coming and empties the log (state/conversationLog.ts); then this one's.
  useSession.setState(s => ({ history: chat.history, summary: chat.summary, thread: chat.thread, exchange: null, heard: '', interim: '', generation: s.generation + 1 }));
  useChatLog.setState({ exchanges: structuredClone(chat.exchanges) });
}

function showRun(t: Thread) {
  const run = t.run!;
  useRun.setState({ ...structuredClone(run), photos: run.protocolId ? kitPhotos(run.protocolId) : {}, aside: false });
  useBench.getState().clear();
  if (t.bench) useBench.setState(structuredClone(t.bench));
}

const setAside = () => {
  const { active, runThread } = useThreads.getState();
  useRun.getState().setAside(runThread !== null && runThread !== active);
};

/** The conversations as they stand, from before this phone kept more than one: the live one, and the run set aside in its own. */
export function startThreads() {
  const s = useThreads.getState();
  if (s.active && find(s.active)) return;
  const now = Date.now();
  const run = useRun.getState();
  const chat: Thread = { id: newId(), createdAt: now, updatedAt: now, run: null, chat: liveChat() };
  const threads = [chat];
  let runThread: string | null = null;
  if (run.protocolId && !run.aside) runThread = chat.id;
  else if (run.protocolId) {
    const kept: Thread = { id: newId(), createdAt: now, updatedAt: now, run: liveRun(), bench: liveBench(), chat: EMPTY_CHAT };
    threads.push(kept);
    runThread = kept.id;
  }
  useThreads.setState({ threads, active: chat.id, runThread });
  save();
}

/** New conversation: a plain one, on screen; the run under way keeps its own and waits aside. */
export function newConversation() {
  startThreads();
  save();
  const { active, runThread, threads } = useThreads.getState();
  const now = Date.now();
  const empty = find(active);
  const reuse = empty && active !== runThread && empty.chat.exchanges.length === 0 && !empty.run;
  const id = reuse ? active! : newId();
  useThreads.setState({
    threads: prune(reuse ? threads : [...threads, { id, createdAt: now, updatedAt: now, run: null, chat: EMPTY_CHAT }], [id, runThread]),
    active: id,
  });
  quietly(() => {
    showChat(EMPTY_CHAT);
    setAside();
  });
}

/** Back to a conversation from the sidebar: its words on screen, and its run under way when it is an experiment. */
export function openThread(id: string) {
  startThreads();
  const t = find(id);
  if (!t) return;
  const { active, runThread } = useThreads.getState();
  const experiment = Boolean(t.run) || id === runThread;
  if (id === active && (!experiment || id === runThread)) return;
  save();
  const saved = find(id)!;
  quietly(() => {
    if (experiment && runThread !== id && saved.run) {
      showRun(saved);
      useThreads.setState({ runThread: id });
    }
    if (active !== id) {
      showChat(saved.chat);
      useThreads.setState({ active: id });
    }
    setAside();
  });
  useThreads.setState(s => ({ threads: prune(s.threads, [s.active, s.runThread]) }));
}

/**
 * A protocol is opened as this conversation's experiment (src/state/assistantActions.ts, before the run is replaced).
 * A plain conversation becomes the experiment's, and a run set aside stays in its own. When this conversation was
 * already another experiment's, that one is kept as it is (its run, and what was said up to now) and the
 * conversation goes on as the new one's.
 */
export function adoptIntoConversation() {
  startThreads();
  save();
  const { active, runThread } = useThreads.getState();
  if (!active) return;
  if (runThread === active && useRun.getState().protocolId) {
    const now = Date.now();
    const id = newId();
    useThreads.setState(s => ({
      threads: prune([...s.threads, { id, createdAt: now, updatedAt: now, run: null, chat: liveChat() }], [id]),
      active: id,
      runThread: id,
    }));
    return;
  }
  useThreads.setState({ runThread: active });
}

/** Whether the run under way belongs to the conversation on screen (else New conversation set it aside). */
export const runIsOnScreen = () => {
  const { active, runThread } = useThreads.getState();
  return runThread !== null && runThread === active;
};

/** A line of what was done by hand, into the run's own conversation while another is on screen. */
export function addToRunConversation(change: (exchanges: Exchange[]) => Exchange[]) {
  const { runThread } = useThreads.getState();
  if (!runThread) return;
  useThreads.setState(s => ({
    threads: s.threads.map(t => (t.id === runThread ? { ...t, updatedAt: Date.now(), chat: { ...t.chat, exchanges: change(t.chat.exchanges) } } : t)),
  }));
}

/** Keeps the waiting copies current (the sidebar's order and titles), now and then rather than on every change. */
export function saveThreads() {
  if (useThreads.getState().active) save();
}
