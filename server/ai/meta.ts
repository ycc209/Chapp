import { z } from 'zod';
import { checkA2ui, componentsOf, dataPaths, numbersIn, type A2uiMessage } from '../../shared/a2ui.ts';
import type { Action, AIProvider, ConverseContext, ConverseReply, Expression, FindProtocolLive, FoundProtocol, Source, Transcript } from '../../shared/ai.ts';
import type { Protocol } from '../../shared/protocol.ts';
import { dataModel } from '../../src/components/a2ui/data.ts';
import type { RunPlan } from '../../src/components/lab/model.ts';
import { procedureFor } from '../../src/screens/protocol/content.ts';
import { readEvents } from '../../shared/sse.ts';
import { distance, fixLabWords, labTerms, needsModelFix } from '../../src/voice/labWords.ts';
import { UpstreamError } from './provider.ts';
import { metaReadPlate } from './plate.ts';
import { importProtocol } from './import.ts';
import { createKitVision } from './vision.ts';
import { authorize, claimsChange, type Rules } from './authorize.ts';
import { ActionSchema, ConverseReplySchema, describeIssues, expressions, MAX_REPLICATES, routes } from './schema.ts';
import { solutionReply } from './solution.ts';
import { ASR_MODEL, keywords, LANGUAGES, toTaiwan } from './speech.ts';
import { cleanSvg, DRAW_INSTRUCTIONS, layoutFor } from './picture.ts';
import { answerFromManual, knownProtocols, loadProtocol, localProtocolId, manualSources, protocolBrief, WAYS } from './protocols.ts';

/**
 * Meta's models behind the AIProvider interface: Muse Spark for conversation and for finding a kit's manual on the
 * web, Muse Voice Transcribe for speech. Call shapes follow scripts/smoke-meta.ts and scripts/find-protocol.ts, which
 * were checked against the live API. Nothing here logs the key, a prompt or what the user said: only timings.
 */

const MODEL = 'muse-spark-1.3';

/**
 * How hard Muse Spark thinks before it answers (minimal, low, medium, high, xhigh, max; high when not sent). Thinking
 * is most of the wait. On 2026-10-28 the storyboard's eight lines (scripts/converse-smoke.ts) took a median 7.0 s
 * (max 8.1) at high, 1,000–2,000 reasoning tokens each; 2.4 s (max 4.6) at low; 1.7 s (max 2.6) at minimal, about 200
 * tokens, with the same actions and manual pages every time.
 */
export const EFFORT = { converse: 'minimal', findProtocol: 'low', fixTranscript: 'minimal', drawStep: 'medium' } as const;
export type Effort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * One converse call's wait. Answers take 1.5–4 s; on 2026-10-29 one call hung for the whole 30 s and the user saw an
 * error, so a call that has not answered by now is asked again while the turn has time.
 */
const ATTEMPT_MS = 12_000;

export type MetaOptions = {
  apiKey: string;
  baseUrl?: string;
  /** Injected by tests; the global fetch otherwise. */
  fetch?: typeof fetch;
  log?: (line: string) => void;
  /** Milliseconds per operation. A converse retry shares its first attempt's budget; `attempt` caps each try. */
  timeouts?: { converse?: number; findProtocol?: number; transcribe?: number; attempt?: number; draw?: number };
  /** Overrides EFFORT, for measuring (scripts/converse-smoke.ts --effort). */
  effort?: Partial<Record<keyof typeof EFFORT, Effort>>;
};

type Json = Record<string, any>;

// ---------------------------------------------------------------------------------------------------------------
// Converse: Muse Spark answers in a strict JSON schema, which we turn into a ConverseReply and check with zod.

const replyExpressions = expressions.filter(e => e !== 'listen');
const actionTypes = ['navigate', 'setSamples', 'setReplicates', 'nextStep', 'previousStep', 'markDone', 'redo', 'startTimer', 'setStepTime', 'moveWell', 'addWell', 'addCondition', 'findProtocol'] as const;

/**
 * The wire format the model fills. Flat objects with every field required (unused ones "" or 0) are what strict
 * json_schema reliably supports, as the GenUI test on 2026-10-28 showed; the union types live in shared/ai.ts. The
 * A2UI goes inside a string: its components are too free-form for a strict schema, and Muse Spark writes it well there
 * (6 of 8 questions fully valid on 2026-10-29, the other 2 off only in "version", which checkA2ui puts right).
 */
export const replyFormat = {
  type: 'json_schema',
  json_schema: {
    name: 'ChappReply',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['say', 'expression', 'actions', 'a2ui', 'manualPages', 'general', 'calc'],
      properties: {
        say: { type: 'string' },
        expression: { type: 'string', enum: replyExpressions },
        actions: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['type', 'to', 'value', 'id', 'query'],
            properties: {
              type: { type: 'string', enum: actionTypes },
              to: { type: 'string', enum: ['', ...routes] },
              value: { type: 'integer' },
              id: { type: 'string' },
              query: { type: 'string' },
            },
          },
        },
        a2ui: { type: 'string' },
        manualPages: { type: 'array', items: { type: 'integer' } },
        general: { type: 'boolean' },
        calc: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'substance', 'concentration', 'volume', 'stock', 'formulaWeight'],
          properties: {
            kind: { type: 'string', enum: ['', 'weigh', 'dilute'] },
            substance: { type: 'string' },
            concentration: { type: 'string' },
            volume: { type: 'string' },
            stock: { type: 'string' },
            formulaWeight: { type: 'string' },
          },
        },
      },
    },
  },
};

// Lenient on purpose: one bad action or component is dropped (fromWire) rather than costing the whole reply a retry.
const Wire = z.object({
  say: z.string(),
  expression: z.string().optional(),
  actions: z.array(z.object({ type: z.string(), to: z.string().default(''), value: z.number().default(0), id: z.string().default(''), query: z.string().default('') })).default([]),
  a2ui: z.unknown().default(''),
  manualPages: z.array(z.number()).default([]),
  general: z.boolean().default(false),
  calc: z
    .object({ kind: z.string().default(''), substance: z.string().default(''), concentration: z.string().default(''), volume: z.string().default(''), stock: z.string().default(''), formulaWeight: z.string().default('') })
    .default({ kind: '', substance: '', concentration: '', volume: '', stock: '', formulaWeight: '' }),
});
type Wire = z.infer<typeof Wire>;

/** The screens that draw Chapp's cards under its words (Chat and the protocol); every other one shows only the words. */
export const CARD_SCREENS = new Set(['chat', 'protocol']);

/** "12 min 5 s", "30 s". */
const left = (seconds: number) => [Math.floor(seconds / 60) && `${Math.floor(seconds / 60)} min`, seconds % 60 && `${seconds % 60} s`].filter(Boolean).join(' ') || '0 s';

/** The app's state the model should know, in a line: what is on screen and what is going on at the bench. */
function rightNow(context: ConverseContext): string {
  const timers = (context.timers ?? []).map(t => (t.secondsLeft > 0 ? `timer ${t.id} running, ${left(t.secondsLeft)} left` : `timer ${t.id} has rung`));
  const readings = { sample: 'plate readings: sample data (the built-in example export, not the user’s plate)', plate: 'plate readings: the user’s own', none: 'no plate readings yet' };
  return [
    `screen "${context.screen}"`,
    `protocol ${context.protocolId ?? 'none'}`,
    context.step !== undefined ? `step index ${context.step}${context.stepTitle ? ` (${context.stepTitle})` : ''}` : '',
    context.samples !== undefined ? `${context.samples} samples` : '',
    context.replicates !== undefined ? `${context.replicates} replicates` : '',
    context.standards ? `standards: ${WAYS[context.standards]}${context.standardReplicates ? ` × ${context.standardReplicates}` : ''}` : '',
    ...timers,
    ...Object.entries(context.lengths ?? {}).map(([id, seconds]) => `step ${id} is ${seconds >= 3600 ? `${+(seconds / 3600).toFixed(2)} h` : left(seconds)} for this run (the user's choice)`),
    ...Object.entries(context.edits?.moved ?? {}).map(([bad, to]) => `well ${bad} went wrong, its contents are in ${to}`),
    ...(context.edits?.added ?? []).map(a => `added during the run: ${a.of ? `another well of ${a.of}` : `"${a.name}"`} in ${a.wells.join(', ')}`),
    context.readingsFrom !== undefined ? readings[context.readingsFrom ?? 'none'] : '',
  ]
    .filter(Boolean)
    .join(', ');
}

/** The steps of the protocol on screen (its procedure for this run), which A2UI step cards and paths refer to. */
const stepsOf = (protocol: Protocol | null, context: ConverseContext) => (protocol ? procedureFor(protocol, context.procedure).steps : []);

/** On a screen that draws no cards: only words, and nothing that points at a card. */
const NO_CARDS = '- a2ui: "[]". This screen shows only your words: never point to a card or to anything "below".';

/**
 * How Muse Spark draws under its answer: A2UI v0.9 with Chapp's catalog, values only by binding to the app's data. With
 * no kit open there is nothing to bind to: only words and a choice to pick from.
 */
const A2UI_RULES = (paths: string[] | null) =>
  `- a2ui: when a picture or a choice helps more than words, UI under the answer as A2UI v0.9 messages: a JSON array written inside this string, else "[]". Each message is {"version":"v0.9", <one key>}: first {"createSurface":{"surfaceId":"answer","catalogId":"chapp"}}, then {"updateComponents":{"surfaceId":"answer","components":[...]}}, a flat list; each component {"id":"...","component":"<type>", ...its properties}; one has id "root"; parents name their children by id with "child" (one) or "children" (a list of ids). Never send updateDataModel: the app fills the data model.
  Components: Column, Row, List (children) · Card (child) · Divider · Text (text, variant: h3 | body | caption) · ChoicePicker (options: 2–4 of {"label","value"}: what the user may pick; a tap sends the label as their answer. For a choice of words, such as which kit they meant when a name or catalog number may be misheard: say what you understood and offer it with the likely alternatives)${paths ? ` · Chapp's own: ReagentCard (how much working reagent to make), PlateCard (where everything goes on the plate), StandardsCard (the dilution table), StepCard (stepId), TimerCard (stepId of a timed step: how long, how hot), Compare (need: the volume needed, as a binding such as {"path":"/reagent/make"}; have: the amount the user says they have, as they said it: "15 mL"), Ask (fields: some of samples, replicates, standards). ReagentCard, PlateCard and Compare take samples and replicates only when the user names numbers other than this run's; the user can change them on the card. Use Chapp's own components when one fits; compose basic ones when none does; one card is usually enough.
  Ask: when the user wants to plan or set up the run ("plan my run", "help me get ready"), ask with Ask before drawing the plan: the app fills in this run's values and the user changes them or taps Continue. Don't answer and ask at once. Otherwise answer for this run's plan: the user can change the numbers on the card.
  Never write a number in a2ui yourself (only the user's own words, in "have"): show a value by binding a property to the data model, {"path":"/reagent/make"}. Paths: ${paths.join(', ')}.` : '. No kit is open: nothing else to draw.'}`;

// Characters only Simplified Chinese writes (Traditional has 這們來個說嗎…): a message with any is answered in Simplified.
const SIMPLIFIED = /[这们来个说吗为时间后样钟运仅帮试剂盒册还过让请问题对开关发现进经较应给从买卖书车东头话网页实验温标读离准]/;

/**
 * The language to answer in, decided here from the user's own words (Notos's lesson, and Muse Spark answered a
 * Traditional Chinese question in Simplified twice on 2026-10-29): Traditional Chinese as used in Taiwan unless the
 * message is written in Simplified; English when it has no Chinese.
 */
export function replyLanguage(text: string): string {
  if (!/[㐀-鿿]/.test(text)) return 'English';
  return SIMPLIFIED.test(text) ? 'Simplified Chinese' : 'Traditional Chinese as used in Taiwan (繁體中文)';
}

/**
 * Muse Spark's instructions for one turn. What never changes comes first and the run's state last, so consecutive
 * turns share a long prefix the API can cache. The language to answer in comes last of all, from the user's words.
 */
export function systemPrompt(context: ConverseContext, text?: string): string {
  const library = knownProtocols();
  const current = context.protocolId ? loadProtocol(context.protocolId) : null;
  return `You are Chapp, a calm lab companion at the bench: a labmate to one person, who helps them run a lab kit, answers their lab questions and chats with them. What you say is shown under the user's words, beside any card you draw.

Reply in JSON:
- say: one or two short sentences (three for how to do something or fix a problem). No lists, markdown or URLs. Use the language of the user's message: English stays English; Chinese gets Traditional Chinese as used in Taiwan, unless they wrote Simplified.
- say never claims you changed, set, started or moved anything: the app shows what it did, or asks the user to confirm.
- Numbers about this kit or this run only from the facts and this run's numbers below, or the user's own words. Never work a new number out yourself: the card does that. When your card shows the amount, say points to it ("Here's what to mix for 30 samples.") instead of repeating it. When the user asks how to do an experiment (its steps, times, temperatures, amounts or concentrations), the answer is in the manual of the kit or reagent they use: if you don't have it, say so; when you know which kit, find it (findProtocol); otherwise ask which kit or reagent they use. Never guess an experiment's numbers, not even typical ones.
- Small talk, how the user's day is going, what something is or why it works, and what may have gone wrong: answer as a labmate would, from what is commonly known, and ask what they used when it matters.
- general: true when the answer is small talk or general knowledge, not this kit's manual or this run: the app marks any number in it as general knowledge, not the manual's. Otherwise false.
- manualPages: the page (p.N) of each manual fact your answer uses; none when you used none.
- expression: happy (greeting, good news), thinking (unsure, asking back), excited (a milestone), sad (bad news), sleepy (a long wait), surprised, wink (a light joke), else neutral.
- actions: only what the user asks for or clearly means, usually none; unused fields "" or 0. navigate (to: ${routes.join(' ')}) · setSamples (value) · setReplicates (value 1–${MAX_REPLICATES}; samples and standards) · nextStep · previousStep · markDone (id: a standard's letter, a sample's number or a step id; several at once separated by commas: "A,B,C,D") · redo (id: a standard's letter or a sample's number to make or load again, several by commas; the app redoes the vials made from it too) · moveWell (id: the well that went wrong, as "B3"; query: the well the user names for its contents, else "" and the app picks a free one) · addWell (query: what the extra well is for, as the user said it, or "sample 3" / "B" for one more well of that sample or standard; id: the well, only if the user named one) · addCondition (query: the new condition's name as the user said it: one more sample with this run's replicates) · startTimer (id: the step id, value 0: the app knows its length) · setStepTime (id: a timed step's id, value: the new length in seconds, as the user said it): whenever the user asks to change how long a step takes, send it at once; the app shows them a card to confirm (this run only), so say only asks ("Make step 4 24 hours for this run?") · findProtocol (query: the kit as the user named it: vendor, kit name, catalog number). A change the user did not plainly ask for becomes a button they tap. For redo, moveWell, addWell and addCondition the app picks the wells and shows what to do, so say only acknowledges ("Got it, here's where it goes.") and names no well the user did not say.
- calc: when the user asks how to make a solution that is not this kit's own reagent: how much of a solid to weigh (kind "weigh": substance as the user named it, concentration such as "1 M", "5 mg/mL" or "2 %", volume such as "100 mL", formulaWeight only if the user said one) or how to dilute a stock (kind "dilute": stock such as "10X" or "1 M", concentration: the one they want, volume: how much they want, substance if named). Copy the user's own numbers and units, "" for any they did not say, and work nothing out: the app answers with its own numbers, so say "" and a2ui "[]". Otherwise kind "".
${CARD_SCREENS.has(context.screen) ? A2UI_RULES(current ? dataPaths(stepsOf(current, context)) : null) : NO_CARDS}
- The user names a kit to run, or asks for a kit's manual or protocol, whether you have it or not: findProtocol for that kit and say you are looking up its manual; no navigate, the app opens the search. Don't ask first. The same for a reagent named with its brand or catalog number (TRIzol, Invitrogen DAPI D1306): findProtocol finds its manual, or its product page when it has none. A reagent named without either (trypsin, PBS, DAPI): ask which brand or catalog number they have, offering the usual ones where you can draw a choice, then findProtocol. "Yes" or "find it" after a kit was named earlier in the conversation means that kit. A greeting: greet back and suggest what to say next.
- Plate readings that are sample data are an example, not the user's results: say so when you talk about them.

Protocols you have: ${library.map(p => `${p.id} (${p.kit.name}, ${p.kit.vendor})`).join('; ') || 'none yet'}.${current ? `\n\n${protocolBrief(current, context)}` : '\n\nNo kit is open in this conversation: don\'t assume one.'}

Right now: ${rightNow(context)}.${text ? `\n\nAnswer in ${replyLanguage(text)}.` : ''}`;
}

/** "A,B, C" → each id: one markDone or redo per vial or tube named. */
const ids = (id: string) => id.split(/[,，、\s]+/).map(x => x.trim()).filter(Boolean);

/** The wire's flat action → the app's Actions (one per id named), or [] for a type the app does not know. */
function toActions(a: Wire['actions'][number]): (Action | null)[] {
  if (a.type === 'markDone') return ids(a.id).map(id => ({ type: 'markDone', id }));
  if (a.type === 'redo') return ids(a.id).map(id => ({ type: 'redo', id }));
  return [toAction(a)];
}

function toAction(a: Wire['actions'][number]): Action | null {
  switch (a.type) {
    case 'navigate': return { type: 'navigate', to: a.to };
    case 'setSamples': return { type: 'setSamples', samples: a.value };
    case 'setReplicates': return { type: 'setReplicates', replicates: a.value };
    case 'moveWell': return { type: 'moveWell', from: a.id.trim().toUpperCase(), ...(a.query.trim() ? { to: a.query.trim().toUpperCase() } : {}) };
    case 'addWell': return a.query.trim() ? { type: 'addWell', what: a.query.trim(), ...(a.id.trim() ? { well: a.id.trim().toUpperCase() } : {}) } : null;
    case 'addCondition': return a.query.trim() ? { type: 'addCondition', name: a.query.trim() } : null;
    // The length is the app's (authorize.ts): a 0 here is filled in from the step.
    case 'startTimer': return { type: 'startTimer', id: a.id, seconds: Math.max(1, a.value) };
    case 'setStepTime': return { type: 'setStepTime', id: a.id, seconds: a.value };
    case 'nextStep': return { type: 'nextStep' };
    case 'previousStep': return { type: 'previousStep' };
    case 'findProtocol': return a.query.trim() ? { type: 'findProtocol', query: a.query.trim() } : null;
    default: return null;
  }
}

/** Cuts a long answer at the last sentence that fits, so it still ends cleanly. */
function fit(say: string, max = 600): string {
  const text = say.trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('。'), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return end > 0 ? cut.slice(0, end + 1) : `${cut.slice(0, max - 1)}…`;
}

/** The run's plan from what the app sent (the defaults where it sent none). */
const planOf = (context: ConverseContext, protocol: Protocol): RunPlan => ({
  procedure: procedureFor(protocol, context.procedure).id,
  samples: context.samples || 12,
  replicates: context.replicates || 2,
  standardReplicates: context.standardReplicates || context.replicates || 2,
  standards: context.standards ?? 'kit',
});

/**
 * The numbers Chapp may say: the facts and run numbers it was given (the prompt), the user's words, and what the app
 * works out for the plans its card shows (the run's, and samples or replicates the card names), so the words and the
 * card always agree.
 */
export function sayableNumbers(prompt: string, question: string, protocol: Protocol | null, context: ConverseContext, a2ui: A2uiMessage[]): Set<number> {
  const numbers = new Set([...numbersIn(prompt), ...numbersIn(question, true)]);
  if (protocol) {
    const run = planOf(context, protocol);
    const shown = context.shown ? [{ ...run, samples: context.shown.samples, replicates: context.shown.replicates, standardReplicates: context.shown.replicates }] : [];
    const plans = [run, ...shown, ...[...componentsOf(a2ui).values()].filter(c => typeof c.samples === 'number' || typeof c.replicates === 'number').map(c => ({
      ...run,
      ...(typeof c.samples === 'number' ? { samples: c.samples } : {}),
      ...(typeof c.replicates === 'number' ? { replicates: c.replicates, standardReplicates: c.replicates } : {}),
    }))];
    for (const plan of plans) for (const n of numbersIn(JSON.stringify(dataModel(protocol, plan)))) numbers.add(n);
  }
  return numbers;
}

/**
 * Say only numbers that can be checked (sayableNumbers). A sentence with any other number is taken out, rather than
 * shown next to a card that says something else; if nothing is left, a line that points at the card (or says Chapp
 * won't guess) takes its place. Returns the words and how many sentences went.
 */
export function checkSay(say: string, sayable: Set<number>, drawn: boolean): { say: string; removed: number } {
  const sentences = say.split(/(?<=[.!?。！？])\s*/).filter(s => s.trim());
  const kept = sentences.filter(s => numbersIn(s).every(n => sayable.has(n)));
  if (kept.length === sentences.length) return { say, removed: 0 };
  const zh = /[㐀-鿿]/.test(say);
  const fallback = drawn
    ? zh ? '在這裡，照你的計畫算好了。' : 'Here it is, worked out for your plan.'
    : zh ? '這個數字我沒辦法從說明書確認，所以不猜。' : "I can't check that number against the manual, so I won't guess it.";
  return { say: kept.length ? kept.join(zh ? '' : ' ') : fallback, removed: sentences.length - kept.length };
}

/** What a change may name in the protocol on screen: its steps, its timed steps with their lengths, its vials. */
function rulesFor(protocol: Protocol | null, context: ConverseContext): Rules {
  const steps = stepsOf(protocol, context);
  const seconds = { s: 1, min: 60, h: 3600 } as const;
  return {
    steps: steps.map(s => s.id),
    timed: steps.flatMap(s => (s.timer ? [{ id: s.id, seconds: s.timer.duration.value * seconds[s.timer.duration.unit] }] : [])),
    vials: protocol?.standardCurves.flatMap(c => c.points.map(p => p.id.toUpperCase())) ?? [],
    lengths: context.lengths,
    samples: (context.samples ?? 0) + (context.edits?.added.filter(a => !a.of).length ?? 0),
  };
}

/**
 * Take out the sentences that say a change was made when the app made none (claimsChange): the app shows what it
 * did, and Chapp never says it did what the app did not. If nothing is left, a line that says where things stand.
 */
export function checkClaims(say: string, applied: number, waiting: number): { say: string; removed: number } {
  if (applied) return { say, removed: 0 };
  const sentences = say.split(/(?<=[.!?。！？])\s*/).filter(s => s.trim());
  const kept = sentences.filter(s => !claimsChange(s));
  if (kept.length === sentences.length) return { say, removed: 0 };
  const zh = /[㐀-鿿]/.test(say);
  const fallback = waiting ? (zh ? '要我這樣改嗎？' : 'Want me to make that change?') : zh ? '這個我還沒有改。' : "I haven't changed that.";
  return { say: kept.length ? kept.join(zh ? '' : ' ') : fallback, removed: sentences.length - kept.length };
}

/** Said after a general answer's own numbers: general knowledge, not the manual's. */
const TYPICAL = { en: ' (General knowledge, not from a manual.)', zh: '（這是一般知識，不是說明書上的。）', hans: '（这是一般知识，不是说明书上的。）' };
const langKey = (question: string) => {
  const language = replyLanguage(question);
  return language.startsWith('English') ? 'en' : language.startsWith('Simplified') ? 'hans' : 'zh';
};

// Words that send the user to a card: "on the card", "shown below", "Here's what to mix…", "下面卡片".
const POINTS = [
  /\bcards?\b/i,
  /\b(?:see|shown|listed)\s+below\b|\bbelow[:.!]?\s*$/i,
  /^here(?:'s| is| are)\s+(?:what|how much|the (?:plan|amounts?|numbers?|layout|mix))\b|^here it is\b/i,
  /卡片|下面|下方|如下/,
];

/**
 * Take out the sentences that point at a card when none is drawn (the model drew none, it was dropped, or the screen
 * draws none): Chapp never sends the user to look for something that is not there. If nothing is left, it says it
 * won't guess.
 */
export function checkPointers(say: string, drawn: boolean): { say: string; removed: number } {
  if (drawn) return { say, removed: 0 };
  const sentences = say.split(/(?<=[.!?。！？])\s*/).filter(s => s.trim());
  const kept = sentences.filter(s => !POINTS.some(re => re.test(s.trim())));
  if (kept.length === sentences.length) return { say, removed: 0 };
  const zh = /[㐀-鿿]/.test(say);
  const fallback = zh ? '這個我沒辦法確認，所以不猜。' : "I can't check that, so I won't guess.";
  return { say: kept.length ? kept.join(zh ? '' : ' ') : fallback, removed: sentences.length - kept.length };
}

/**
 * The reply the app gets, and what was dropped from the model's on the way (for the log: kinds only, never words).
 * `earlier` is what the user said before in this conversation: a calc may use numbers they gave a turn ago.
 */
function fromWire(wire: Wire, context: ConverseContext, question: string, prompt: string, earlier = ''): { reply: ConverseReply; dropped: string[] } {
  const dropped: string[] = [];
  const open = context.protocolId ? loadProtocol(context.protocolId) : null;

  // Each change checked against what the user said (authorize.ts): made now, waiting for a tap, or not at all.
  const rules = rulesFor(open, context);
  const actions: Action[] = [];
  const confirm: Action[] = [];
  for (const one of wire.actions.flatMap(w => toActions(w).map(action => ({ w, action })))) {
    const a = one.w;
    const parsed = ActionSchema.safeParse(one.action);
    if (!parsed.success) {
      dropped.push(`action ${a.type}`);
      continue;
    }
    const { verdict, action } = authorize(parsed.data as Action, question, rules);
    if (verdict === 'apply') actions.push(action);
    else if (verdict === 'confirm') {
      confirm.push(action);
      dropped.push(`action ${a.type} waits for a tap`);
    } else dropped.push(`action ${a.type} not the user's`);
  }

  // The surface: checked against the protocol on screen (its steps and data paths) and the user's words. No kit open:
  // nothing to bind to, so only words and a choice.
  // The card the user changed by hand counts as their words: a card may show its samples and replicates again.
  const saidOrShown = context.shown ? `${question} (${context.shown.samples} samples × ${context.shown.replicates})` : question;
  const checked = checkA2ui(wire.a2ui, { steps: stepsOf(open, context), said: saidOrShown, kit: Boolean(open) });
  dropped.push(...checked.dropped.map(d => `a2ui ${d}`));
  // A screen without cards would show none: its words alone answer.
  const drawsCards = CARD_SCREENS.has(context.screen);
  if (!drawsCards && checked.messages.length) dropped.push('a2ui (this screen draws no cards)');
  let a2ui = drawsCards ? checked.messages : [];
  // A plan card drawn without numbers of its own shows the card the user changed by hand: that is what they asked about.
  if (context.shown)
    for (const c of componentsOf(a2ui).values())
      if (['ReagentCard', 'PlateCard', 'Compare'].includes(c.component) && c.samples === undefined && c.replicates === undefined) {
        c.samples = context.shown.samples;
        c.replicates = context.shown.replicates;
      }

  // The words agree with the card: numbers only from the facts, the user, or what the app worked out; and no change
  // claimed that the app did not make.
  // A general answer (small talk, what something is, what went wrong) may have numbers of its own: they are marked below
  // as not the manual's, rather than taken out. Anything about an experiment, the kit or the run keeps to its facts.
  const sayable = sayableNumbers(prompt, question, open, context, a2ui);
  const numbers = wire.general ? { say: fit(wire.say), removed: 0 } : checkSay(fit(wire.say), sayable, a2ui.length > 0);
  if (numbers.removed) dropped.push(`say ${numbers.removed} sentence(s) with an unchecked number`);
  const said = checkClaims(numbers.say, actions.filter(a => a.type !== 'navigate' && a.type !== 'findProtocol').length, confirm.length);
  if (said.removed) dropped.push(`say ${said.removed} sentence(s) claiming a change not made`);
  const pointed = checkPointers(said.say, a2ui.length > 0);
  if (pointed.removed) dropped.push(`say ${pointed.removed} sentence(s) pointing at a card not drawn`);
  let say = pointed.say;
  // Any number of its own (not the user's) is general knowledge: the prompt's numbers are rules, not facts for it.
  const own = new Set(numbersIn(question, true));
  if (wire.general && numbersIn(say).some(n => !own.has(n))) say = `${say}${TYPICAL[langKey(question)]}`;

  // How to make a solution: the app's numbers in place of the model's words, and no card beside them (solution.ts).
  const solution = solutionReply(wire.calc, `${earlier}\n${question}`, replyLanguage(question));
  if (solution) {
    dropped.push(`say replaced by the app's ${wire.calc.kind}`);
    say = solution;
    a2ui = [];
  }

  // Sources are never the model's words: they are the manual of the protocol on screen (the pages it named, the one
  // whose note matches the question first, with the manual's own words).
  const sources: Source[] = [];
  if (open && wire.manualPages.length) {
    const cited = manualSources(open, wire.manualPages);
    const note = answerFromManual(open, question, { procedureId: context.procedure });
    const at = note ? cited.findIndex(s => s.page === note.source.page) : -1;
    if (note && at >= 0) {
      cited.splice(at, 1);
      cited.unshift(note.source);
    }
    sources.push(...cited);
  }
  const expression = (replyExpressions as readonly string[]).includes(wire.expression ?? '') ? (wire.expression as Expression) : undefined;
  return {
    reply: {
      say,
      ...(expression ? { expression } : {}),
      actions: actions.slice(0, 12),
      ...(confirm.length ? { confirm: confirm.slice(0, 12) } : {}),
      ...(a2ui.length ? { a2ui } : {}),
      sources: sources.slice(0, 8),
    },
    dropped,
  };
}

type Checked = { ok: true; reply: ConverseReply; dropped: string[] } | { ok: false; issue: string; say?: string };

/**
 * The model's raw content → a ConverseReply that passes ConverseReplySchema (minus anything broken), or why not.
 * `prompt` is the system prompt the model was given (its numbers are the ones it may say); built here when not given.
 */
export function checkReply(content: unknown, context: ConverseContext, question = '', prompt = systemPrompt(context), earlier = ''): Checked {
  if (typeof content !== 'string') return { ok: false, issue: 'no content' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { ok: false, issue: 'not JSON' };
  }
  const wire = Wire.safeParse(parsed);
  const say = typeof (parsed as Json)?.say === 'string' && (parsed as Json).say.trim() ? (parsed as Json).say.trim() as string : undefined;
  if (!wire.success) return { ok: false, issue: describeIssues(wire.error), say };
  const { reply: built, dropped } = fromWire(wire.data, context, question, prompt, earlier);
  const reply = ConverseReplySchema.safeParse(built);
  if (!reply.success) return { ok: false, issue: describeIssues(reply.error), say };
  return { ok: true, reply: reply.data, dropped };
}

// ---------------------------------------------------------------------------------------------------------------
// Find a protocol: Muse Spark with web search, as in scripts/find-protocol.ts.

// The answer is short on purpose: the app shows the protocol on this machine (or imports the PDF found), so only the
// document, the kit and a few lines are read from it, and every line written is time the user waits.
const findInstructions = `You are Chapp, a lab companion at the bench. The user names a kit or a reagent, and maybe the part of its protocol they need.
1. Search the web for the vendor's own manual, user guide or protocol for that exact product (its catalog number when given). Prefer the newest version on the vendor's site. Before each search or page, say in a few words what you are doing: the user sees it live.
2. Answer only from that document: the requested section's steps, or the main procedure if they name none, in at most 6 short lines, with volumes, times and temperatures exactly as written.
3. Name the document, its version or date, and cite its URL. If you cannot find the vendor's document, say so; never fill in steps from memory or from another kit.
4. A product with no manual or protocol of its own (a plain chemical, buffer, medium or antibody sold with a product page only): say so first, then in at most 4 short lines from the vendor's product page what it is, its catalog number, how it is stored and what it is used for. Its Document is "none" and its URL is that product page.
Reply in the user's language, but keep reagent names, units and numbers as the manual writes them.
End with these six lines, labels in English exactly as shown, "none" for anything you could not find:
Vendor: <company>
Catalog: <catalog number>
Kit: <kit name>
Document: <the document's title>
Version: <its version or date, as printed>
URL: <the document's URL>`;

const labels = ['vendor', 'catalog', 'kit', 'document', 'version', 'url'] as const;
type Label = (typeof labels)[number];

/** Splits the trailing "Vendor: … URL: …" block off the answer. Missing or "none" values come back undefined. */
export function splitDetails(text: string): { answer: string; details: Partial<Record<Label, string>> } {
  const lines = text.split('\n');
  const details: Partial<Record<Label, string>> = {};
  let cut = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    const m = /^[-*>\s]*\**\s*(vendor|catalog|kit|document|version|url)\s*\**\s*[:：]\s*\**\s*(.*?)\s*\**\s*$/i.exec(line);
    if (!m) break;
    const label = m[1].toLowerCase() as Label;
    if (label in details) break;
    const value = m[2].replace(/^<|>$/g, '').replace(/^\[(.*)\]\((.*)\)$/, label === 'url' ? '$2' : '$1').trim();
    if (value && !/^(none|n\/a|unknown|not found|無|无)\.?$/i.test(value)) details[label] = value;
    cut = i;
  }
  let rest = lines.slice(0, cut);
  while (rest.length && /^\s*(-{3,}|\*{3,}|_{3,})?\s*$/.test(rest[rest.length - 1])) rest = rest.slice(0, -1);
  return { answer: rest.join('\n').trim(), details };
}

const generic = new Set(['scientific', 'biosciences', 'bioscience', 'technologies', 'technology', 'systems', 'inc', 'ltd', 'llc', 'corporation', 'corp', 'company', 'life', 'labs', 'laboratories', 'international', 'the', 'and']);

/** Does this URL live on the vendor's own site? "Thermo Fisher Scientific" matches documents.thermofisher.com. */
export function isVendorUrl(url: string, vendor: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/[^a-z0-9]/g, '');
  } catch {
    return false;
  }
  const words = vendor.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const tokens = [...words.filter(w => w.length >= 4 && !generic.has(w)), words.join('')].filter(t => t.length >= 4);
  return tokens.some(t => host.includes(t));
}

/** Drops the tracking parameters search results add (?ref=…, utm_…), which vendor PDFs never need. */
export function cleanUrl(url: string): string {
  const u = URL.parse(url);
  if (!u) return url;
  for (const key of [...u.searchParams.keys()]) if (key === 'ref' || key.startsWith('utm_')) u.searchParams.delete(key);
  return u.href;
}

const sameUrl = (a: string, b: string) => {
  const norm = (u: string) => {
    try {
      return decodeURI(u).replace(/\/$/, '').toLowerCase();
    } catch {
      return u.toLowerCase();
    }
  };
  return norm(a) === norm(b);
};

/** The name a site goes by: documents.thermofisher.com → thermofisher, www.bio-rad.com → biorad. */
function siteName(url: string): string {
  const host = (URL.parse(url)?.hostname ?? '').toLowerCase().split('.');
  const name = host.length >= 3 && host[host.length - 2].length <= 3 ? host[host.length - 3] : host[host.length - 2];
  return (name ?? '').replace(/[^a-z0-9]/g, '');
}

/** A Responses API reply from Muse Spark with web search → FoundProtocol. `query` helps tell the vendor's site apart. */
/** The text parts of a Responses API message item. */
const textParts = (o: Json): Json[] => (Array.isArray(o.content) ? o.content : []).filter((c: Json) => c.type === 'output_text' && typeof c.text === 'string');

export function parseFound(r: Json, query = ''): FoundProtocol {
  const items: Json[] = Array.isArray(r.output) ? r.output : [];
  const said = textParts;
  const messages = items.filter(o => o.type === 'message');
  // Muse Spark narrates its search in "commentary" messages; the answer is in the others.
  let progress = messages.filter(o => o.phase === 'commentary').flatMap(said).map(c => (c.text as string).trim()).filter(Boolean);
  if (!progress.length) {
    const host = (url: string) => URL.parse(url)?.hostname ?? url;
    progress = items.filter(o => o.type === 'web_search_call').map(o =>
      o.action?.type === 'open_page' && o.action.url ? `Opening ${host(o.action.url)}` : `Searching: ${o.action?.query ?? 'the web'}`);
  }
  const parts = messages.filter(o => o.phase !== 'commentary').flatMap(said);
  const { answer, details } = splitDetails(parts.map(c => c.text).join(''));

  const sources: Source[] = [];
  for (const a of parts.flatMap(c => (Array.isArray(c.annotations) ? c.annotations : [])) as Json[]) {
    if (a.type !== 'url_citation' || typeof a.url !== 'string') continue;
    const url = cleanUrl(a.url);
    const known = sources.find(s => sameUrl(s.url, url));
    if (!known) sources.push({ url, ...(a.title ? { title: a.title } : {}) });
    else if (!known.title && a.title) known.title = a.title;
  }
  const opened = items.filter(o => o.type === 'web_search_call' && typeof o.action?.url === 'string').map(o => cleanUrl(o.action.url));

  // Found means the vendor's own document was cited: by its site, or by the URL the model named as the document.
  const named = details.url && /^https?:\/\//.test(details.url) ? cleanUrl(details.url) : undefined;
  const vendorSource = details.vendor ? sources.find(s => isVendorUrl(s.url, details.vendor!)) : undefined;
  const namedCited = named && [...sources.map(s => s.url), ...opened].some(u => sameUrl(u, named)) ? named : undefined;
  // Without the details block, a cited site whose name the user or the answer mentions counts as the vendor's.
  const mentioned = (query + answer.slice(0, 600)).toLowerCase().replace(/[^a-z0-9]/g, '');
  const guessed = details.vendor ? undefined : sources.find(s => siteName(s.url).length >= 4 && mentioned.includes(siteName(s.url)));
  // A product with no manual (rule 4): its product page, with what the answer read from it, but nothing to import.
  const page = !details.document && named && !/\.pdf(?:[?#]|$)/i.test(named) && (namedCited || (details.vendor && isVendorUrl(named, details.vendor))) ? named : undefined;
  const found = !page && Boolean(vendorSource || namedCited || guessed);
  const url = namedCited ?? (named && details.vendor && isVendorUrl(named, details.vendor) ? named : undefined) ?? vendorSource?.url ?? guessed?.url;
  const title = details.document ?? sources.find(s => url && sameUrl(s.url, url))?.title;

  return {
    found,
    ...(details.vendor && details.kit ? { kit: { vendor: details.vendor, catalog: details.catalog ?? '', name: details.kit } } : {}),
    ...(found && url ? { document: { title: title ?? details.kit ?? 'Vendor manual', ...(details.version ? { version: details.version } : {}), url } } : {}),
    progress,
    answer,
    sources,
    ...(page ? { page } : {}),
  };
}

// ---------------------------------------------------------------------------------------------------------------

/** The upstream's own error message, short, with the key scrubbed in case it was echoed. */
function upstreamMessage(text: string, apiKey: string): string {
  let message = text;
  try {
    const body = JSON.parse(text);
    message = body?.error?.message ?? body?.message ?? body?.detail ?? (typeof body?.error === 'string' ? body.error : text);
  } catch {
    // Not JSON: keep the text.
  }
  return String(message).split(apiKey).join('***').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * A streamed Responses API reply (stream: true): each event to `onEvent` as it arrives, then the finished response
 * from response.completed. A failed or cut-off stream comes back as a failed response, so callers check one shape.
 */
async function finished(body: ReadableStream<Uint8Array>, onEvent: (event: Json) => void): Promise<Json> {
  for await (const { data } of readEvents(body)) {
    if (data === '[DONE]') break;
    let event: Json;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    onEvent(event);
    if (event.type === 'response.completed') return event.response ?? {};
    if (event.type === 'response.failed' || event.type === 'response.incomplete') {
      return { ...event.response, status: 'failed', error: event.response?.error ?? { message: event.response?.incomplete_details?.reason ?? event.type } };
    }
    if (event.type === 'error') return { status: 'failed', error: { message: event.message ?? event.error?.message ?? event.code } };
  }
  return { status: 'failed', error: { message: 'the stream ended before the answer' } };
}

/** Muse Spark puts misheard lab words right when the local fixes could not: the transcript back with only those changed. */
const fixFormat = {
  type: 'json_schema',
  json_schema: { name: 'Transcript', strict: true, schema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } } } },
};
const fixInstructions = (terms: string[]) =>
  `This is speech-to-text from someone at a lab bench. It may have misheard lab names. Names they may say: ${terms.join('; ')}. Return the transcript with only misheard names corrected, every other word exactly as it is.`;

export function createMetaProvider(options: MetaOptions): AIProvider {
  const { apiKey, baseUrl = 'https://api.meta.ai/v1', log = (line: string) => console.log(line) } = options;
  if (!apiKey) throw new Error('AI_PROVIDER=meta needs MODEL_API_KEY in .env (see .env.example).');
  const fetchFn = options.fetch ?? globalThis.fetch;
  const timeouts = { converse: 30_000, findProtocol: 60_000, transcribe: 20_000, attempt: ATTEMPT_MS, draw: 90_000, ...options.timeouts };
  const effort: Record<keyof typeof EFFORT, Effort> = { ...EFFORT, ...options.effort };

  type Request = {
    body: string | FormData;
    json?: boolean;
    /** The caller giving up (the user left): the request is dropped like a timeout. */
    signal?: AbortSignal;
    /** Streams the reply: each server-sent event, parsed, as it arrives; the call returns the finished response. */
    events?: (event: Json) => void;
  };

  async function call(what: string, path: string, init: Request, timeoutMs: number): Promise<Json> {
    const started = Date.now();
    const seconds = () => ((Date.now() - started) / 1000).toFixed(1);
    const timeout = AbortSignal.timeout(Math.max(1, timeoutMs));
    let status = 0;
    let text = '';
    let streamed: Json | undefined;
    try {
      const res = await fetchFn(baseUrl + path, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, ...(init.json ? { 'content-type': 'application/json' } : {}) },
        body: init.body,
        signal: init.signal ? AbortSignal.any([timeout, init.signal]) : timeout,
      });
      status = res.status;
      // A stream is read as it comes; an error, or a plain JSON answer to a streamed request, is read whole.
      if (res.ok && init.events && res.body && (res.headers.get('content-type') ?? '').includes('text/event-stream')) {
        streamed = await finished(res.body, init.events);
      } else {
        text = await res.text();
      }
      if (!res.ok) {
        log(`[meta] ${what} failed after ${seconds()} s: ${status}`);
        throw new UpstreamError(`Meta ${what} failed (${status}): ${upstreamMessage(text, apiKey)}`);
      }
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      if (init.signal?.aborted) {
        log(`[meta] ${what} cancelled after ${seconds()} s`);
        throw new UpstreamError(`Meta ${what} was cancelled`);
      }
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      log(`[meta] ${what} ${timedOut ? 'timed out' : 'could not connect'} after ${seconds()} s`);
      throw new UpstreamError(timedOut ? `Meta ${what} timed out after ${Math.round(timeoutMs / 1000)} s` : `Could not reach the Meta API for ${what}`);
    }
    log(`[meta] ${what} ${seconds()} s`);
    if (streamed) return streamed;
    try {
      return JSON.parse(text);
    } catch {
      throw new UpstreamError(`Meta ${what} answered with something that is not JSON`);
    }
  }

  /** Muse Spark's correction of a transcript the local fixes left unsure; the local text when it fails or overreaches. */
  async function fixTranscript(text: string, terms: string[], timeoutMs: number): Promise<string> {
    try {
      const body = await call('fix-transcript', '/chat/completions', {
        body: JSON.stringify({
          model: MODEL,
          reasoning_effort: effort.fixTranscript,
          messages: [{ role: 'system', content: fixInstructions(terms) }, { role: 'user', content: text }],
          response_format: fixFormat,
        }),
        json: true,
      }, timeoutMs);
      const fixed = JSON.parse(body.choices?.[0]?.message?.content ?? '{}').text;
      // A fix rewrites a name or two, not the sentence.
      return typeof fixed === 'string' && fixed.trim() && distance(fixed, text) <= Math.max(6, text.length * 0.3) ? fixed.trim() : text;
    } catch {
      return text;
    }
  }

  return {
    async transcribe(wav: Uint8Array): Promise<Transcript> {
      const deadline = Date.now() + timeouts.transcribe;
      // One turn the phone has already cut: PUSH_TO_TALK, with the lab's words and languages (speech.ts).
      const form = new FormData();
      const request = { mode: 'PUSH_TO_TALK', model: ASR_MODEL, audioEncoding: 'WAV', languageBias: LANGUAGES, keywords: keywords() };
      form.append('request', new Blob([JSON.stringify(request)], { type: 'application/json' }));
      form.append('audio', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'speech.wav');
      const body = await call('transcribe', '/asr/transcribe', { body: form }, timeouts.transcribe);
      if (typeof body.transcript !== 'string') throw new UpstreamError('Meta transcribe returned no transcript');
      // Lab names misheard ("pierced BCA protein acetate"): fixed here, and by Muse Spark only when still unsure.
      const terms = labTerms(knownProtocols());
      const fixed = fixLabWords(toTaiwan(body.transcript.trim()), terms);
      const left = deadline - Date.now();
      return { transcript: needsModelFix(fixed, terms) && left > 1000 ? await fixTranscript(fixed, terms, Math.min(left, 8000)) : fixed };
    },

    async converse({ text, context, history = [] }) {
      const deadline = Date.now() + timeouts.converse;
      // The conversation so far (the app sends the last few turns), so a short answer like "yes" has its question.
      const earlier = history.map(t => ({ role: t.role === 'user' ? 'user' : 'assistant', content: t.text }));
      const messages: Json[] = [{ role: 'system', content: systemPrompt(context, text) }, ...earlier, { role: 'user', content: text }];
      const saidBefore = history.filter(t => t.role === 'user').map(t => t.text).join('\n');
      let first: Checked | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        const left = deadline - Date.now();
        if (attempt > 0 && left < 3000) break;
        let body: Json;
        try {
          body = await call('converse', '/chat/completions', {
            body: JSON.stringify({ model: MODEL, reasoning_effort: effort.converse, messages, response_format: replyFormat }),
            json: true,
          }, Math.min(left, timeouts.attempt));
        } catch (error) {
          if (first && !first.ok && first.say) break; // The retry failed; fall back to the first answer's words.
          // Only a call that hung or that the API failed itself (5xx); a refused key or a bad request would fail again.
          const passing = error instanceof UpstreamError && / timed out after |failed \(5\d\d\)/.test(error.message);
          if (attempt === 0 && passing && deadline - Date.now() > 3000) {
            log(`[meta] converse asked again: ${error instanceof Error ? error.message : 'failed'}`);
            continue;
          }
          throw error;
        }
        const content = body.choices?.[0]?.message?.content;
        const checked = checkReply(content, context, text, messages[0].content, saidBefore);
        if (checked.ok) {
          const drawn = checked.reply.a2ui?.flatMap(m => ('updateComponents' in m ? m.updateComponents.components.map(c => c.component) : [])) ?? [];
          log(`[meta] converse a2ui: ${drawn.length ? drawn.join(' ') : 'none'}`);
          if (checked.dropped.length) log(`[meta] converse dropped ${checked.dropped.join(', ')}`);
          return checked.reply;
        }
        log(`[meta] converse reply rejected: ${checked.issue.slice(0, 160)}`);
        first ??= checked;
        // Broken actions and cards are dropped above; only a reply with nothing usable is asked for again, showing the
        // model what was wrong.
        messages.push({ role: 'assistant', content: typeof content === 'string' ? content : '' }, { role: 'user', content: `That reply did not fit the format (${checked.issue}). Answer my last message again.` });
      }
      const say = first && !first.ok && first.say;
      return {
        say: say || "Sorry, I lost my train of thought. Could you say that again?",
        expression: say ? 'neutral' : 'thinking',
        actions: [],
        sources: [],
      };
    },

    async findProtocol(query: string, live: FindProtocolLive = {}): Promise<FoundProtocol> {
      const started = Date.now();
      let heard = false;
      // Muse Spark narrates its search in commentary messages, each whole once its item is done: passed on as they come.
      const events = (event: Json) => {
        if (event.type !== 'response.output_item.done' || event.item?.type !== 'message' || event.item.phase !== 'commentary') return;
        const line = textParts(event.item).map(c => c.text).join('').trim();
        if (!line) return;
        if (!heard) log(`[meta] find-protocol first progress after ${((Date.now() - started) / 1000).toFixed(1)} s`);
        heard = true;
        live.onProgress?.(line);
      };
      const body = await call('find-protocol', '/responses', {
        body: JSON.stringify({
          model: MODEL,
          stream: true,
          reasoning: { effort: effort.findProtocol },
          tools: [{ type: 'web_search' }],
          input: [{ role: 'system', content: findInstructions }, { role: 'user', content: query }],
        }),
        json: true,
        signal: live.signal,
        events,
      }, timeouts.findProtocol);
      if (body.status === 'failed' || body.error) throw new UpstreamError(`Meta find-protocol failed: ${upstreamMessage(JSON.stringify(body.error ?? {}), apiKey) || 'no reason given'}`);
      const found = parseFound(body, query);
      if (!found.answer && !found.sources.length) throw new UpstreamError('Meta find-protocol returned no answer');
      // The vendor's document we already have as a protocol: the app opens that one.
      const protocolId = found.found ? localProtocolId(found) : undefined;
      return protocolId ? { ...found, protocolId } : found;
    },

    /** A step card's picture: Muse Spark writes it as SVG from the step's facts, kept only if it is plain drawing. */
    async drawStep(facts) {
      const body = await call('draw-step', '/chat/completions', {
        body: JSON.stringify({ model: MODEL, reasoning_effort: effort.drawStep, messages: [{ role: 'system', content: DRAW_INSTRUCTIONS }, { role: 'user', content: JSON.stringify({ ...facts, layout: layoutFor(facts) }) }] }),
        json: true,
      }, timeouts.draw);
      const svg = cleanSvg(String(body.choices?.[0]?.message?.content ?? ''));
      if (!svg) throw new UpstreamError('Meta draw-step returned no usable SVG');
      return svg;
    },

    readPlate: metaReadPlate({ apiKey, baseUrl, fetch: options.fetch, log }),
    importProtocol: (pdf, source, live) => importProtocol(pdf, source, { apiKey, baseUrl, fetch: options.fetch, log, onProgress: live?.onProgress, onIntro: live?.onIntro }),
    ...createKitVision({ apiKey, baseUrl, fetch: options.fetch, log }),
  };
}
