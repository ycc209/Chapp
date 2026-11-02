import { START_CARD, type Action, type ConverseContext } from '../../shared/ai.ts';
import { isPlannable } from '../../shared/calc.ts';
import { Protocol, isAssay, type Protocol as ProtocolDocument } from '../../shared/protocol.ts';
import { benchSteps, freeWells, runSetup, standardsOf, type PlatePlan } from '../components/lab/model.ts';
import { useBench } from '../screens/run/bench.ts';
import { tubeKey } from '../screens/run/model.ts';
import { changeStepTime } from './actions.ts';
import { procedureFor } from '../screens/protocol/content.ts';
import { asAssistant } from './applying.ts';
import { addWells, moveWells, redo } from './benchEdits.ts';
import { useChatLog } from './conversationLog.ts';
import { load } from './protocol.ts';
import { runStarted, useRun, type RunState } from './run.ts';
import { beginRun } from './start.ts';
import { adoptIntoConversation } from './threads.ts';

/** Results describe the app's actual operation; the model must wait for one before claiming completion. */
export type ActionResult = { ok: boolean; message: string };
export type ActionReceipt = ActionResult & { callId: string };
type AssistantAction = Action | { type: 'undo' } | { type: 'openProtocol'; protocolId: string };
export type AssistantActionOptions = {
  callId: string;
  /** The exchange in the conversation this action belongs to (the start card goes under its answer). */
  exchangeId?: number;
  navigate: (to: string) => void;
  protocol: ProtocolDocument | null;
  /** State the request was based on. Refresh between sequential actions in the same batch. */
  context: ConverseContext;
  /** Actual page operations (camera, sample data, accepting a preview, advancing within a step). */
  executePage?: (action: Action) => ActionResult | null | Promise<ActionResult | null>;
  loadProtocol?: (id: string) => Promise<ProtocolDocument>;
};

type BenchData = Pick<ReturnType<typeof useBench.getState>, 'lengths' | 'paused' | 'announced' | 'platePhoto' | 'check'>;
type Snapshot = { run: RunState; bench: BenchData };
type UndoEntry = { before: Snapshot; after: Snapshot; description: string };
type Completed = { action: string; receipt: ActionReceipt };
const completed = new Map<string, Completed>();
const inflight = new Map<string, { action: string; promise: Promise<ActionReceipt> }>();
const documents = new Map<string, ProtocolDocument>();
const undo: UndoEntry[] = [];
const RECEIPTS_KEY = 'chapp.assistant.receipts';
const LIMIT = 128;
const routes = new Set(['/', '/protocol', '/kit', '/plan', '/results', '/share', '/import', '/library']);
let loaded = false;
let queue: Promise<unknown> = Promise.resolve();

const success = (message: string): ActionResult => ({ ok: true, message });
const failure = (message: string): ActionResult => ({ ok: false, message });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const positive = (n: number, max: number) => Number.isInteger(n) && n > 0 && n <= max;
const layoutState = (run: RunState) => ({ procedure: run.procedure, samples: run.samples, replicates: run.replicates, standardReplicates: run.standardReplicates, standards: run.standards, edits: run.edits });

function snapshot(): Snapshot {
  const r = useRun.getState(), b = useBench.getState();
  return structuredClone({
    run: {
      protocolId: r.protocolId, procedure: r.procedure, samples: r.samples, replicates: r.replicates,
      standardReplicates: r.standardReplicates, standards: r.standards, step: r.step, done: r.done, timers: r.timers,
      photos: r.photos, readings: r.readings, readingsFrom: r.readingsFrom, aside: r.aside, edits: r.edits, planned: r.planned, begun: r.begun,
    },
    bench: { lengths: b.lengths, paused: b.paused, announced: b.announced, platePhoto: b.platePhoto, check: b.check },
  });
}

function restore(s: Snapshot) {
  useRun.setState(structuredClone(s.run));
  // A run subscriber may clear bench state, so restore it after the run.
  useBench.setState(structuredClone(s.bench));
}

function loadReceipts() {
  if (loaded) return;
  loaded = true;
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(RECEIPTS_KEY) ?? '[]');
    if (!Array.isArray(saved)) return;
    for (const entry of saved.slice(-LIMIT)) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue;
      const value = entry[1] as Completed | undefined;
      if (typeof value?.action === 'string' && typeof value.receipt?.ok === 'boolean' && typeof value.receipt.message === 'string' && value.receipt.callId === entry[0]) completed.set(entry[0], value);
    }
  } catch { /* Storage is optional; in-memory receipts still prevent repeats this session. */ }
}

function remember(callId: string, value: Completed) {
  completed.set(callId, value);
  while (completed.size > LIMIT) completed.delete(completed.keys().next().value!);
  try { localStorage.setItem(RECEIPTS_KEY, JSON.stringify([...completed])); } catch { /* Storage unavailable/full. */ }
}

/** No language matching: only a stale target or stale state can invalidate an understood request here. */
function stale(context: ConverseContext): string | null {
  const now = useRun.getState();
  if (context.protocolId !== undefined && context.protocolId !== now.protocolId) return 'The active protocol changed while this request was being answered. Nothing was changed.';
  for (const key of ['procedure', 'step', 'samples', 'replicates', 'standardReplicates', 'standards'] as const) {
    if (context[key] !== undefined && context[key] !== now[key]) return 'The run changed while this request was being answered. Please use its current state.';
  }
  if (context.protocolId !== undefined && !same(context.edits ?? { moved: {}, added: [] }, now.edits)) return 'The plate layout changed while this request was being answered. Nothing was changed.';
  if (context.done && !same(context.done, now.done)) return 'The completed items changed while this request was being answered. Please use the current progress.';
  if (context.protocolId !== undefined && !same(context.lengths ?? {}, useBench.getState().lengths)) return 'The timer settings changed while this request was being answered. Nothing was changed.';
  return null;
}

function wellExists(well: string, plate: PlatePlan) {
  const m = /^([A-P])([1-9]\d?)$/.exec(well);
  return Boolean(m && m[1]!.charCodeAt(0) - 65 < plate.rows && Number(m[2]) <= plate.cols);
}

function validLayout(p: ProtocolDocument, plan: RunState): boolean {
  const { series, plate } = runSetup(p, plan);
  const expected = standardsOf(series.vials).length * plan.standardReplicates + plan.samples * plan.replicates + plan.edits.added.reduce((n, a) => n + a.wells.length, 0);
  return plate.fits && plate.cells.length === expected && new Set(plate.cells.map(c => c.well)).size === plate.cells.length;
}

async function openProtocol(id: string, options: AssistantActionOptions): Promise<ActionResult> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) return failure('That protocol identifier is invalid.');
  const before = snapshot();
  const p = options.loadProtocol
    ? await options.loadProtocol(id)
    : await fetch(`/api/protocols/${encodeURIComponent(id)}`).then(async response => {
      if (!response.ok) throw new Error('The requested protocol is not available.');
      return Protocol.parse(await response.json());
    });
  if (p.id !== id || !p.procedures.some(x => x.id === p.defaults.procedure)) return failure('The document does not match the requested protocol.');
  if (!same(snapshot(), before)) return failure('The run changed while the protocol was loading. It was not replaced.');
  documents.set(p.id, p);
  if (before.run.protocolId === p.id && !before.run.aside) return success(`Already viewing ${p.title}'s active experiment. Its setup, progress and measurements were preserved.`);
  // This conversation becomes the experiment's; a run before it keeps its own conversation (src/state/threads.ts).
  adoptIntoConversation();
  useRun.getState().setProtocol(p.id);
  useRun.setState({ procedure: p.defaults.procedure, samples: p.defaults.samples ?? 12, replicates: p.defaults.replicates ?? 2, standardReplicates: p.defaults.replicates ?? 2, standards: 'kit', readings: {}, readingsFrom: null, planned: false, begun: false });
  useBench.getState().clear();
  return success(`Opened ${p.title} as this conversation's experiment.${before.run.protocolId ? ' The run before it is kept, with its own conversation, in the sidebar.' : ''}`);
}

/**
 * Start the experiment, as the user asked Chapp to: the protocol named is adopted first when it is not the current
 * one. Back to the run where it is once it has begun; the start card under this answer while the plan was never set
 * and the user did not say to start at once (the Apps SDK's single decision in an inline card, with Start and a way
 * to change it); else into the run. A run set aside by New conversation is another conversation's: not started here.
 */
async function startRun(action: { protocolId?: string; now?: boolean }, options: AssistantActionOptions): Promise<ActionResult> {
  const before = useRun.getState();
  if (action.protocolId && (action.protocolId !== before.protocolId || before.aside)) {
    const opened = await openProtocol(action.protocolId, options);
    if (!opened.ok) return opened;
  } else if (before.aside) return failure('The run under way belongs to another conversation in the sidebar. Ask which kit to start here, or open that experiment from the sidebar.');
  const run = useRun.getState();
  if (!run.protocolId) return failure('No experiment is chosen yet. Ask which kit to start, or open one from the library.');
  const p = (options.protocol?.id === run.protocolId ? options.protocol : null) ?? documents.get(run.protocolId) ?? await load(run.protocolId);
  documents.set(p.id, p);
  if (runStarted(run)) {
    options.navigate(beginRun(p));
    return success(`Back to the ${p.title} run, at step ${useRun.getState().step + 1}.`);
  }
  if (isPlannable(p, procedureFor(p, run.procedure)) && !run.planned && !action.now) {
    if (options.exchangeId !== undefined) useChatLog.getState().set(options.exchangeId, { start: { protocolId: p.id } });
    options.navigate('/chat');
    return success(`${START_CARD}: ${p.title}, ${run.samples} samples × ${run.replicates}, standards × ${run.standardReplicates}. Nothing has started: the run starts when the user taps Start on the card or agrees (startRun with yes).`);
  }
  const to = beginRun(p);
  options.navigate(to);
  const now = useRun.getState();
  const steps = benchSteps(p, now.procedure);
  return success(`Started ${p.title}${to === '/run/prep' ? ', with the reagent prep first' : `: step ${now.step + 1} of ${steps.length} · ${steps[now.step]?.title ?? ''}`}.`);
}

async function perform(action: AssistantAction, options: AssistantActionOptions): Promise<ActionResult> {
  if (action.type === 'navigate') {
    if (!routes.has(action.to)) return failure('That destination is not available.');
    options.navigate(action.to);
    return success(`Opened ${action.to}.`);
  }
  // A shared setup preview is isolated from the active experiment, including when no page handler is mounted.
  if (options.context.screen === 'share-import') return (await options.executePage?.(action as Action)) ?? failure('This action is not available in the shared-setup preview. The active run was not changed.');
  if (options.context.screen === 'protocol-preview' && action.type !== 'openProtocol') return failure('This is a manual preview. Open the current experiment to change its setup; the active run was not changed.');
  if (action.type === 'findProtocol') return failure('Searching for a protocol is a research tool. It does not change the current experiment.');
  const changed = stale(options.context);
  if (changed) return failure(changed);
  if (action.type === 'undo') return undoAssistantAction(options.navigate, options.context.screen);
  if (action.type === 'openProtocol') return openProtocol(action.protocolId, options);
  if (action.type === 'startRun') return startRun(action, options);

  const run = useRun.getState();
  const p = options.protocol?.id === run.protocolId ? options.protocol : documents.get(run.protocolId ?? '');
  if (!p || !run.protocolId) return failure('There is no matching active protocol to change.');
  documents.set(p.id, p);
  const procedure = p.procedures.find(x => x.id === run.procedure);
  if (!procedure) return failure('The current procedure is not part of this protocol.');
  const steps = benchSteps(p, procedure.id);
  const byId = (id: string) => steps.find(s => s.id === id);
  const timed = 'id' in action ? byId(action.id)?.step.timer : undefined;
  const plateActions = ['setSamples', 'setReplicates', 'moveWell', 'addWell', 'addCondition', 'redo'];
  if (plateActions.includes(action.type) && !isAssay(procedure)) return failure('This procedure does not have an assay plate layout to change.');
  if ((action.type === 'nextStep' || action.type === 'previousStep') && (run.step < 0 || run.step >= steps.length)) return failure('The current step is not part of this procedure.');
  if (['startTimer', 'stopTimer', 'resumeTimer', 'setStepTime'].includes(action.type) && !timed) return failure('That step has no timer in this protocol.');
  if ((action.type === 'startTimer' || action.type === 'setStepTime') && !positive(action.seconds, 7 * 24 * 3600)) return failure('The timer duration must be a positive whole number of seconds, at most one week.');
  if (action.type === 'startTimer' && run.timers[action.id] !== undefined) return failure('That timer is already running; it was not restarted.');
  if (action.type === 'stopTimer' && run.timers[action.id] === undefined) return failure('That timer is not running.');
  if (action.type === 'resumeTimer' && !useBench.getState().paused[action.id]) return failure('That timer has no paused time to resume.');

  // The page reports the actual outcome of UI-specific operations. A missing handler is never a success.
  const page = options.protocol?.id === run.protocolId ? await options.executePage?.(action as Action) : null;
  if (page) return page;
  switch (action.type) {
    case 'takePhoto': case 'useSample': case 'answer': return failure('That operation is not available on the current screen.');
    case 'setSamples': case 'setReplicates': {
      const value = action.type === 'setSamples' ? action.samples : action.replicates;
      if (!positive(value, action.type === 'setSamples' ? 96 : 4)) return failure('The requested sample or replicate count is outside the supported range.');
      if (action.type === 'setReplicates' && action.standardReplicates !== undefined && !positive(action.standardReplicates, 4)) return failure('The requested standard replicate count is outside the supported range.');
      const plan = action.type === 'setSamples' ? { samples: value } : { replicates: value, standardReplicates: action.standardReplicates ?? run.standardReplicates };
      if (!validLayout(p, { ...run, ...plan })) return failure('That plan does not fit the plate with its existing standards, moved wells and added conditions.');
      run.setPlan(plan);
      return success(action.type === 'setSamples' ? `The run now has ${value} samples.` : `Samples now use ${value} replicates; standards use ${useRun.getState().standardReplicates} replicates.`);
    }
    case 'nextStep': {
      if (run.step + 1 >= steps.length) return failure('This is already the last step.');
      run.next();
      return success(`Moved to step ${run.step + 2}: ${steps[run.step + 1]!.title}.`);
    }
    case 'previousStep': {
      if (run.step === 0) return failure('This is already the first step.');
      run.previous();
      return success(`Moved to step ${run.step}: ${steps[run.step - 1]!.title}.`);
    }
    case 'markDone': {
      let id = action.id;
      if (!byId(id)) {
        if (!isAssay(procedure)) return failure('That item is not a step in this procedure.');
        const setup = runSetup(p, run);
        const vial = setup.series.vials.find(v => v.id.toUpperCase() === id.toUpperCase());
        const tube = setup.plate.tubes.find(t => t.kind === 'sample' && t.ref === id);
        if (!vial && !tube) return failure('That vial, sample or step does not exist in this run.');
        id = vial ? vial.id : tubeKey(tube!.index);
      }
      run.setDone(id);
      return success(`Marked ${action.id} complete.`);
    }
    case 'redo': {
      const setup = runSetup(p, run);
      const makingVial = run.standards !== 'ready' && setup.series.vials.some(v => v.id.toUpperCase() === action.id.toUpperCase());
      if (!makingVial && !setup.plate.tubes.some(t => t.ref.toUpperCase() === action.id.toUpperCase())) return failure('That vial or sample does not exist in this run.');
      return success(redo(p, [action.id]));
    }
    case 'moveWell': {
      const { plate } = runSetup(p, run);
      const from = action.from.toUpperCase(), to = action.to?.toUpperCase();
      if (!plate.cells.some(c => c.well === from)) return failure(`${from} has no contents in this run.`);
      if (to && !wellExists(to, plate)) return failure(`${to} is outside this plate.`);
      if (to && (plate.cells.some(c => c.well === to) || plate.bad.includes(to))) return failure(`${to} is occupied or marked unusable.`);
      if (!to && !freeWells(plate, 1).length) return failure('There is no free well on this plate.');
      return success(moveWells(p, [from], to ?? null));
    }
    case 'addWell': case 'addCondition': {
      const { plate } = runSetup(p, run);
      const count = action.type === 'addCondition' ? run.replicates : 1;
      const name = (action.type === 'addCondition' ? action.name : action.what).trim();
      if (!name || name.length > 60) return failure('The added item needs a name of at most 60 characters.');
      const well = action.type === 'addWell' ? action.well?.toUpperCase() : undefined;
      if (well && !wellExists(well, plate)) return failure(`${well} is outside this plate.`);
      if (well && (plate.cells.some(c => c.well === well) || plate.bad.includes(well))) return failure(`${well} is occupied or marked unusable.`);
      if (!well && freeWells(plate, count).length < count) return failure(`There is no room for ${count} more wells on this plate.`);
      return success(addWells(p, name, { well, condition: action.type === 'addCondition' }));
    }
    case 'startTimer':
      run.startTimer(action.id, action.seconds);
      useBench.getState().setLength(action.id, action.seconds);
      useBench.getState().unpause(action.id);
      return success(`Started ${action.id} for ${action.seconds} seconds.`);
    case 'stopTimer': {
      const left = Math.max(0, Math.ceil((run.timers[action.id]! - Date.now()) / 1000));
      run.stopTimer(action.id);
      useBench.getState().pause(action.id, left);
      return success(`Paused ${action.id} with ${left} seconds remaining.`);
    }
    case 'resumeTimer': {
      const left = useBench.getState().paused[action.id]!;
      run.startTimer(action.id, left);
      useBench.getState().unpause(action.id);
      return success(`Resumed ${action.id} with ${left} seconds remaining.`);
    }
    case 'setStepTime': {
      const from = useBench.getState().lengths[action.id] ?? timed!.duration.value * ({ s: 1, min: 60, h: 3600 }[timed!.duration.unit]);
      changeStepTime(action.id, action.seconds, { from });
      return success(`Changed ${action.id} to ${action.seconds} seconds for this run, preserving elapsed time.`);
    }
  }
  return failure('This operation is not supported.');
}

/** A late duplicate, including after a refresh, receives the original receipt and never repeats a mutation. */
export function executeAssistantAction(action: AssistantAction, options: AssistantActionOptions): Promise<ActionReceipt> {
  loadReceipts();
  const serialized = JSON.stringify(action);
  const existing = completed.get(options.callId) ?? inflight.get(options.callId);
  if (existing) {
    if (existing.action !== serialized) return Promise.resolve({ callId: options.callId, ...failure('This tool call identifier was already used for a different action.') });
    return 'receipt' in existing ? Promise.resolve(existing.receipt) : existing.promise;
  }
  const promise = queue.then(async () => {
    const before = snapshot();
    let result: ActionResult;
    try { result = await asAssistant(() => perform(action, options)); }
    catch (error) { result = failure(error instanceof Error ? error.message : 'The operation failed.'); }
    let after = snapshot();
    if (result.ok && action.type !== 'undo' && before.run.protocolId === after.run.protocolId
      && !same(layoutState(before.run), layoutState(after.run))
      && Object.keys(before.run.readings).length && same(before.run.readings, after.run.readings)) {
      // Readings belong to the layout they were measured on. Reassigning them to a new plan can misidentify samples.
      useRun.setState({ readings: {}, readingsFrom: null });
      useBench.getState().setCheck(null);
      result = { ...result, message: `${result.message} Cleared the previous readings because the plate layout changed. Undo restores the previous layout and readings.` };
      after = snapshot();
    }
    // A protocol opened or started moves the run before it into its own conversation: there is nothing to undo here.
    if (result.ok && action.type !== 'undo' && action.type !== 'openProtocol' && action.type !== 'startRun' && !same(before, after)) {
      undo.push({ before, after, description: result.message });
      if (undo.length > 12) undo.shift();
    }
    const receipt = { callId: options.callId, ...result };
    remember(options.callId, { action: serialized, receipt });
    inflight.delete(options.callId);
    return receipt;
  });
  inflight.set(options.callId, { action: serialized, promise });
  queue = promise.catch(() => {});
  return promise;
}

/** Undo only the last assistant change while its result is still current; never overwrite later manual edits. */
export function undoAssistantAction(navigate?: (to: string) => void, screen?: string): ActionResult {
  const entry = undo.at(-1);
  if (!entry) return failure('There is no assistant change to undo in this session.');
  if (!same(snapshot(), entry.after)) return failure('The run has changed since that action. Undo would overwrite newer work, so nothing was changed.');
  restore(entry.before);
  undo.pop();
  if (screen?.startsWith('run')) navigate?.(`/run/${entry.before.run.step + 1}`);
  return success(`Undid the last change: ${entry.description}`);
}

/** New conversation/test boundary. Receipts are retained unless explicitly reset for tests. */
export function resetAssistantActions(clearReceipts = false) {
  undo.length = 0;
  documents.clear();
  if (clearReceipts) {
    completed.clear();
    inflight.clear();
    loaded = true;
    queue = Promise.resolve();
    try { localStorage.removeItem(RECEIPTS_KEY); } catch { /* No storage. */ }
  }
}
