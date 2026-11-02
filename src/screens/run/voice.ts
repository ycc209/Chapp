import { useCallback, type RefObject } from 'react';
import type { Action, ConverseContext, Source } from '../../../shared/ai.ts';
import type { Protocol } from '../../../shared/protocol.ts';
import { useConverse } from '../home/useConverse.ts';

export type Exchange =
  | { id: number; ask: string; phase: 'thinking'; say?: string; progress?: string }
  | { id: number; ask: string; phase: 'reply'; say: string; sources: Source[]; confirm?: Action[]; done?: string[]; command?: boolean }
  | { id: number; ask: string; phase: 'error'; error?: string };
export type Handled = { say: string; show?: boolean; ok?: boolean } | null;

/** Typed page operations. These are never parsed from the user's words. */
export type RunPageAction =
  | { type: 'advance' }
  | { type: 'timer'; what: 'start' | 'stop' | 'resume' | 'status' }
  | { type: 'length'; seconds: number }
  | { type: 'photo' } | { type: 'sample' } | { type: 'answer'; yes: boolean }
  | { type: 'done'; refs: string[] } | { type: 'redo'; refs: string[] }
  | { type: 'badWell'; wells: string[]; to: string | null } | { type: 'results' };
export type RunHandlers = {
  local: (command: RunPageAction, said: string) => Handled;
  command: (actions: Action[], said: string) => Handled;
  context: () => ConverseContext;
  protocol: () => Protocol | null;
};

/** Bench speech uses the same model context and receipt loop as the conversation screen. */
export function useRunVoice(handlers: RefObject<RunHandlers>) {
  const executePage = useCallback((action: Action) => {
    const h = handlers.current;
    let handled: Handled;
    let fallback: string;
    if (action.type === 'nextStep' || action.type === 'previousStep') {
      handled = h.command([action], '');
      fallback = action.type === 'nextStep' ? 'Advanced the run.' : 'Moved back in the run.';
    } else if (action.type === 'takePhoto') {
      handled = h.local({ type: 'photo' }, '');
      fallback = 'Opened the plate-reader camera; waiting for a photo.';
    } else if (action.type === 'useSample') {
      handled = h.local({ type: 'sample' }, '');
      fallback = 'Loaded the built-in example readings, not a real measurement.';
    } else if (action.type === 'answer') {
      handled = h.local({ type: 'answer', yes: action.yes }, '');
      fallback = action.yes ? 'Accepted the pending question.' : 'Declined the pending question.';
    } else return null;
    return handled ? { ok: handled.ok !== false, message: handled.say || fallback } : { ok: false, message: 'That action is not available on the current step.' };
  }, [handlers]);
  const { turn, send, reset } = useConverse('run', {
    context: () => handlers.current.context(),
    protocol: () => handlers.current.protocol(),
    executePage,
  });
  const exchange: Exchange | null = turn ? { ...turn, ask: turn.text } : null;
  return { exchange, send, clear: reset };
}
