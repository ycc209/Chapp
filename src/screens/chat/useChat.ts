import { useCallback, useEffect, useRef } from 'react';
import { create } from 'zustand';
import type { A2uiMessage } from '../../../shared/a2ui.ts';
import type { Action, ConverseReply, FoundProtocol } from '../../../shared/ai.ts';
import type { Protocol } from '../../../shared/protocol.ts';
import { api } from '../../api/client.ts';
import { benchSteps, lengthText } from '../../components/lab/model.ts';
import { procedureFor } from '../protocol/content.ts';
import { applyActions } from '../../state/actions.ts';
import { useProtocol } from '../../state/protocol.ts';
import { useRun } from '../../state/run.ts';
import { useSession } from '../../state/session.ts';
import { useShown } from '../../state/shown.ts';
import { matchCommand } from '../../voice/commands.ts';
import { acknowledge, converseContext } from '../home/useConverse.ts';

/** A screen a reply wants to show: a button to go there, the conversation stays open until it is pressed. */
export type Go = { to: string; label: string };

/** A kit's manual looked up from the conversation: what Chapp said while searching, then what it found. */
export type Find = { query: string; progress: string[]; state: 'searching' | 'found' | 'notFound' | 'failed'; found?: FoundProtocol };

/** One exchange: what the user said, and Chapp's answer with what it changed, what it shows and where it points. */
export type Exchange = {
  id: number;
  ask: string;
  phase: 'thinking' | 'reply' | 'error';
  say: string;
  /** Changes made to the run, one short line each ("Samples: 12"). */
  done: string[];
  /** What Chapp drew under its answer (A2UI v0.9). */
  a2ui?: A2uiMessage[];
  /** Changes waiting for the user's tap: a step's new length, or what the words did not plainly ask for. */
  confirm?: Action[];
  go: Go[];
  find?: Find;
};

/** What the screens are called on the buttons that go to them. */
export const GO_LABELS: Record<string, string> = {
  '/': 'Home',
  '/protocol': 'Open the protocol',
  '/kit': 'Your kit',
  '/plan': 'Open the plan',
  '/results': 'See the results',
  '/share': 'Share',
  '/import': 'Scan a QR code',
  '/library': 'Library',
};

/**
 * The line that says what an action changed, read from the run after it was applied, so it shows what the screens
 * now show: "Samples: 12", "Step 3 of 6 · Load the plate", "Timer started · 30 min". Null for what is not a change
 * to the run (going somewhere, looking up a kit).
 */
export function doneLine(action: Action, protocol: Protocol | null): string | null {
  const run = useRun.getState();
  switch (action.type) {
    case 'setSamples': return `Samples: ${action.samples}`;
    case 'setReplicates': return `Replicates: ×${action.replicates}, standards too`;
    case 'nextStep':
    case 'previousStep': {
      let steps: { title: string }[] = [];
      try {
        steps = protocol && protocol.id === run.protocolId ? benchSteps(protocol, run.procedure) : [];
      } catch {
        // A procedure the protocol does not have: just the number.
      }
      const at = Math.min(run.step, Math.max(0, steps.length - 1));
      return steps.length ? `Step ${at + 1} of ${steps.length} · ${steps[at]!.title}` : action.type === 'nextStep' ? 'Next step' : 'Back one step';
    }
    case 'markDone': return `${action.id} is done`;
    case 'startTimer': return `Timer started · ${lengthText(action.seconds)}`;
    case 'setStepTime': {
      let n = -1;
      try {
        n = protocol ? procedureFor(protocol, run.procedure).steps.filter(s => s.stage !== 'analyze').findIndex(s => s.id === action.id) : -1;
      } catch {
        // A procedure the protocol does not have: no number.
      }
      return `${n >= 0 ? `Step ${n + 1}` : 'That step'} · ${lengthText(action.seconds)} for this run`;
    }
    // The bench's changes say what to do in their own line (applyActions).
    case 'redo':
    case 'moveWell':
    case 'addWell':
    case 'addCondition':
    case 'navigate':
    case 'findProtocol':
      return null;
  }
}

type Log = { exchanges: Exchange[]; set: (id: number, change: Partial<Exchange> | ((e: Exchange) => Partial<Exchange>)) => void; add: (e: Exchange) => void; clear: () => void };

/** The conversation so far, kept while the app is open: closing it and tapping Chapp again goes on where it was. */
export const useChatLog = create<Log>()(set => ({
  exchanges: [],
  add: e => set(s => ({ exchanges: [...s.exchanges, e] })),
  set: (id, change) => set(s => ({ exchanges: s.exchanges.map(e => (e.id === id ? { ...e, ...(typeof change === 'function' ? change(e) : change) } : e)) })),
  clear: () => set({ exchanges: [] }),
}));

// The sidebar's New conversation clears the history: the conversation starts over too.
useSession.subscribe((now, before) => {
  if (before.history.length && !now.history.length) {
    useChatLog.getState().clear();
    useShown.getState().clear();
  }
});

let seq = 0;
// After an answer, how long Chapp keeps its face before going back to neutral.
const SETTLE_MS = 2500;

/**
 * Chapp's conversation mode (/chat): whatever the user says or types is answered in place. The bench's commands are
 * handled on the phone; anything else goes to Chapp with the run (converseContext 'chat') and the conversation so far.
 * Changes to the run are applied with a line saying so, a screen to go to becomes a button, and a kit to look up is
 * searched for right here, its progress streamed in (api.findProtocolLive). Chapp never speaks: everything is shown.
 */
export function useChat() {
  const { protocol } = useProtocol(useRun(s => s.protocolId));
  const protocolRef = useRef(protocol);
  useEffect(() => {
    protocolRef.current = protocol;
  });
  const inflight = useRef(new Set<AbortController>());
  const latest = useRef(0);

  // Leaving the conversation stops what is still on its way, and does not leave Chapp thinking on the next screen.
  useEffect(
    () => () => {
      for (const c of inflight.current) c.abort();
      inflight.current.clear();
      const session = useSession.getState();
      if (session.status) session.setStatus('');
      session.setExpression('neutral');
    },
    [],
  );

  const settle = (id: number, face: string) =>
    setTimeout(() => {
      const session = useSession.getState();
      if (id === latest.current && session.expression === face) session.setExpression('neutral');
    }, SETTLE_MS);

  const find = useCallback(async (id: number, query: string) => {
    const log = useChatLog.getState();
    const session = useSession.getState();
    const abort = new AbortController();
    inflight.current.add(abort);
    log.set(id, { find: { query, progress: [], state: 'searching' } });
    session.setStatus('Searching the web');
    session.setExpression('thinking');
    const update = (change: (f: Find) => Partial<Find>) => useChatLog.getState().set(id, e => (e.find ? { find: { ...e.find, ...change(e.find) } } : {}));
    try {
      const found = await api.findProtocolLive(query, line => update(f => ({ progress: [...f.progress, line] })), abort.signal);
      update(() => ({ state: found.found ? 'found' : 'notFound', found, progress: found.progress }));
      // The manual found is the run's protocol from now on, as the Overview makes it.
      if (found.found && found.protocolId && found.protocolId !== useRun.getState().protocolId) useRun.getState().setProtocol(found.protocolId);
      session.setExpression(found.found ? 'happy' : 'sad');
      settle(id, found.found ? 'happy' : 'sad');
    } catch {
      if (abort.signal.aborted) return;
      update(() => ({ state: 'failed' }));
      session.setExpression('sad');
      settle(id, 'sad');
    } finally {
      inflight.current.delete(abort);
      if (useSession.getState().status === 'Searching the web') useSession.getState().setStatus('');
    }
  }, []);

  const send = useCallback(
    async (said: string) => {
      const text = said.trim();
      if (!text) return;
      const id = ++seq;
      latest.current = id;
      const log = useChatLog.getState();
      const session = useSession.getState();
      session.setHeard('');
      const blank: Exchange = { id, ask: text, phase: 'thinking', say: '', done: [], go: [] };

      // The bench's commands: answered here, at once.
      const command = matchCommand(text);
      if (command) {
        applyActions(command, () => {});
        log.add({ ...blank, phase: 'reply', say: acknowledge(command) });
        session.addTurns({ role: 'user', text }, { role: 'chapp', text: acknowledge(command) });
        session.setExpression('happy');
        settle(id, 'happy');
        return;
      }

      log.add(blank);
      session.setExpression('thinking');
      session.setStatus('Thinking');
      const abort = new AbortController();
      inflight.current.add(abort);
      let reply: ConverseReply;
      try {
        reply = await api.converse({ text, context: converseContext('chat', protocolRef.current), history: session.history, previousResponseId: session.thread?.id }, abort.signal);
      } catch {
        if (abort.signal.aborted) return;
        useChatLog.getState().set(id, { phase: 'error' });
        if (useSession.getState().status === 'Thinking') useSession.getState().setStatus('');
        session.setExpression('sad');
        settle(id, 'sad');
        return;
      } finally {
        inflight.current.delete(abort);
      }
      if (useSession.getState().status === 'Thinking') useSession.getState().setStatus('');

      // Changes to the run apply now, each with its line; going somewhere waits for the user; a kit is looked up here.
      const change = reply.actions.filter(a => a.type !== 'navigate' && a.type !== 'findProtocol');
      const lines = applyActions(change, () => {}, protocolRef.current);
      const done = [...change.map(a => doneLine(a, protocolRef.current)).filter((l): l is string => l !== null), ...lines];
      const go = reply.actions.flatMap(a => (a.type === 'navigate' && GO_LABELS[a.to] ? [{ to: a.to, label: GO_LABELS[a.to]! }] : []));
      const face = reply.expression ?? 'neutral';
      if (reply.a2ui) useShown.getState().clear();
      useChatLog.getState().set(id, { phase: 'reply', say: reply.say, done, ...(reply.a2ui ? { a2ui: reply.a2ui } : {}), ...(reply.confirm ? { confirm: reply.confirm } : {}), go });
      session.answered(reply.responseId, { role: 'user', text }, { role: 'chapp', text: reply.say });
      session.setExpression(face);
      settle(id, face);
      const lookUp = reply.actions.find((a): a is Extract<Action, { type: 'findProtocol' }> => a.type === 'findProtocol');
      if (lookUp) void find(id, lookUp.query);
    },
    [find],
  );

  return { send, protocol };
}
