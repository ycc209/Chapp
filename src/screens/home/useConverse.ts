import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import type { A2uiMessage } from '../../../shared/a2ui.ts';
import type { Action, ConverseContext, ConverseReply } from '../../../shared/ai.ts';
import type { Protocol } from '../../../shared/protocol.ts';
import { api } from '../../api/client.ts';
import { benchSteps } from '../../components/lab/model.ts';
import { applyActions } from '../../state/actions.ts';
import { useProtocol } from '../../state/protocol.ts';
import { useRun } from '../../state/run.ts';
import { useSession } from '../../state/session.ts';
import { useShown } from '../../state/shown.ts';
import { useBench } from '../run/bench.ts';
import { matchCommand } from '../../voice/commands.ts';
import { speak } from '../../voice/speak.ts';

/** One exchange with Chapp: what the user said, then Chapp thinking, then its answer (or a failure). */
export type Turn =
  | { id: number; text: string; phase: 'thinking' }
  | { id: number; text: string; phase: 'reply'; say: string; a2ui?: A2uiMessage[]; confirm?: Action[] }
  | { id: number; text: string; phase: 'error' };

// After Chapp has finished speaking, how long its face keeps the reply's expression before going back to neutral.
const SETTLE_MS = 2500;

/**
 * Sends what the user said or typed to Chapp and plays the answer: Chapp's face and the line under its name while it
 * thinks, then the reply shown, read aloud and its actions applied (a new utterance cancels the one in flight).
 * The bench's everyday commands ("next", "12 samples", "make it triplicates") are answered on the phone first, with
 * no call to the server.
 */
export function useConverse(screen: string) {
  const navigate = useNavigate();
  // For the step's title in what Chapp is told (the same document every screen of the run has loaded).
  const { protocol } = useProtocol(useRun(s => s.protocolId));
  const protocolRef = useRef(protocol);
  useEffect(() => {
    protocolRef.current = protocol;
  });
  const [turn, setTurn] = useState<Turn | null>(null);
  const latest = useRef(0);
  const inflight = useRef<AbortController | null>(null);

  // Leaving the screen mid-question: drop it, and don't leave Chapp stuck thinking on the next screen.
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

  // Back to neutral after a while, unless another turn or another screen has changed Chapp's face since.
  const settle = (id: number, face: string, ms: number) =>
    setTimeout(() => {
      const session = useSession.getState();
      if (id === latest.current && session.expression === face) session.setExpression('neutral');
    }, ms);

  const send = useCallback(
    async (said: string) => {
      const text = said.trim();
      if (!text) return;
      const id = ++latest.current;
      inflight.current?.abort();
      const session = useSession.getState();
      session.setHeard('');

      const command = matchCommand(text);
      if (command) {
        const say = acknowledge(command);
        session.setStatus('');
        session.setExpression('happy');
        setTurn({ id, text, phase: 'reply', say });
        session.addTurns({ role: 'user', text }, { role: 'chapp', text: say });
        applyActions(command, navigate);
        await speak(say).catch(() => {});
        settle(id, 'happy', SETTLE_MS);
        return;
      }

      const abort = (inflight.current = new AbortController());
      session.setExpression('thinking');
      session.setStatus('Thinking');
      setTurn({ id, text, phase: 'thinking' });

      let reply: ConverseReply;
      try {
        reply = await api.converse({ text, context: converseContext(screen, protocolRef.current), history: session.history, previousResponseId: session.thread?.id }, abort.signal);
      } catch {
        if (id !== latest.current) return;
        session.setStatus('');
        session.setExpression('sad');
        setTurn({ id, text, phase: 'error' });
        settle(id, 'sad', 4000);
        return;
      }
      if (id !== latest.current) return;

      const face = reply.expression ?? 'neutral';
      session.setStatus('');
      session.setExpression(face);
      session.setExchange({ ask: text, say: reply.say });
      session.answered(reply.responseId, { role: 'user', text }, { role: 'chapp', text: reply.say });
      if (reply.a2ui) useShown.getState().clear();
      setTurn({ id, text, phase: 'reply', say: reply.say, ...(reply.a2ui ? { a2ui: reply.a2ui } : {}), ...(reply.confirm ? { confirm: reply.confirm } : {}) });
      applyActions(reply.actions, navigate, protocolRef.current);
      if (reply.say) await speak(reply.say).catch(() => {});
      settle(id, face, SETTLE_MS);
    },
    [navigate, screen],
  );

  /** Clears the exchange (a new conversation). */
  const reset = useCallback(() => {
    latest.current++;
    inflight.current?.abort();
    setTurn(null);
    const session = useSession.getState();
    if (session.status === 'Thinking') session.setStatus('');
    session.setExpression('neutral');
  }, []);

  /**
   * The sidebar's New conversation: nothing said yet, no history, and the run set aside, so Chapp on Home stops
   * assuming the last kit (it stays in the sidebar to go back to).
   */
  const newConversation = useCallback(() => {
    reset();
    useSession.getState().newConversation();
    if (useRun.getState().protocolId) useRun.getState().setAside(true);
  }, [reset]);

  return { turn, send, reset, newConversation };
}

/**
 * What Chapp is told with each thing said (ConverseContext): the screen and the run as it stands, so it can answer
 * about the plan, the step, the timers and the readings (on Home only while the run is the conversation's). The step goes along once the run has started (or on the run
 * screen), with its title as the run screen shows it; `at` overrides any of it (the run screen's own step).
 */
export function converseContext(screen: string, protocol: Protocol | null, at: Partial<ConverseContext> = {}): ConverseContext {
  const run = useRun.getState();
  // On Home or in the conversation with no kit yet, or after New conversation set the run aside: nothing to assume.
  if ((screen === 'home' || screen === 'chat') && (!run.protocolId || run.aside)) return { screen, ...at };
  const now = Date.now();
  const timers = Object.entries(run.timers).map(([id, ends]) => ({ id, secondsLeft: Math.max(0, Math.round((ends - now) / 1000)) }));
  const step = at.step ?? run.step;
  const started = screen === 'run' || step > 0 || Object.values(run.done).some(Boolean);
  let stepTitle: string | undefined;
  try {
    stepTitle = protocol && protocol.id === run.protocolId ? benchSteps(protocol, run.procedure)[step]?.title : undefined;
  } catch {
    // A procedure the protocol does not have: no title.
  }
  const lengths = useBench.getState().lengths;
  const shown = useShown.getState().plan;
  return {
    screen,
    protocolId: run.protocolId,
    procedure: run.procedure,
    ...(started ? { step, ...(stepTitle ? { stepTitle } : {}) } : {}),
    samples: run.samples,
    replicates: run.replicates,
    standardReplicates: run.standardReplicates,
    standards: run.standards,
    ...(timers.length ? { timers } : {}),
    readingsFrom: run.readingsFrom,
    ...(Object.keys(lengths).length ? { lengths } : {}),
    ...(Object.keys(run.edits.moved).length || run.edits.added.length ? { edits: run.edits } : {}),
    ...(shown && (shown.samples !== run.samples || shown.replicates !== run.replicates) ? { shown } : {}),
    ...at,
  };
}

const REPLICATES = ['', 'Once each.', 'In duplicate.', 'In triplicate.'];

/** A word back for a command handled on the phone: shown and read aloud, so the user knows it was heard. */
export function acknowledge(actions: Action[]): string {
  return actions
    .map(action => {
      switch (action.type) {
        case 'setSamples': return `${action.samples} sample${action.samples === 1 ? '' : 's'}.`;
        case 'setReplicates': return REPLICATES[action.replicates] ?? `${action.replicates} replicates.`;
        case 'nextStep': return 'Next step.';
        case 'previousStep': return 'Back one step.';
        case 'markDone': return 'Done.';
        case 'startTimer': return 'Timer started.';
        case 'setStepTime': return 'Changed for this run.';
        case 'redo': return `${action.id} again.`;
        case 'moveWell': return `${action.from} moved.`;
        case 'addWell':
        case 'addCondition':
          return 'Added.';
        case 'navigate': return 'Okay.';
        case 'findProtocol': return 'Looking it up.';
      }
    })
    .join(' ');
}
