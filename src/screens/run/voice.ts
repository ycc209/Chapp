import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { useNavigate } from 'react-router';
import type { Action, ConverseContext, Source } from '../../../shared/ai.ts';
import { api } from '../../api/client.ts';
import { applyActions } from '../../state/actions.ts';
import { useSession } from '../../state/session.ts';
import { matchCommand } from '../../voice/commands.ts';
import { speak } from '../../voice/speak.ts';
import { runCommand, spoken, type RunCommand } from './model.ts';

/** A question the user asked at the bench and Chapp's answer, with the pages of the manual it rests on. */
export type Exchange =
  | { id: number; ask: string; phase: 'thinking' }
  | { id: number; ask: string; phase: 'reply'; say: string; sources: Source[] }
  | { id: number; ask: string; phase: 'error' };

/** What the screen does with a command; null when it does not apply here (then it goes on to Chapp). */
export type Handled = { say: string } | null;

export type RunHandlers = {
  /** The run's own words: the timer, the incubation length, the photo, the sample export, yes or no, "done". */
  local: (command: RunCommand, said: string) => Handled;
  /** The bench commands every screen knows: next, back, "C is OK", the plan's numbers. */
  command: (actions: Action[], said: string) => Handled;
  context: () => ConverseContext;
};

// After Chapp has finished speaking, how long its face keeps the reply's expression.
const SETTLE_MS = 2500;

/**
 * What the user says (or types) on the run screen: the run's commands are answered on the phone, at once and read
 * aloud; anything else is a question for Chapp (POST /api/converse with the step on screen), whose answer is shown
 * with its sources, read aloud, and whose actions are applied. A new utterance cancels the question in flight.
 */
export function useRunVoice(handlers: RefObject<RunHandlers>) {
  const navigate = useNavigate();
  const [exchange, setExchange] = useState<Exchange | null>(null);
  const latest = useRef(0);
  const inflight = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      latest.current++;
      inflight.current?.abort();
      const session = useSession.getState();
      if (session.status === 'Thinking') {
        session.setStatus('');
        session.setExpression('neutral');
      }
    },
    [],
  );

  const settle = (id: number, face: string) =>
    setTimeout(() => {
      const session = useSession.getState();
      if (id === latest.current && session.expression === face) session.setExpression('neutral');
    }, SETTLE_MS);

  const send = useCallback(
    async (said: string) => {
      const text = said.trim();
      if (!text) return;
      const id = ++latest.current;
      inflight.current?.abort();
      const session = useSession.getState();
      session.setHeard('');
      const h = handlers.current;

      const local = runCommand(text);
      const actions = matchCommand(text);
      const handled = (local && h.local(local, text)) || (actions && h.command(actions, text)) || null;
      if (handled) {
        setExchange(null);
        session.setStatus('');
        session.setExpression('happy');
        if (handled.say) await speak(spoken(handled.say)).catch(() => {});
        settle(id, 'happy');
        return;
      }

      const abort = (inflight.current = new AbortController());
      setExchange({ id, ask: text, phase: 'thinking' });
      session.setExpression('thinking');
      session.setStatus('Thinking');
      try {
        const reply = await api.converse({ text, context: h.context() }, abort.signal);
        if (id !== latest.current) return;
        const face = reply.expression ?? 'neutral';
        session.setStatus('');
        session.setExpression(face);
        session.setExchange({ ask: text, say: reply.say });
        setExchange({ id, ask: text, phase: 'reply', say: reply.say, sources: reply.sources });
        applyActions(reply.actions, navigate);
        if (reply.say) await speak(spoken(reply.say)).catch(() => {});
        settle(id, face);
      } catch {
        if (id !== latest.current) return;
        session.setStatus('');
        session.setExpression('sad');
        setExchange({ id, ask: text, phase: 'error' });
        settle(id, 'sad');
      }
    },
    [handlers, navigate],
  );

  const clear = useCallback(() => {
    latest.current++;
    inflight.current?.abort();
    setExchange(null);
    const session = useSession.getState();
    if (session.status === 'Thinking') {
      session.setStatus('');
      session.setExpression('neutral');
    }
  }, []);

  return { exchange, send, clear };
}
