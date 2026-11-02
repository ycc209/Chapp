import { z } from 'zod';
import type { Action, ConverseContext, Source } from '../../shared/ai.ts';
import type { A2uiMessage } from '../../shared/a2ui.ts';
import { parseAmount, dilute, weigh, lookUp, kindOf } from '../../shared/solution.ts';
import { unitOf } from '../../shared/calc.ts';
import { analysisOf } from '../../shared/protocol.ts';
import { dataModel } from '../../src/components/a2ui/data.ts';
import { runSetup, standardsOf } from '../../src/components/lab/model.ts';
import { analyzeRun } from '../../src/screens/results/analysis.ts';
import { procedureFor } from '../../src/screens/protocol/content.ts';
import { ActionSchema, MAX_REPLICATES, MAX_SAMPLES } from './schema.ts';
import { knownProtocols, loadProtocol, manualSources, protocolBrief } from './protocols.ts';

type Json = Record<string, any>;
const str = { type: 'string' };
const number = { type: 'number' };
export const tool = (name: string, description: string, properties: Json = {}, required: string[] = []) => ({
  type: 'function', name, description,
  parameters: { type: 'object', properties, required, additionalProperties: false },
});

export const ACTION_TYPES = [
  'navigate', 'setSamples', 'setReplicates', 'nextStep', 'previousStep', 'markDone', 'startTimer', 'setStepTime',
  'redo', 'moveWell', 'addWell', 'addCondition', 'stopTimer', 'resumeTimer', 'takePhoto', 'useSample', 'answer', 'undo', 'openProtocol', 'startRun',
] as const;
const actionProperties = {
  type: { type: 'string', enum: ACTION_TYPES, description: 'The operation (required); the other fields describe it.' },
  target: { ...str, description: 'Step/vial/sample ID, source well, or protocolId. Use the exact ID from tools.' },
  value: { ...number, description: 'Sample/replicate count, or timer duration in seconds. Get calculations from tools.' },
  standardReplicates: { type: 'integer', minimum: 1, maximum: MAX_REPLICATES, description: 'For setReplicates only: change standards to this repeat count if requested. Omit to preserve their current count; value changes sample replicates only.' },
  to: { ...str, description: 'Destination well for moveWell, or app route for navigate.' },
  text: { ...str, description: 'Extra well purpose or condition name, in the user’s words.' },
  yes: { type: 'boolean', description: 'Answer to the app’s pending question. For startRun: true when the user agreed to the start card, or asked to start straight away without looking at the plan.' },
};

/** A small toolkit; function arguments are checked independently of the assistant's prose. */
export const CONVERSATION_TOOLS = [
  { type: 'web_search' },
  tool('research_science', 'Delegate a focused scientific question to a read-only research specialist that finds primary sources and reads their original text with stable excerpt IDs. Use before detailed scientific explanations, assay troubleshooting or method recommendations. Include relevant prior context in question. One brief per turn; reuse it for follow-ups. Does not modify experiments.', { question: str }, ['question']),
  tool('read_source', 'Fetch and read a registered original webpage or PDF, preserving paragraphs and PDF page numbers. Use a sourceId from discovered evidence, not a made-up URL. Cached read sources can be reused. Read-only.', { sourceId: str, focus: str }, ['sourceId']),
  tool('read_run', 'Read the current experiment, timers, progress and available protocols. Read-only.'),
  tool('read_protocol', 'Read an imported protocol, its documented steps and source. Does not select or change the experiment.', { protocolId: str }),
  tool('calculate_plan', 'Compute wells, standards and reagent amounts for the current assay or a hypothetical plan. Read-only; does NOT apply changes. Optional omitted counts use the current run.', {
    samples: { type: 'integer', minimum: 1, maximum: MAX_SAMPLES },
    replicates: { type: 'integer', minimum: 1, maximum: MAX_REPLICATES },
    standardReplicates: { type: 'integer', minimum: 1, maximum: MAX_REPLICATES },
  }),
  tool('calculate_solution', 'Compute a dilution or mass to weigh with checked units. Missing/incompatible inputs return an explanation. Use the user’s requested quantities or cited source values; do not invent them.', {
    kind: { type: 'string', enum: ['dilute', 'weigh'] }, substance: str, stock: str, concentration: str, volume: str, formulaWeight: number,
  }, ['kind', 'concentration', 'volume']),
  tool('analyze_results', 'Calculate the current plate’s concentrations, fitted standard curve, replicate CVs and out-of-range flags using the same deterministic analysis as Results. Read-only. Uses existing readings; never invent readings. Report missing wells and label built-in example readings as sample data. Concentrations use the returned unit; estimates above the calibration range are only dilution guidance.'),
  tool('find_protocol', 'Search the original manufacturer for a named product’s manual and return source evidence. Read-only: no PDF import, navigation or experiment changes. Independent product queries can run in parallel.', { query: str }, ['query']),
  tool('preview_protocol', 'Open the existing Overview and progressively show At a glance, In the kit, Steps and Principle for an identified/confirmed product. Use exactly one known protocolId or registered original-manual sourceId. A vague assay name must first be clarified with a candidate and its real source link. This prepares a view, never adopts or resets the active experiment. Reuse this preview for follow-ups.', { protocolId: str, sourceId: str }),
  tool('import_protocol', 'Read a found manufacturer PDF into the protocol library ONLY when the user wants to prepare/use it. Does not activate it. Reuse an existing protocolId instead whenever possible.', { url: str }, ['url']),
  tool('show_card', 'Display a computed assay card beside the answer. Does not change the run. Use only when a card helps. Counts may come from the conversation or calculate_plan.', {
    kind: { type: 'string', enum: ['plate', 'reagent', 'standards', 'step', 'timer'] }, samples: number,
    replicates: { ...number, description: 'Sample replicate count; omitted counts use the current run.' },
    standardReplicates: { ...number, description: 'Standard replicate count. Omit to preserve the current standard count, independently of sample replicates.' }, stepId: str,
  }, ['kind']),
  tool('perform_action', 'Carry out a change or UI operation the user requested, including accepting a clearly identified prior suggestion. Questions, comparisons and hypotheticals are NOT requests to change a run. Actual browser execution must finish before you report success. Independent lookups may be parallel; changes execute in order.', actionProperties, ['type']),
  tool('propose_action', 'Remember a specific proposed change WITHOUT executing it, for a later “yes, do that”. Returns a proposalId. Use when the user is deciding; do not require a second confirmation for an already clear request.', actionProperties, ['type']),
  tool('accept_proposal', 'Apply a specific previously proposed change after the user accepts it in context. If more than one proposal could be meant, ask which one.', { proposalId: str }, ['proposalId']),
];

const ActionArgs = z.object({
  type: z.enum(ACTION_TYPES), target: z.string().max(100).optional(), value: z.number().finite().optional(),
  to: z.string().max(200).optional(), text: z.string().max(300).optional(), yes: z.boolean().optional(), standardReplicates: z.int().min(1).max(MAX_REPLICATES).optional(),
}).strict();

export function actionFromArguments(raw: unknown, context: ConverseContext): Action {
  // At minimal effort the model sometimes puts the operation in `target` ({"target":"nextStep"}): the same request.
  const given = raw && typeof raw === 'object' ? raw as Json : {};
  const a = ActionArgs.parse(!given.type && (ACTION_TYPES as readonly string[]).includes(given.target) ? { ...given, type: given.target, target: undefined } : raw);
  let action: unknown;
  switch (a.type) {
    case 'setSamples': action = { type: a.type, samples: a.value }; break;
    case 'setReplicates': action = { type: a.type, replicates: a.value, ...(a.standardReplicates !== undefined ? { standardReplicates: a.standardReplicates } : {}) }; break;
    case 'moveWell': action = { type: a.type, from: a.target, ...(a.to ? { to: a.to } : {}) }; break;
    case 'addWell': action = { type: a.type, what: a.text, ...(a.to ? { well: a.to } : {}) }; break;
    case 'addCondition': action = { type: a.type, name: a.text }; break;
    case 'navigate': action = { type: a.type, to: a.to }; break;
    case 'openProtocol': action = { type: a.type, protocolId: a.target }; break;
    case 'answer': action = { type: a.type, yes: a.yes }; break;
    case 'startRun': action = { type: a.type, ...(a.target ? { protocolId: a.target } : {}), ...(a.yes ? { now: true } : {}) }; break;
    case 'startTimer': {
      const p = context.protocolId ? loadProtocol(context.protocolId) : null;
      const step = p ? procedureFor(p, context.procedure).steps.find(s => s.id === a.target) : undefined;
      const unit = { s: 1, min: 60, h: 3600 };
      const seconds = a.value ?? context.lengths?.[a.target ?? ''] ?? (step?.timer ? step.timer.duration.value * unit[step.timer.duration.unit] : undefined);
      action = { type: a.type, id: a.target, seconds };
      break;
    }
    case 'setStepTime': action = { type: a.type, id: a.target, seconds: a.value }; break;
    case 'markDone': case 'redo': case 'stopTimer': case 'resumeTimer': action = { type: a.type, id: a.target }; break;
    default: action = { type: a.type };
  }
  return ActionSchema.parse(action) as Action;
}

export type ToolResult = { data: unknown; sources?: Source[]; a2ui?: A2uiMessage[] };

export function currentProtocol(context: ConverseContext) {
  const p = context.protocolId ? loadProtocol(context.protocolId) : null;
  if (!p) throw new Error('No current protocol. Ask which experiment to plan, or look up its manual first.');
  return p;
}

function planFor(context: ConverseContext, counts: { samples?: number; replicates?: number; standardReplicates?: number } = {}) {
  const p = currentProtocol(context);
  return { p, plan: {
    procedure: procedureFor(p, context.procedure).id,
    samples: counts.samples ?? context.samples ?? 12,
    replicates: counts.replicates ?? context.replicates ?? 2,
    standardReplicates: counts.standardReplicates ?? context.standardReplicates ?? context.replicates ?? 2,
    standards: context.standards ?? 'kit' as const,
    edits: context.edits,
  } };
}

function layoutFor(plan: ReturnType<typeof planFor>['plan'], setup: ReturnType<typeof runSetup>) {
  // Different replicate counts reserve separate column blocks. Total wells alone cannot establish that a plan fits.
  // editPlate reports retained cells as its well count, so also detect missing/overlapping wells after edits.
  const wells = standardsOf(setup.series.vials).length * plan.standardReplicates + plan.samples * plan.replicates
    + (plan.edits?.added.reduce((sum, added) => sum + added.wells.length, 0) ?? 0);
  const placedWells = setup.plate.cells.length;
  const fits = setup.plate.fits && placedWells === wells && new Set(setup.plate.cells.map(cell => cell.well)).size === placedWells;
  return { wells, placedWells, capacity: setup.plate.rows * setup.plate.cols, fits };
}

export function calculatePlan(raw: unknown, context: ConverseContext): ToolResult {
  const counts = z.object({
    samples: z.int().min(1).max(MAX_SAMPLES).optional(), replicates: z.int().min(1).max(MAX_REPLICATES).optional(),
    standardReplicates: z.int().min(1).max(MAX_REPLICATES).optional(),
  }).strict().parse(raw);
  const { p, plan } = planFor(context, counts);
  const setup = runSetup(p, plan);
  const layout = layoutFor(plan, setup);
  const values = dataModel(p, plan);
  values.plan.wells = String(layout.wells);
  if (!layout.fits) delete values.reagent; // A truncated layout must not be presented as a complete reagent calculation.
  return { data: { hypothetical: true, plan, values, ...layout, ...(!layout.fits ? { problem: 'The requested wells cannot all be placed without overlap in this plate layout. Adjust the plan before preparing reagents.' } : {}) }, sources: manualSources(p) };
}

function analyzeResults(raw: unknown, context: ConverseContext): ToolResult {
  z.object({}).strict().parse(raw);
  const { p, plan } = planFor(context);
  const setup = runSetup(p, plan);
  if (!layoutFor(plan, setup).fits) throw new Error('The current plate layout is incomplete or overlaps. Correct it before analyzing readings.');
  const readings = context.readings ?? {};
  const { roles } = setup;
  const hasReading = (well: string) => Number.isFinite(readings[well]);
  if (!roles.some(role => hasReading(role.well))) throw new Error('There are no readings for the current plate. Import readings before analyzing results.');
  const blanks = roles.filter(role => role.blank);
  if (blanks.length && !blanks.some(role => hasReading(role.well))) throw new Error('All blank readings are missing. Add the blank readings before calculating blank-corrected concentrations.');
  const analysis = analyzeRun(p, roles, readings);
  if (!analysis) throw new Error('The available standard readings cannot form a calibration curve. Check the standards and their readings.');
  const missing = roles.filter(role => !hasReading(role.well));
  return { data: {
    readingsFrom: context.readingsFrom ?? 'unknown', sampleData: context.readingsFrom === 'sample',
    concentrationUnit: unitOf(p, plan.procedure), fitRequested: analysisOf(p).fit,
    ...analysis,
    missingStandardWells: missing.filter(role => role.kind === 'standard').map(role => role.well),
    missingSampleWells: missing.filter(role => role.kind === 'sample').map(role => role.well),
    ignoredReadings: Object.keys(readings).filter(well => !roles.some(role => role.well === well)),
    note: missing.length ? 'Partial readings: calculated values use only the available wells. Missing standards or replicates limit interpretation.' : 'Calculated from the current layout and available readings. No sample dilution factor is assumed.',
  }, sources: manualSources(p) };
}

function calculateSolution(raw: unknown): ToolResult {
  const a = z.object({ kind: z.enum(['dilute', 'weigh']), substance: z.string().optional(), stock: z.string().optional(), concentration: z.string(), volume: z.string(), formulaWeight: z.number().positive().optional() }).strict().parse(raw);
  const c = parseAmount(a.concentration), v = parseAmount(a.volume);
  if (!c || !v || kindOf(v) !== 'volume') throw new Error('A valid target concentration and final volume, with units, are needed.');
  if (a.kind === 'dilute') {
    const s = parseAmount(a.stock ?? '');
    const result = s ? dilute(s, c, v) : null;
    if (!result) throw new Error('Need a compatible stock concentration higher than the target, and a valid final volume.');
    return { data: { inputs: a, ...result, volumeUnit: 'µL', note: 'Use the diluent specified by the experiment; no diluent is assumed.' } };
  }
  let fw = a.formulaWeight;
  if (!fw && a.substance && kindOf(c) === 'molar') {
    const found = lookUp(a.substance);
    if (found.kind === 'which') return { data: { needsClarification: true, substance: a.substance, availableForms: found.forms } };
    if (found.kind !== 'unknown') fw = found.form.fw;
  }
  const grams = weigh(c, v, fw ?? null);
  if (grams === null) throw new Error('Cannot compute this mass: check the concentration units and molecular weight/form of the substance.');
  return { data: { inputs: a, formulaWeight: fw, grams, note: 'Final volume, not volume of solvent added. Follow the documented solvent and preparation method.' } };
}

export function runLocalTool(name: string, raw: unknown, context: ConverseContext): ToolResult {
  if (name === 'read_run') {
    z.object({}).strict().parse(raw);
    return { data: { current: context, protocols: knownProtocols().map(p => ({ id: p.id, title: p.title, kit: p.kit.name, vendor: p.kit.vendor })) } };
  }
  if (name === 'read_protocol') {
    const { protocolId } = z.object({ protocolId: z.string().max(100).optional() }).strict().parse(raw);
    const p = protocolId ? loadProtocol(protocolId) : currentProtocol(context);
    if (!p) throw new Error('That protocol is not in the library.');
    return { data: { id: p.id, source: p.source, content: protocolBrief(p, { ...context, protocolId: p.id }) }, sources: manualSources(p) };
  }
  if (name === 'calculate_plan') return calculatePlan(raw, context);
  if (name === 'calculate_solution') return calculateSolution(raw);
  if (name === 'analyze_results') return analyzeResults(raw, context);
  if (name === 'show_card') {
    const a = z.object({ kind: z.enum(['plate', 'reagent', 'standards', 'step', 'timer']), samples: z.int().min(1).max(MAX_SAMPLES).optional(), replicates: z.int().min(1).max(MAX_REPLICATES).optional(), standardReplicates: z.int().min(1).max(MAX_REPLICATES).optional(), stepId: z.string().optional() }).strict().parse(raw);
    const p = currentProtocol(context);
    const steps = procedureFor(p, context.procedure).steps;
    if (a.kind === 'step' || a.kind === 'timer') {
      const step = steps.find(s => s.id === a.stepId);
      if (!step || (a.kind === 'timer' && !step.timer)) throw new Error('Choose an existing step (with a timer for a timer card).');
    }
    const component = { plate: 'PlateCard', reagent: 'ReagentCard', standards: 'StandardsCard', step: 'StepCard', timer: 'TimerCard' }[a.kind];
    const isPlan = ['plate', 'reagent', 'standards'].includes(a.kind);
    const { plan } = planFor(context, a);
    // Keep the card's counts identical to its tool calculation, even if the live run changes later.
    const props = isPlan ? { samples: plan.samples, replicates: plan.replicates, standardReplicates: plan.standardReplicates } : a.stepId ? { stepId: a.stepId } : {};
    const a2ui: A2uiMessage[] = [
      { version: 'v0.9', createSurface: { surfaceId: 'answer', catalogId: 'chapp' } },
      { version: 'v0.9', updateComponents: { surfaceId: 'answer', components: [{ id: 'root', component, ...props }] } },
    ];
    const numbers = isPlan ? calculatePlan(props, context).data : undefined;
    return { data: { displayed: a.kind, values: numbers }, a2ui };
  }
  throw new Error(`Unknown tool: ${name}`);
}

/** Proposal targets are tied to the experiment the user was discussing. Timers ticking do not invalidate them. */
export const proposalState = (c: ConverseContext) => JSON.stringify({ protocolId: c.protocolId, procedure: c.procedure, step: c.step, samples: c.samples, replicates: c.replicates, standardReplicates: c.standardReplicates, standards: c.standards, lengths: c.lengths, edits: c.edits });
