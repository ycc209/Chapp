import { create } from 'zustand';
import type { ConverseTurn, Expression } from '../../shared/ai.ts';

/**
 * What is happening right now, not kept across reloads: whether Chapp is listening, what it has heard so far, its
 * face and the line under its name.
 *
 * voice: idle, nothing open · listening, one thing said by tap (sent when the user stops) · talking, back-and-forth
 * conversation (hold Tap to speak and slide up), until the user ends it.
 */
export type Voice = 'idle' | 'listening' | 'talking';

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
  setVoice: (voice: Voice) => void;
  setHeard: (heard: string, interim?: string) => void;
  setExpression: (expression: Expression) => void;
  setStatus: (status: string) => void;
  setExchange: (exchange: Exchange | null) => void;
  addTurns: (...turns: ConverseTurn[]) => void;
  /** A new conversation: no history, nothing said. */
  newConversation: () => void;
};

export type Exchange = { ask: string; say: string; query?: string };

// Turns kept: enough for the last few questions and answers.
const HISTORY = 8;

export const useSession = create<Session>()(set => ({
  voice: 'idle',
  heard: '',
  interim: '',
  expression: 'neutral',
  status: '',
  exchange: null,
  history: [],
  setVoice: voice => set({ voice }),
  setHeard: (heard, interim = '') => set({ heard, interim }),
  setExpression: expression => set({ expression }),
  setStatus: status => set({ status }),
  setExchange: exchange => set({ exchange }),
  addTurns: (...turns) => set(s => ({ history: [...s.history, ...turns].slice(-HISTORY) })),
  newConversation: () => set({ history: [], exchange: null, heard: '', interim: '' }),
}));
