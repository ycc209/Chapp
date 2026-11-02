import { z } from 'zod';
import type { A2uiMessage } from '../../shared/a2ui.ts';
import { Protocol } from '../../shared/protocol.ts';
import type { ConverseReply, ConverseRequest, Expression, FindProtocolRequest, ProtocolPreview } from '../../shared/ai.ts';

/**
 * Runtime checks for what crosses the server's edge: requests from the phone, and replies before they go back to it
 * (a model's output included). Each schema `satisfies` its shared/ai.ts type, so the two cannot drift apart.
 */

export const expressions = ['neutral', 'happy', 'thinking', 'excited', 'surprised', 'sad', 'wink', 'sleepy', 'listen'] as const satisfies readonly Expression[];

/** Screens Chapp may send the user to. The run screen is left out: Chapp moves through it with nextStep/previousStep. */
export const routes = ['/', '/protocol', '/kit', '/plan', '/results', '/share', '/import', '/library'] as const;

/** A 96-well plate bounds both numbers; the app checks the exact fit with calc.ts. */
export const MAX_SAMPLES = 96;
export const MAX_REPLICATES = 4;
/** A step's length the user may set: up to a week (a 72 h differentiation step, a 3-day culture). */
export const MAX_STEP_SECONDS = 7 * 24 * 3600;

export const ConverseRequestSchema = z.object({
  text: z.string().trim().min(1, 'say something').max(12000),
  context: z.object({
    screen: z.string().max(200),
    protocolId: z.string().max(100).nullish(),
    previewProtocolId: z.string().max(100).optional(),
    procedure: z.string().max(100).optional(),
    step: z.int().min(0).max(1000).optional(),
    stepTitle: z.string().max(200).optional(),
    samples: z.int().min(0).max(1000).optional(),
    replicates: z.int().min(0).max(100).optional(),
    standardReplicates: z.int().min(0).max(100).optional(),
    standards: z.enum(['kit', 'halve', 'five', 'ready']).optional(),
    timers: z.array(z.object({ id: z.string().max(100), secondsLeft: z.int().min(0).max(7 * 24 * 3600) })).max(20).optional(),
    readingsFrom: z.enum(['sample', 'plate']).nullish(),
    shown: z.object({ samples: z.int().min(1).max(MAX_SAMPLES), replicates: z.int().min(1).max(MAX_REPLICATES), standardReplicates: z.int().min(1).max(MAX_REPLICATES).optional() }).optional(),
    lengths: z.record(z.string().max(100), z.int().min(1).max(MAX_STEP_SECONDS)).optional(),
    edits: z
      .object({
        moved: z.record(z.string().max(4), z.string().max(4)),
        added: z.array(z.object({ name: z.string().max(60), of: z.string().max(10).optional(), wells: z.array(z.string().max(4)).max(8) })).max(48),
      })
      .optional(),
    paused: z.array(z.object({ id: z.string().max(100), secondsLeft: z.int().min(0).max(7 * 24 * 3600) })).max(20).optional(),
    options: z.record(z.string().max(100), z.array(z.int().min(1).max(MAX_STEP_SECONDS)).max(6)).optional(),
    pending: z.string().max(200).optional(),
    planned: z.boolean().optional(),
    startCard: z.boolean().optional(),
    events: z.array(z.string().max(160)).max(12).optional(),
    elsewhere: z.array(z.object({ experiment: z.string().max(120), step: z.string().max(100), secondsLeft: z.int().min(0).max(7 * 24 * 3600) })).max(8).optional(),
    done: z.record(z.string().max(100), z.boolean()).optional(),
    readings: z.record(z.string().max(10), z.number().finite()).optional(),
  }),
  history: z.array(z.object({ role: z.enum(['user', 'chapp']), text: z.string().max(24000) })).max(64).optional(),
  previousResponseId: z.string().trim().min(1).max(200).optional(),
  summary: z.string().max(24000).optional(),
  continuationToken: z.string().min(1).max(200).optional(),
  toolResults: z.array(z.object({ callId: z.string().min(1).max(100), ok: z.boolean(), message: z.string().max(4000) })).max(12).optional(),
}) satisfies z.ZodType<ConverseRequest>;

export const FindProtocolRequestSchema = z.object({
  query: z.string().trim().min(2, 'name a kit').max(500),
}) satisfies z.ZodType<FindProtocolRequest>;

const Id = z.string().trim().min(1).max(100);
/** A well of a plate up to 384 wells: "B3", "H12". */
const Well = z.string().trim().toUpperCase().regex(/^[A-P](?:[1-9]|1\d|2[0-4])$/);

export const ActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('navigate'), to: z.enum(routes) }),
  z.object({ type: z.literal('setSamples'), samples: z.int().min(1).max(MAX_SAMPLES) }),
  z.object({ type: z.literal('setReplicates'), replicates: z.int().min(1).max(MAX_REPLICATES), standardReplicates: z.int().min(1).max(MAX_REPLICATES).optional() }),
  z.object({ type: z.literal('nextStep') }),
  z.object({ type: z.literal('previousStep') }),
  z.object({ type: z.literal('markDone'), id: Id }),
  z.object({ type: z.literal('startTimer'), id: Id, seconds: z.int().min(1).max(MAX_STEP_SECONDS) }),
  z.object({ type: z.literal('setStepTime'), id: Id, seconds: z.int().min(1).max(MAX_STEP_SECONDS) }),
  z.object({ type: z.literal('redo'), id: Id }),
  z.object({ type: z.literal('moveWell'), from: Well, to: Well.optional() }),
  z.object({ type: z.literal('addWell'), what: z.string().trim().min(1).max(60), well: Well.optional() }),
  z.object({ type: z.literal('addCondition'), name: z.string().trim().min(1).max(60) }),
  z.object({ type: z.literal('findProtocol'), query: z.string().trim().min(2).max(300) }),
  z.object({ type: z.literal('stopTimer'), id: Id }),
  z.object({ type: z.literal('resumeTimer'), id: Id }),
  z.object({ type: z.literal('takePhoto') }),
  z.object({ type: z.literal('useSample') }),
  z.object({ type: z.literal('answer'), yes: z.boolean() }),
  z.object({ type: z.literal('undo') }),
  z.object({ type: z.literal('openProtocol'), protocolId: Id }),
  z.object({ type: z.literal('startRun'), protocolId: Id.optional(), now: z.boolean().optional() }),
]);

const A2uiComponentSchema = z.looseObject({ id: z.string().min(1).max(80), component: z.string().min(1).max(40) });
const A2uiMessageSchema = z.union([
  z.object({ version: z.literal('v0.9'), createSurface: z.object({ surfaceId: z.string(), catalogId: z.string() }) }),
  z.object({ version: z.literal('v0.9'), updateComponents: z.object({ surfaceId: z.string(), components: z.array(A2uiComponentSchema).max(40) }) }),
]) as unknown as z.ZodType<A2uiMessage>;

export const SourceSchema = z.object({
  url: z.url(),
  title: z.string().optional(),
  quote: z.string().optional(),
  page: z.int().positive().optional(),
});

const ProtocolIntroSchema = z.object({
  title: z.string(), summary: z.string(),
  kit: z.object({ name: z.string(), vendor: z.string(), catalogs: z.array(z.string()) }),
  source: Protocol.shape.source.pick({ title: true, publisher: true, docId: true, revision: true, url: true }).extend({ url: z.string() }),
  overview: Protocol.shape.overview.pick({ steps: true, expected: true, cite: true }),
  procedure: z.object({ name: z.string(), steps: z.array(z.object({ text: z.string(), page: z.int().positive() })), others: z.array(z.string()) }),
  contents: z.array(z.object({ name: z.string(), amount: z.string() })),
});
export const ProtocolPreviewSchema = z.object({
  id: z.string().min(1).max(200), state: z.enum(['reading', 'ready', 'error']), title: z.string().optional(),
  source: SourceSchema.extend({ url: Protocol.shape.source.shape.url }).optional(),
  intro: ProtocolIntroSchema.optional(), protocolId: z.string().min(1).max(100).optional(),
  progress: z.array(z.string()).max(12).optional(), error: z.string().optional(),
}).refine(value => value.state !== 'ready' || Boolean(value.protocolId), 'A ready preview must identify its saved protocol.') satisfies z.ZodType<ProtocolPreview>;

export const ConverseReplySchema = z.object({
  say: z.string().max(24000),
  expression: z.enum(expressions).optional(),
  actions: z.array(ActionSchema).max(12),
  confirm: z.array(ActionSchema).max(12).optional(),
  // Built by shared/a2ui.ts checkA2ui: a createSurface and one updateComponents.
  a2ui: z.array(A2uiMessageSchema).max(2).optional(),
  sources: z.array(SourceSchema).max(24),
  responseId: z.string().max(200).optional(),
  pendingTools: z.array(z.object({ callId: z.string().min(1).max(100), action: ActionSchema })).min(1).max(12).optional(),
  continuationToken: z.string().min(1).max(200).optional(),
  protocolPreview: ProtocolPreviewSchema.optional(),
}).superRefine((reply, ctx) => {
  if (!reply.say.trim() && !reply.pendingTools?.length) {
    ctx.addIssue({ code: 'custom', path: ['say'], message: 'An answer or pending tool operation is required.' });
  }
  if (Boolean(reply.pendingTools?.length) !== Boolean(reply.continuationToken)) {
    ctx.addIssue({ code: 'custom', path: ['continuationToken'], message: 'Pending tools and their continuation token must be supplied together.' });
  }
}) satisfies z.ZodType<ConverseReply>;

/** "text: Too small…; context.screen: Required": short enough for a 400 body. */
export const describeIssues = (error: z.ZodError) =>
  error.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
