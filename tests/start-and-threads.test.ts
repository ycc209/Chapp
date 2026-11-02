import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { startWhenAsked } from '../server/ai/authorize.ts';
import { confirmation } from '../server/ai/confirm.ts';
import { actionFromArguments } from '../server/ai/conversationTools.ts';
import { START_CARD, type ConverseContext } from '../shared/ai.ts';
import { Protocol } from '../shared/protocol.ts';
import { useBench } from '../src/screens/run/bench.ts';
import { executeAssistantAction, resetAssistantActions, type AssistantActionOptions } from '../src/state/assistantActions.ts';
import { useChatLog } from '../src/state/conversationLog.ts';
import { useRun } from '../src/state/run.ts';
import { clearEvents, eventsSinceSpoken } from '../src/state/runEvents.ts';
import { watchRun } from '../src/state/runEvents.ts';
import { useSession } from '../src/state/session.ts';
import { newConversation, openThread, startThreads, useThreads } from '../src/state/threads.ts';

// Starting the experiment from the conversation (the start card, or straight into the run), one conversation per
// experiment (state/threads.ts), and what the user does by hand written into it (state/runEvents.ts).

vi.hoisted(() => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
    key: (i: number) => [...values.keys()][i] ?? null,
    get length() { return values.size; },
  } });
});

const bca = Protocol.parse(JSON.parse(readFileSync(new URL('../data/protocols/pierce-bca.json', import.meta.url), 'utf8')));
let seq = 0;
const context = (): ConverseContext => {
  const s = useRun.getState();
  return { screen: 'chat', protocolId: s.protocolId, procedure: s.procedure, samples: s.samples, replicates: s.replicates };
};
const options = (extra: Partial<AssistantActionOptions> = {}): AssistantActionOptions => ({ callId: `start-${++seq}`, navigate: vi.fn(), protocol: bca, context: context(), loadProtocol: async () => bca, ...extra });
/** A turn in the conversation, as state/conversation.ts adds one before carrying out its actions. */
const turn = (ask: string) => {
  const id = ++seq;
  useChatLog.getState().add({ id, ask, phase: 'thinking', say: '', done: [], go: [] });
  return id;
};
const reply = (id: number) => useChatLog.getState().set(id, { phase: 'reply', say: 'ok' });

beforeEach(() => {
  resetAssistantActions(true);
  useThreads.setState({ threads: [], active: null, runThread: null });
  useChatLog.setState({ exchanges: [] });
  useSession.setState({ history: [], summary: '', thread: null });
  useRun.getState().reset();
  useBench.getState().clear();
  clearEvents();
  startThreads();
});

describe('starting the experiment from the conversation', () => {
  it('skips the start card only for an answer to it, or when the user said to start at once', () => {
    const now = { type: 'startRun', now: true } as const;
    expect(startWhenAsked(now, '好，我們開始實驗吧', { screen: 'chat' })).toEqual({ type: 'startRun' });
    expect(startWhenAsked(now, '好', { screen: 'chat', startCard: true })).toEqual(now);
    expect(startWhenAsked(now, '直接開始，用預設', { screen: 'chat' })).toEqual(now);
    expect(startWhenAsked(now, 'just start it', { screen: 'chat' })).toEqual(now);
  });

  it('reads start, its protocol and a yes from the tool call', () => {
    expect(actionFromArguments({ type: 'startRun' }, { screen: 'chat' })).toEqual({ type: 'startRun' });
    expect(actionFromArguments({ type: 'startRun', target: 'pierce-bca', yes: true }, { screen: 'chat' })).toEqual({ type: 'startRun', protocolId: 'pierce-bca', now: true });
  });

  it('puts the start card under the answer while the plan was never set, and starts nothing', async () => {
    const id = turn('開始 BCA 實驗');
    const navigate = vi.fn();
    const receipt = await executeAssistantAction({ type: 'startRun', protocolId: 'pierce-bca' }, options({ exchangeId: id, navigate }));
    expect(receipt.ok).toBe(true);
    expect(receipt.message.startsWith(START_CARD)).toBe(true);
    expect(useRun.getState()).toMatchObject({ protocolId: 'pierce-bca', begun: false });
    expect(useChatLog.getState().exchanges.find(e => e.id === id)?.start).toEqual({ protocolId: 'pierce-bca' });
    expect(navigate).toHaveBeenCalledWith('/chat');
    expect(confirmation([{ type: 'startRun' }], '開始 BCA 實驗', [receipt.message])).toBe('這是這次的設定。按開始，或說「好」就開始。');
  });

  it('goes straight into the run on a yes, or once the user set the plan', async () => {
    const navigate = vi.fn();
    await executeAssistantAction({ type: 'startRun', protocolId: 'pierce-bca' }, options());
    const yes = await executeAssistantAction({ type: 'startRun', now: true }, options({ navigate }));
    expect(yes.ok).toBe(true);
    expect(yes.message).toMatch(/^Started/);
    expect(useRun.getState().begun).toBe(true);
    expect(navigate).toHaveBeenCalledWith(expect.stringMatching(/^\/run\//));
    expect(confirmation([{ type: 'startRun', now: true }], '好', [yes.message])).toBe('開始囉。');

    // A new run, planned by the user first: no card.
    useRun.getState().setProtocol(null);
    await executeAssistantAction({ type: 'openProtocol', protocolId: 'pierce-bca' }, options());
    useRun.getState().setPlan({ samples: 6 });
    const planned = await executeAssistantAction({ type: 'startRun' }, options());
    expect(planned.message).toMatch(/^Started/);
  });

  it('goes back to the run where it is once it has begun', async () => {
    await executeAssistantAction({ type: 'startRun', protocolId: 'pierce-bca', now: true }, options());
    useRun.getState().goTo(3);
    const navigate = vi.fn();
    const back = await executeAssistantAction({ type: 'startRun' }, options({ navigate }));
    expect(back.message).toMatch(/^Back to/);
    expect(navigate).toHaveBeenCalledWith('/run/4');
  });

  it('does not start, here, a run another conversation set aside', async () => {
    await executeAssistantAction({ type: 'startRun', protocolId: 'pierce-bca', now: true }, options());
    newConversation();
    expect(useRun.getState().aside).toBe(true);
    const r = await executeAssistantAction({ type: 'startRun' }, options());
    expect(r.ok).toBe(false);
  });
});

describe('one conversation per experiment', () => {
  it('makes the conversation the experiment it opened, sets the run aside for a new one, and brings both back', async () => {
    const id = turn('open BCA');
    await executeAssistantAction({ type: 'openProtocol', protocolId: 'pierce-bca' }, options());
    reply(id);
    const experiment = useThreads.getState().active!;
    expect(useThreads.getState().runThread).toBe(experiment);

    newConversation();
    expect(useChatLog.getState().exchanges).toEqual([]);
    expect(useRun.getState()).toMatchObject({ protocolId: 'pierce-bca', aside: true });
    const plain = turn('what is a standard curve?');
    reply(plain);

    openThread(experiment);
    expect(useChatLog.getState().exchanges.map(e => e.ask)).toEqual(['open BCA']);
    expect(useRun.getState().aside).toBe(false);
    const other = useThreads.getState().threads.find(t => t.id !== experiment)!;
    expect(other.chat.exchanges.map(e => e.ask)).toEqual(['what is a standard curve?']);
  });

  it('keeps an experiment whole when its conversation goes on to another kit', async () => {
    await executeAssistantAction({ type: 'startRun', protocolId: 'pierce-bca', now: true }, options());
    useRun.getState().goTo(2);
    const first = useThreads.getState().active!;
    const other = { ...bca, id: 'other-kit', title: 'Other kit' };
    await executeAssistantAction({ type: 'openProtocol', protocolId: 'other-kit' }, options({ protocol: null, loadProtocol: async () => other }));
    expect(useRun.getState().protocolId).toBe('other-kit');
    expect(useThreads.getState().active).not.toBe(first);
    expect(useThreads.getState().threads.find(t => t.id === first)?.run).toMatchObject({ protocolId: 'pierce-bca', step: 2, begun: true });
    openThread(first);
    expect(useRun.getState()).toMatchObject({ protocolId: 'pierce-bca', step: 2 });
  });
});

describe('what the user does by hand on the run', () => {
  watchRun();

  it('is written into the experiment’s conversation and told to Chapp once, but Chapp’s own changes are not', async () => {
    await executeAssistantAction({ type: 'startRun', protocolId: 'pierce-bca', now: true }, options());
    clearEvents();
    const before = useChatLog.getState().exchanges.length;
    useRun.getState().next();
    useRun.getState().next();
    useRun.getState().setDone('A');
    useRun.getState().setDone('B');
    const lines = useChatLog.getState().exchanges.at(-1)!;
    expect(lines.event).toBe(true);
    expect(useChatLog.getState().exchanges.length).toBe(before + 1);
    // Steps tapped through keep the last; ticks gather on one line.
    expect(lines.done).toEqual(['Step 3', 'Ticked: A, B']);
    expect(eventsSinceSpoken()).toEqual(['Step 3', 'Ticked: A, B']);

    clearEvents();
    await executeAssistantAction({ type: 'nextStep' }, options({ context: { ...context(), screen: 'run', step: useRun.getState().step } }));
    expect(eventsSinceSpoken()).toEqual([]);
  });

  it('goes to the run’s own conversation while another is on screen', async () => {
    await executeAssistantAction({ type: 'startRun', protocolId: 'pierce-bca', now: true }, options());
    const experiment = useThreads.getState().active!;
    newConversation();
    useRun.getState().next();
    expect(useChatLog.getState().exchanges).toEqual([]);
    expect(eventsSinceSpoken()).toEqual([]);
    expect(useThreads.getState().threads.find(t => t.id === experiment)?.chat.exchanges.at(-1)?.done).toEqual(['Step 2']);
  });
});
