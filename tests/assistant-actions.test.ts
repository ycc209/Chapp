import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assemble } from '../server/ai/import.ts';
import type { Action, ConverseContext } from '../shared/ai.ts';
import { parts } from './import-fixture.ts';
import { runSetup } from '../src/components/lab/model.ts';
import { useBench } from '../src/screens/run/bench.ts';
import { executeAssistantAction, resetAssistantActions, undoAssistantAction, type AssistantActionOptions } from '../src/state/assistantActions.ts';
import { useRun } from '../src/state/run.ts';
import { openThread, useThreads } from '../src/state/threads.ts';
import { goToRunStep } from '../src/screens/run/navigation.ts';
import { benchSteps } from '../src/components/lab/model.ts';

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

const protocol = assemble(parts(), { sha256: 'a'.repeat(64), pages: 2, fetchedAt: '2026-10-31T00:00:00.000Z', seconds: 1 }).protocol;
let seq = 0;
const context = (): ConverseContext => {
  const s = useRun.getState();
  return { screen: 'run', protocolId: s.protocolId, procedure: s.procedure, step: s.step, samples: s.samples, replicates: s.replicates, edits: structuredClone(s.edits), lengths: structuredClone(useBench.getState().lengths) };
};
const options = (extra: Partial<AssistantActionOptions> = {}): AssistantActionOptions => ({ callId: `test-${++seq}`, navigate: vi.fn(), protocol, context: context(), ...extra });
const execute = (action: Parameters<typeof executeAssistantAction>[0], extra: Partial<AssistantActionOptions> = {}) => executeAssistantAction(action, options(extra));

beforeEach(() => {
  vi.restoreAllMocks();
  resetAssistantActions(true);
  useThreads.setState({ threads: [], active: null, runThread: null });
  useRun.getState().reset();
  useRun.getState().setProtocol(protocol.id);
  useRun.setState({ procedure: 'plate', samples: 4, replicates: 2, standardReplicates: 2, standards: 'kit' });
  useBench.getState().clear();
});

describe('assistant action execution receipts', () => {
  it('executes concurrent retries once and returns the original outcome on later retries', async () => {
    const opts = options();
    const [a, b] = await Promise.all([
      executeAssistantAction({ type: 'nextStep' }, opts),
      executeAssistantAction({ type: 'nextStep' }, opts),
    ]);
    expect(a.ok).toBe(true);
    expect(b).toEqual(a);
    expect(useRun.getState().step).toBe(1);
    expect(await executeAssistantAction({ type: 'nextStep' }, opts)).toEqual(a);
    expect(useRun.getState().step).toBe(1);
    expect((await executeAssistantAction({ type: 'previousStep' }, opts)).ok).toBe(false);
    expect(useRun.getState().step).toBe(1);
  });

  it('rejects a response based on a different protocol or a superseded plan', async () => {
    const original = context();
    useRun.getState().setPlan({ samples: 7 });
    expect(await execute({ type: 'setReplicates', replicates: 3 }, { context: original })).toMatchObject({ ok: false, message: expect.stringContaining('run changed') });
    expect(useRun.getState().replicates).toBe(2);
    expect(await execute({ type: 'nextStep' }, { context: { ...context(), protocolId: 'another-kit' } })).toMatchObject({ ok: false });
    expect(useRun.getState().step).toBe(0);
  });

  it('rejects nonexistent steps and items rather than adding meaningless completion flags', async () => {
    expect((await execute({ type: 'markDone', id: 'made-up-step' })).ok).toBe(false);
    expect((await execute({ type: 'redo', id: '99' })).ok).toBe(false);
    expect((await execute({ type: 'startTimer', id: 'p-load', seconds: 60 })).ok).toBe(false);
    expect(useRun.getState().done).toEqual({});
    expect(useRun.getState().timers).toEqual({});
    expect((await execute({ type: 'markDone', id: 'p-load' })).ok).toBe(true);
    expect(useRun.getState().done['p-load']).toBe(true);
  });

  it('rejects newly edited wells or timer settings even when the original context omitted empty fields', async () => {
    const initial = { ...context(), edits: undefined, lengths: undefined };
    useRun.getState().moveWell('A1', 'H12');
    expect((await execute({ type: 'setSamples', samples: 5 }, { context: initial })).ok).toBe(false);
    expect(useRun.getState().samples).toBe(4);
    const afterMove = { ...context(), lengths: undefined };
    useBench.getState().setLength('p-incubate', 3600);
    expect((await execute({ type: 'startTimer', id: 'p-incubate', seconds: 1800 }, { context: afterMove })).ok).toBe(false);
    expect(useRun.getState().timers).toEqual({});
  });

  it('restores the one-based run URL when undoing progress from a later step', async () => {
    useRun.getState().goTo(1);
    expect((await execute({ type: 'nextStep' })).ok).toBe(true);
    const navigate = vi.fn();
    expect(undoAssistantAction(navigate, 'run').ok).toBe(true);
    expect(useRun.getState().step).toBe(1);
    expect(navigate).toHaveBeenCalledWith('/run/2');
  });

  it('commits each page navigation before another tool sees the step and completion state', async () => {
    const steps = benchSteps(protocol, 'plate');
    const navigate = vi.fn();
    const executePage = () => {
      goToRunStep(steps, useRun.getState().step + 1, navigate, '?gloves=1');
      return { ok: true, message: 'Moved to the next step.' };
    };
    expect((await execute({ type: 'nextStep' }, { executePage })).ok).toBe(true);
    expect((await execute({ type: 'nextStep' }, { executePage })).ok).toBe(true);
    expect(useRun.getState().step).toBe(2);
    expect(useRun.getState().done).toMatchObject({ [steps[0]!.id]: true, [steps[1]!.id]: true });
    expect(navigate.mock.calls).toEqual([['/run/2?gloves=1'], ['/run/3?gloves=1']]);
  });

  it('invalidates readings after a plan change and restores both with undo', async () => {
    const readings = { A1: 0.5, A2: 0.55 };
    useRun.getState().setReadings(readings, 'plate');
    const result = await execute({ type: 'setReplicates', replicates: 3 });
    expect(result).toMatchObject({ ok: true, message: expect.stringContaining('Cleared the previous readings') });
    expect(useRun.getState()).toMatchObject({ replicates: 3, readings: {}, readingsFrom: null });
    expect(undoAssistantAction().ok).toBe(true);
    expect(useRun.getState()).toMatchObject({ replicates: 2, readings, readingsFrom: 'plate' });
  });

  it('clears readings after moving a well, but retains them for an unchanged plan', async () => {
    useRun.getState().setReadings({ A1: 0.5 }, 'plate');
    expect((await execute({ type: 'setSamples', samples: 4 })).ok).toBe(true);
    expect(useRun.getState().readings).toEqual({ A1: 0.5 });
    expect((await execute({ type: 'moveWell', from: 'A1', to: 'H12' })).ok).toBe(true);
    expect(useRun.getState().readings).toEqual({});
    expect(undoAssistantAction().ok).toBe(true);
    expect(useRun.getState().readings).toEqual({ A1: 0.5 });
  });

  it('validates actual plate occupancy and dimensions before moving a well', async () => {
    const { plate } = runSetup(protocol, useRun.getState());
    const from = plate.cells[0]!.well, occupied = plate.cells[1]!.well;
    expect((await execute({ type: 'moveWell', from, to: occupied })).ok).toBe(false);
    expect((await execute({ type: 'moveWell', from, to: 'P24' })).ok).toBe(false);
    expect(useRun.getState().edits.moved).toEqual({});
    expect((await execute({ type: 'moveWell', from, to: 'H12' })).ok).toBe(true);
    expect(useRun.getState().edits.moved[from]).toBe('H12');
    expect(runSetup(protocol, useRun.getState()).plate.cells.find(c => c.well === from)).toBeUndefined();
    expect(undoAssistantAction().ok).toBe(true);
    expect(useRun.getState().edits.moved).toEqual({});
  });

  it('rejects overflow plans and leaves the previous plan intact', async () => {
    expect((await execute({ type: 'setSamples', samples: 96 })).ok).toBe(false);
    expect(useRun.getState().samples).toBe(4);
    expect((await execute({ type: 'setReplicates', replicates: 3 })).ok).toBe(true);
    expect(useRun.getState()).toMatchObject({ samples: 4, replicates: 3, standardReplicates: 2 });
    expect(runSetup(protocol, useRun.getState()).plate.fits).toBe(true);
  });

  it('checks free space for added wells and conditions', async () => {
    expect((await execute({ type: 'addWell', what: 'control', well: 'P24' })).ok).toBe(false);
    expect((await execute({ type: 'addWell', what: 'control', well: 'A1' })).ok).toBe(false);
    expect((await execute({ type: 'addCondition', name: 'control' })).ok).toBe(true);
    expect(useRun.getState().edits.added[0]).toMatchObject({ name: 'control', wells: expect.any(Array) });
    expect(useRun.getState().edits.added[0]!.wells).toHaveLength(2);
  });

  it('preserves standards when changing sample replicates and applies both only when explicitly supplied', async () => {
    const result = await execute({ type: 'setReplicates', replicates: 3 });
    expect(result).toMatchObject({ ok: true, message: 'Samples now use 3 replicates; standards use 2 replicates.' });
    expect(runSetup(protocol, useRun.getState()).plate.wells).toBe(18);
    expect((await execute({ type: 'setReplicates', replicates: 3, standardReplicates: 1 })).ok).toBe(true);
    expect(useRun.getState()).toMatchObject({ replicates: 3, standardReplicates: 1 });
    expect(runSetup(protocol, useRun.getState()).plate.wells).toBe(15);
    expect((await execute({ type: 'setReplicates', replicates: 3, standardReplicates: 0 })).ok).toBe(false);
    expect(useRun.getState().standardReplicates).toBe(1);
  });

  it('remembers an explicitly chosen timer length when later preserving elapsed time', async () => {
    let now = 10_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    expect((await execute({ type: 'startTimer', id: 'p-incubate', seconds: 600 })).ok).toBe(true);
    expect(useBench.getState().lengths['p-incubate']).toBe(600);
    now += 60_000;
    expect((await execute({ type: 'setStepTime', id: 'p-incubate', seconds: 900 })).ok).toBe(true);
    expect(useRun.getState().timers['p-incubate']).toBe(10_000 + 900_000);
  });

  it('retains elapsed time when changing timer duration and refuses to restart an existing timer', async () => {
    let now = 10_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    expect((await execute({ type: 'startTimer', id: 'p-incubate', seconds: 1800 })).ok).toBe(true);
    const originalEnd = useRun.getState().timers['p-incubate'];
    expect((await execute({ type: 'startTimer', id: 'p-incubate', seconds: 1800 })).ok).toBe(false);
    expect(useRun.getState().timers['p-incubate']).toBe(originalEnd);
    now += 60_000;
    expect((await execute({ type: 'setStepTime', id: 'p-incubate', seconds: 3600 })).ok).toBe(true);
    expect(useRun.getState().timers['p-incubate']).toBe(10_000 + 3600_000);
    expect((await execute({ type: 'stopTimer', id: 'p-incubate' })).ok).toBe(true);
    expect(useBench.getState().paused['p-incubate']).toBe(3540);
    now += 30_000;
    expect((await execute({ type: 'resumeTimer', id: 'p-incubate' })).ok).toBe(true);
    expect(useRun.getState().timers['p-incubate']).toBe(now + 3540_000);
  });

  it('requires actual page handling for camera and sample actions and propagates failures', async () => {
    expect((await execute({ type: 'takePhoto' })).ok).toBe(false);
    const executePage = vi.fn(() => ({ ok: false, message: 'Camera permission denied.' }));
    expect(await execute({ type: 'takePhoto' }, { executePage })).toMatchObject({ ok: false, message: 'Camera permission denied.' });
    expect(executePage).toHaveBeenCalledTimes(1);
    expect((await execute({ type: 'takePhoto' }, { executePage: () => ({ ok: true, message: 'Opened the camera.' }) })).ok).toBe(true);
  });

  it('keeps shared-setup preview changes isolated from the active experiment', async () => {
    let previewSamples = 5;
    const executePage = (action: Action) => {
      if (action.type !== 'setSamples') return null;
      previewSamples = action.samples;
      return { ok: true, message: `Preview has ${previewSamples} samples.` };
    };
    const preview = { screen: 'share-import', protocolId: 'other-kit' };
    expect((await execute({ type: 'setSamples', samples: 8 }, { context: preview, executePage })).ok).toBe(true);
    expect(previewSamples).toBe(8);
    expect(useRun.getState().samples).toBe(4);
    expect((await execute({ type: 'setReplicates', replicates: 3 }, { context: preview, executePage })).ok).toBe(false);
    expect(useRun.getState().replicates).toBe(2);
  });

  it('never uses undo to overwrite manual changes made after an assistant action', async () => {
    await execute({ type: 'setSamples', samples: 5 });
    useRun.getState().setPlan({ samples: 7 });
    expect(undoAssistantAction()).toMatchObject({ ok: false, message: expect.stringContaining('newer work') });
    expect(useRun.getState().samples).toBe(7);
  });

  it('opens a verified protocol only when requested, and keeps the previous run in its own conversation', async () => {
    useRun.setState({ done: { 'p-load': true }, readings: { A1: 0.2 }, readingsFrom: 'plate' });
    const old = structuredClone({ done: useRun.getState().done, readings: useRun.getState().readings });
    const next = { ...protocol, id: 'another-kit', title: 'Another kit' };
    const loadProtocol = vi.fn(async () => next);
    expect((await execute({ type: 'findProtocol', query: 'another kit' })).ok).toBe(false);
    expect(useRun.getState().protocolId).toBe(protocol.id);
    expect((await execute({ type: 'openProtocol', protocolId: next.id }, { loadProtocol })).ok).toBe(true);
    expect(useRun.getState()).toMatchObject({ protocolId: next.id, done: {}, readings: {} });
    // Not undone here: the run before it waits in its conversation, and comes back whole from the sidebar.
    const kept = useThreads.getState().threads.find(t => t.run?.protocolId === protocol.id)!;
    expect(kept.run).toMatchObject(old);
    openThread(kept.id);
    expect(useRun.getState()).toMatchObject({ protocolId: protocol.id, ...old });
  });

  it('preserves the current experiment when opening its own overview again', async () => {
    useRun.setState({ step: 2, done: { 'p-load': true }, timers: { 'p-incubate': Date.now() + 60_000 }, readings: { A1: 0.2 }, readingsFrom: 'plate', samples: 7 });
    const before = JSON.stringify(useRun.getState());
    expect((await execute({ type: 'openProtocol', protocolId: protocol.id }, { loadProtocol: async () => protocol })).ok).toBe(true);
    expect(JSON.stringify(useRun.getState())).toBe(before);
  });

  it('does not replace a run changed while a new protocol is loading', async () => {
    const result = await execute({ type: 'openProtocol', protocolId: 'another-kit' }, {
      loadProtocol: async () => {
        useRun.getState().setPlan({ samples: 9 });
        return { ...protocol, id: 'another-kit' };
      },
    });
    expect(result.ok).toBe(false);
    expect(useRun.getState()).toMatchObject({ protocolId: protocol.id, samples: 9 });
  });
});
