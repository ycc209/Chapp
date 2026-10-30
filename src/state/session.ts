import { create } from 'zustand';
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
  /**
   * Meta's copy of this conversation: the last reply's id, sent with the next question so only the new words go and
   * Chapp's reasoning carries on. Dropped after a few replies, and by a turn answered on the phone (Meta has not seen
   * it): the next question then goes with `history` instead.
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
const HISTORY = 8;
// Replies Meta's copy runs to before the next question starts afresh from `history`, so it does not grow all day.
const THREAD = 8;

export const useSession = create<Session>()(set => ({
  voice: 'idle',
  heard: '',
  interim: '',
  expression: 'neutral',
  status: '',
  exchange: null,
  history: [],
  thread: null,
  setVoice: voice => set({ voice }),
  setHeard: (heard, interim = '') => set({ heard, interim }),
  setExpression: expression => set({ expression }),
  setStatus: status => set({ status }),
  setExchange: exchange => set({ exchange }),
  addTurns: (...turns) => set(s => ({ history: [...s.history, ...turns].slice(-HISTORY), thread: null })),
  answered: (responseId, ...turns) =>
    set(s => {
      const replies = (s.thread?.replies ?? 0) + 1;
      return { history: [...s.history, ...turns].slice(-HISTORY), thread: responseId && replies < THREAD ? { id: responseId, replies } : null };
    }),
  newConversation: () => set({ history: [], thread: null, exchange: null, heard: '', interim: '' }),
}));
