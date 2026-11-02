import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBench } from '../src/screens/run/bench.ts';
import { alarmText, checkAlarms, openAlarm, runningTimers, useAlarms } from '../src/state/alarms.ts';
import { useChatLog } from '../src/state/conversationLog.ts';
import { useRun } from '../src/state/run.ts';
import { useSession } from '../src/state/session.ts';
import { adoptIntoConversation, newConversation, startThreads, useThreads } from '../src/state/threads.ts';
import { Protocol } from '../shared/protocol.ts';

// Every experiment's timers ring, wherever the user is (state/alarms.ts): the run under way's and those waiting in
// their own conversations, each under its own key, and Time's up opens the experiment it belongs to.

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

const json = readFileSync(new URL('../data/protocols/pierce-bca.json', import.meta.url), 'utf8');
const bca = Protocol.parse(JSON.parse(json));

/** A BCA run started in the conversation on screen (it becomes the experiment's), incubating, its timer ending in `ms`. */
function incubating(ms: number) {
  adoptIntoConversation();
  useRun.getState().setProtocol('pierce-bca');
  useRun.setState({ procedure: 'microplate', begun: true, step: 4 });
  useRun.getState().startTimer('m-incubate', ms / 1000);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(json, { status: 200, headers: { 'content-type': 'application/json' } })));
  useThreads.setState({ threads: [], active: null, runThread: null });
  useChatLog.setState({ exchanges: [] });
  useSession.setState({ history: [], summary: '', thread: null });
  useAlarms.setState({ ringing: null, rung: {} });
  useRun.getState().reset();
  useBench.getState().clear();
  startThreads();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('every experiment’s timers', () => {
  it('are listed under their own experiment, so two BCA runs never share a key', () => {
    incubating(60_000);
    const first = useThreads.getState().runThread;
    newConversation();
    // A second BCA experiment in the new conversation: the first waits in its own, still timing.
    incubating(120_000);
    const timers = runningTimers();
    expect(timers).toHaveLength(2);
    expect(new Set(timers.map(t => t.key)).size).toBe(2);
    expect(timers.every(t => t.stepId === 'm-incubate')).toBe(true);
    expect(timers.find(t => !t.live)?.owner).toBe(first);
  });

  it('ring on any screen when one ends, saying what is next and where it opens', async () => {
    incubating(1000);
    checkAlarms();
    await vi.advanceTimersByTimeAsync(1500);
    const ringing = useAlarms.getState().ringing!;
    expect(ringing.text.title).toBe('Pierce BCA · Incubate done');
    expect(ringing.text.body).toMatch(/^Next: /);
    expect(ringing.text.url).toMatch(/^\/run\/6/);
    // Rung once: looking again does not ring it again.
    useAlarms.setState({ ringing: null });
    checkAlarms();
    await vi.advanceTimersByTimeAsync(10);
    expect(useAlarms.getState().ringing).toBeNull();
  });

  it('ring for an experiment set aside, and Time’s up goes back to it', async () => {
    incubating(1000);
    const experiment = useThreads.getState().runThread!;
    newConversation();
    expect(useRun.getState().aside).toBe(true);
    checkAlarms();
    await vi.advanceTimersByTimeAsync(1500);
    expect(useAlarms.getState().ringing?.alarm.owner).toBe(experiment);
    const navigate = vi.fn();
    openAlarm(navigate);
    expect(useThreads.getState().active).toBe(experiment);
    expect(useRun.getState().aside).toBe(false);
    expect(navigate).toHaveBeenCalledWith('/run/6');
  });

  it('ring for an experiment waiting in its conversation while another runs', async () => {
    incubating(1000);
    const first = useThreads.getState().runThread!;
    newConversation();
    // Another experiment becomes the run under way; the first, with its timer, waits.
    incubating(60_000);
    expect(runningTimers().find(t => !t.live)?.owner).toBe(first);
    checkAlarms();
    await vi.advanceTimersByTimeAsync(1500);
    expect(useAlarms.getState().ringing?.alarm).toMatchObject({ owner: first, live: false });
  });

  it('do not ring for one that ended long ago, while Chapp was closed', async () => {
    incubating(1000);
    vi.setSystemTime(Date.now() + 7 * 3600_000);
    checkAlarms();
    await vi.advanceTimersByTimeAsync(10);
    expect(useAlarms.getState().ringing).toBeNull();
    expect(Object.keys(useAlarms.getState().rung)).toHaveLength(1);
  });

  it('say the protocol’s own next step for a protocol followed step by step', () => {
    const text = alarmText({ key: 'c:m-incubate', owner: 'c', protocolId: 'pierce-bca', procedure: 'microplate', stepId: 'm-incubate', endsAt: 0, live: false }, bca);
    expect(text.url).toBe('/run/6?experiment=c');
  });
});
