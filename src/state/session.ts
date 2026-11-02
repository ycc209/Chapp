import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ConverseTurn, Expression } from '../../shared/ai.ts';

/**
 * What is happening right now, not kept across reloads: whether Chapp is listening, what it has heard so far, its
 * face and the line under its name.
 *
 * voice: idle, nothing open · listening, one thing said by tap (sent when the user stops) · holding, Tap to speak held
 * down (sent when it is let go, unless slid up to cancel) · talking, back-and-forth conversation (Chapp's conversation
 * mode, gloves on), until the user ends it.
 */
export type Voice = 'idle' | 'listening' | 'holding' | 'talking';

type Session = {
  voice: Voice;
  /** What the user has said so far in this turn, settled words only. */
  heard: string;
  /** Words still being recognized after `heard`; the Listening screen shows them in grey. */
  interim: string;
  expression: Expression;
  /** The line under Chapp's name: "Listening", "Looking for the manual…". Empty shows the name alone. */
  status: string;
  /**
   * The last thing the user asked and Chapp's answer; the next screen (e.g. Overview) shows what was said. `query` is
   * the kit Chapp chose to look up (a findProtocol action), which the Overview searches for instead of the words.
   */
  exchange: Exchange | null;
  /** This conversation's turns, oldest first, the last few of which go with each question. New conversation clears it. */
  history: ConverseTurn[];
  summary: string;
  /** Changes only when the user explicitly starts a new conversation. */
  generation: number;
  /**
   * Meta's copy of this conversation: the last reply's id, sent with the next question so only the new words go and
   * Chapp's reasoning carries on. Only a local-only exchange clears it, because Meta has not seen that exchange.
   */
  thread: { id: string; replies: number } | null;
  setVoice: (voice: Voice) => void;
  setHeard: (heard: string, interim?: string) => void;
  setExpression: (expression: Expression) => void;
  setStatus: (status: string) => void;
  setExchange: (exchange: Exchange | null) => void;
  addTurns: (...turns: ConverseTurn[]) => void;
  /** The same for a question Meta answered: the next question continues from its reply. */
  answered: (responseId: string | undefined, ...turns: ConverseTurn[]) => void;
  /** A new conversation: no history, nothing said. */
  newConversation: () => void;
};

export type Exchange = { ask: string; say: string; query?: string };

// Turns kept: enough for the last few questions and answers.
const HISTORY = 64;
const EXCERPTS = 'Earlier conversation excerpts (verbatim; may begin partway through a turn):\n';

function rememberTurns(state: Pick<Session, 'history' | 'summary'>, turns: ConverseTurn[]) {
  const all = [...state.history, ...turns];
  const removed = all.slice(0, Math.max(0, all.length - HISTORY));
  const older = [state.summary.replace(EXCERPTS, ''), ...removed.map(t => `${t.role}: ${t.text}`)].filter(Boolean).join('\n\n');
  return { history: all.slice(-HISTORY), summary: older ? EXCERPTS + older.slice(-(24_000 - EXCERPTS.length)) : '' };
}

export const useSession = create<Session>()(persist(set => ({
  voice: 'idle',
  heard: '',
  interim: '',
  expression: 'neutral',
  status: '',
  exchange: null,
  history: [],
  summary: '',
  generation: 0,
  thread: null,
  setVoice: voice => set({ voice }),
  setHeard: (heard, interim = '') => set({ heard, interim }),
  setExpression: expression => set({ expression }),
  setStatus: status => set({ status }),
  setExchange: exchange => set({ exchange }),
  addTurns: (...turns) => set(s => ({ ...rememberTurns(s, turns), thread: null })),
  answered: (responseId, ...turns) =>
    set(s => {
      const replies = (s.thread?.replies ?? 0) + 1;
      return { ...rememberTurns(s, turns), thread: responseId ? { id: responseId, replies } : null };
    }),
  newConversation: () => set(s => ({ history: [], summary: '', thread: null, exchange: null, heard: '', interim: '', generation: s.generation + 1 })),
}), { name: 'chapp.conversation', partialize: s => ({ history: s.history, summary: s.summary, thread: s.thread, exchange: s.exchange, generation: s.generation }) }));
