import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import type { A2uiMessage } from '../../../shared/a2ui.ts';
import type { Action, ConverseContext, Source } from '../../../shared/ai.ts';
import type { Protocol } from '../../../shared/protocol.ts';
import { benchSteps } from '../../components/lab/model.ts';
import { converse, speculate, type ConversationOptions } from '../../state/conversation.ts';
import { attachPreparer } from '../../voice/controller.ts';
import { useProtocol } from '../../state/protocol.ts';
import { useRun } from '../../state/run.ts';
import { useSession } from '../../state/session.ts';
import { useShown } from '../../state/shown.ts';
import { alarmName, runningTimers } from '../../state/alarms.ts';
import { useChatLog } from '../../state/conversationLog.ts';
import { newConversation as startNewConversation } from '../../state/threads.ts';
import { useBench } from '../run/bench.ts';

export type Turn =
  | { id: number; text: string; phase: 'thinking'; say?: string; progress?: string }
  | { id: number; text: string; phase: 'reply'; say: string; sources: Source[]; a2ui?: A2uiMessage[]; confirm?: Action[] }
  | { id: number; text: string; phase: 'error'; error?: string };

export type ConverseOptions = Partial<Pick<ConversationOptions, 'context' | 'protocol' | 'executePage'>>;

/** Every utterance uses the same conversation and tool-result loop, on every screen. */
export function useConverse(screen: string, options: ConverseOptions = {}) {
  const navigate = useNavigate();
  const { protocol } = useProtocol(useRun(s => s.protocolId));
  const current = useRef({ protocol, options, screen });
  current.current = { protocol, options, screen };
  const [turn, setTurn] = useState<Turn | null>(null);
  const latest = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  // Words that have settled before the user finishes start the conversation early (src/voice/controller.ts). Not for
  // the confirmation buttons' own hook, which no microphone feeds.
  useEffect(() => {
    if (screen === 'confirmation') return;
    return attachPreparer(text => speculate(text, {
      navigate,
      context: () => current.current.options.context?.() ?? converseContext(current.current.screen, current.current.protocol),
      protocol: () => current.current.options.protocol ? current.current.options.protocol() : current.current.protocol,
    }));
  }, [navigate, screen]);

  const send = useCallback(async (said: string) => {
    const text = said.trim();
    if (!text) return;
    const id = ++latest.current;
    setTurn({ id, text, phase: 'thinking' });
    const visible = () => mounted.current && latest.current === id;
    try {
      const reply = await converse(text, {
        navigate,
        context: () => current.current.options.context?.() ?? converseContext(current.current.screen, current.current.protocol),
        protocol: () => current.current.options.protocol ? current.current.options.protocol() : current.current.protocol,
        executePage: action => mounted.current ? current.current.options.executePage?.(action) ?? null : null,
        onText: say => { if (visible()) setTurn({ id, text, phase: 'thinking', say }); },
        onProgress: progress => { if (visible()) setTurn(t => t?.id === id && t.phase === 'thinking' ? { ...t, progress } : t); },
      });
      if (visible()) setTurn({ id, text, phase: 'reply', say: reply.say, sources: reply.sources, a2ui: reply.a2ui, confirm: reply.confirm });
    } catch (error) {
      if (visible()) setTurn({ id, text, phase: 'error', error: error instanceof Error ? error.message : undefined });
    }
  }, [navigate]);

  const reset = useCallback(() => { latest.current++; setTurn(null); }, []);
  const newConversation = useCallback(() => {
    reset();
    startNewConversation();
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
  // On Home or in the conversation with no kit yet, or after New conversation set the run aside: nothing to assume,
  // but the timers running anywhere ("how long is left on the BCA?").
  if ((screen === 'home' || screen === 'chat') && (!run.protocolId || run.aside)) return { screen, ...elsewhere(false), ...at };
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
  const paused = Object.entries(useBench.getState().paused).map(([id, secondsLeft]) => ({ id, secondsLeft }));
  const shown = useShown.getState().plan;
  // The start card is waiting while it is the last thing Chapp showed and the run has not been started since.
  const lastShown = useChatLog.getState().exchanges.filter(e => e.phase !== 'thinking' && !e.event).at(-1);
  const startCard = lastShown?.start?.protocolId === run.protocolId && !run.begun;
  return {
    screen,
    protocolId: run.protocolId,
    procedure: run.procedure,
    ...(run.planned ? { planned: true } : {}),
    ...elsewhere(true),
    ...(startCard ? { startCard: true } : {}),
    ...(started ? { step, ...(stepTitle ? { stepTitle } : {}) } : {}),
    samples: run.samples,
    replicates: run.replicates,
    standardReplicates: run.standardReplicates,
    standards: run.standards,
    ...(timers.length ? { timers } : {}),
    ...(paused.length ? { paused } : {}),
    readingsFrom: run.readingsFrom,
    done: run.done,
    readings: run.readings,
    ...(Object.keys(lengths).length ? { lengths } : {}),
    ...(Object.keys(run.edits.moved).length || run.edits.added.length ? { edits: run.edits } : {}),
    ...(shown && (shown.samples !== run.samples || shown.replicates !== run.replicates || (shown.standardReplicates !== undefined && shown.standardReplicates !== run.standardReplicates)) ? { shown } : {}),
    ...at,
  };
}

/** Timers running in other experiments (state/alarms.ts), and the run's own too when it is not the one in context. */
function elsewhere(liveInContext: boolean): Pick<ConverseContext, 'elsewhere'> {
  const now = Date.now();
  const list = runningTimers()
    .filter(a => !(liveInContext && a.live))
    .slice(0, 8)
    .map(a => ({ experiment: alarmName(a), step: a.stepId, secondsLeft: Math.max(0, Math.round((a.endsAt - now) / 1000)) }));
  return list.length ? { elsewhere: list } : {};
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
