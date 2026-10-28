import { z } from 'zod';
import type { Action, AIProvider, Card, ConverseContext, ConverseReply, Expression, FindProtocolLive, FoundProtocol, Source, Transcript } from '../../shared/ai.ts';
import { readEvents } from '../../shared/sse.ts';
import { distance, fixLabWords, labTerms, needsModelFix } from '../../src/voice/labWords.ts';
import { UpstreamError } from './provider.ts';
import { metaReadPlate } from './plate.ts';
import { importProtocol } from './import.ts';
import { createKitVision } from './vision.ts';
import { ActionSchema, CardSchema, ConverseReplySchema, describeIssues, expressions, MAX_REPLICATES, routes } from './schema.ts';
import { answerFromManual, knownProtocols, loadProtocol, localProtocolId, manualSources, protocolBrief, WAYS } from './protocols.ts';

/**
 * Meta's models behind the AIProvider interface: Muse Spark for conversation and for finding a kit's manual on the
 * web, Muse Voice Transcribe for speech. Call shapes follow scripts/smoke-meta.ts and scripts/find-protocol.ts, which
 * were checked against the live API. Nothing here logs the key, a prompt or what the user said: only timings.
 */

const MODEL = 'muse-spark-1.3';
const ASR_MODEL = 'muse-voice-transcribe-1.0';

/**
 * How hard Muse Spark thinks before it answers (minimal, low, medium, high, xhigh, max; high when not sent). Thinking
 * is most of the wait. On 2026-10-28 the storyboard's eight lines (scripts/converse-smoke.ts) took a median 7.0 s
 * (max 8.1) at high, 1,000–2,000 reasoning tokens each; 2.4 s (max 4.6) at low; 1.7 s (max 2.6) at minimal, about 200
 * tokens, with the same actions and manual pages every time.
 */
export const EFFORT = { converse: 'minimal', findProtocol: 'low', fixTranscript: 'minimal' } as const;
export type Effort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type MetaOptions = {
  apiKey: string;
  baseUrl?: string;
  /** Injected by tests; the global fetch otherwise. */
  fetch?: typeof fetch;
  log?: (line: string) => void;
  /** Milliseconds per operation. A converse retry shares its first attempt's budget. */
  timeouts?: { converse?: number; findProtocol?: number; transcribe?: number };
  /** Overrides EFFORT, for measuring (scripts/converse-smoke.ts --effort). */
  effort?: Partial<Record<keyof typeof EFFORT, Effort>>;
};

type Json = Record<string, any>;

// ---------------------------------------------------------------------------------------------------------------
// Converse: Muse Spark answers in a strict JSON schema, which we turn into a ConverseReply and check with zod.

const replyExpressions = expressions.filter(e => e !== 'listen');
const actionTypes = ['navigate', 'setSamples', 'setReplicates', 'nextStep', 'previousStep', 'markDone', 'startTimer', 'findProtocol'] as const;

/**
 * The wire format the model fills. Flat objects with every field required (unused ones "" or 0) are what strict
 * json_schema reliably supports, as the GenUI test on 2026-10-28 showed; the union types live in shared/ai.ts.
 */
export const replyFormat = {
  type: 'json_schema',
  json_schema: {
    name: 'ChappReply',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['say', 'expression', 'actions', 'cards', 'manualPages'],
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
        cards: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'protocolId', 'title', 'text'],
            properties: {
              kind: { type: 'string', enum: ['protocol', 'text'] },
              protocolId: { type: 'string' },
              title: { type: 'string' },
              text: { type: 'string' },
            },
          },
        },
        manualPages: { type: 'array', items: { type: 'integer' } },
      },
    },
  },
};

// Lenient on purpose: one bad action or card is dropped (fromWire) rather than costing the whole reply a retry.
const Wire = z.object({
  say: z.string(),
  expression: z.string().optional(),
  actions: z.array(z.object({ type: z.string(), to: z.string().default(''), value: z.number().default(0), id: z.string().default(''), query: z.string().default('') })).default([]),
  cards: z.array(z.object({ kind: z.string(), protocolId: z.string().default(''), title: z.string().default(''), text: z.string().default('') })).default([]),
  manualPages: z.array(z.number()).default([]),
});
type Wire = z.infer<typeof Wire>;


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
    context.readingsFrom !== undefined ? readings[context.readingsFrom ?? 'none'] : '',
  ]
    .filter(Boolean)
    .join(', ');
}

/**
 * Muse Spark's instructions for one turn. What never changes comes first and the run's state last, so consecutive
 * turns share a long prefix the API can cache.
 */
export function systemPrompt(context: ConverseContext): string {
  const library = knownProtocols();
  const current = context.protocolId ? loadProtocol(context.protocolId) : null;
  return `You are Chapp, a calm lab companion at the bench, helping one person run a lab kit. Everything you say is read aloud.

Reply in JSON:
- say: one or two short sentences to be heard. No lists, markdown or URLs. Use the language of the user's message: English stays English; Chinese gets Traditional Chinese as used in Taiwan, unless they wrote Simplified.
- Only say protocol numbers (volumes, times, temperatures, concentrations, wells) that are in the facts below or this run's numbers. If the answer needs a manual you don't have, say so: when you know which kit, find it (findProtocol); otherwise ask which kit. Never guess a number.
- manualPages: the page (p.N) of each manual fact your answer uses; none when you used none.
- expression: happy (greeting, good news), thinking (unsure, asking back), excited (a milestone), sad (bad news), sleepy (a long wait), surprised, wink (a light joke), else neutral.
- actions: only what the user asks for or clearly means, usually none; unused fields "" or 0. navigate (to: ${routes.join(' ')}) · setSamples (value) · setReplicates (value 1–${MAX_REPLICATES}; samples and standards) · nextStep · previousStep · markDone (id: a standard's letter or a step id) · startTimer (id: the step id, value: that step's timer in seconds) · findProtocol (query: the kit as the user named it: vendor, kit name, catalog number).
- cards: usually none. protocol (protocolId) when the user names a kit you have; text (title, text) for a short note worth keeping on screen.
- The user names a kit to run, or asks for a kit's manual or protocol, whether you have it or not: findProtocol for that kit and say you are looking up its manual; no navigate, the app opens the search. Don't ask first. "Yes" or "find it" after a kit was named earlier in the conversation means that kit. A greeting: greet back and suggest what to say next.
- Plate readings that are sample data are an example, not the user's results: say so when you talk about them.

Protocols you have: ${library.map(p => `${p.id} (${p.kit.name}, ${p.kit.vendor})`).join('; ') || 'none yet'}.${current ? `\n\n${protocolBrief(current, context)}` : '\n\nNo kit is open in this conversation: don\'t assume one.'}

Right now: ${rightNow(context)}.`;
}

/** The wire's flat action → the app's Action, or null for a type the app does not know. */
function toAction(a: Wire['actions'][number]): Action | null {
  switch (a.type) {
    case 'navigate': return { type: 'navigate', to: a.to };
    case 'setSamples': return { type: 'setSamples', samples: a.value };
    case 'setReplicates': return { type: 'setReplicates', replicates: a.value };
    case 'markDone': return { type: 'markDone', id: a.id };
    case 'startTimer': return { type: 'startTimer', id: a.id, seconds: a.value };
    case 'nextStep': return { type: 'nextStep' };
    case 'previousStep': return { type: 'previousStep' };
    case 'findProtocol': return a.query.trim() ? { type: 'findProtocol', query: a.query.trim() } : null;
    default: return null;
  }
}

/** Cuts a long answer at the last sentence that fits, so what is read aloud still ends cleanly. */
function fit(say: string, max = 600): string {
  const text = say.trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('。'), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return end > 0 ? cut.slice(0, end + 1) : `${cut.slice(0, max - 1)}…`;
}

/** The reply the app gets, and what was dropped from the model's on the way (for the log: kinds only, never words). */
function fromWire(wire: Wire, context: ConverseContext, question: string): { reply: ConverseReply; dropped: string[] } {
  const dropped: string[] = [];
  const actions = wire.actions.flatMap(a => {
    const action = ActionSchema.safeParse(toAction(a));
    if (action.success) return [action.data as Action];
    dropped.push(`action ${a.type}`);
    return [];
  });
  // A protocol card for a kit we have no document for would be a dead end, so it is dropped like a broken one.
  const cards = wire.cards.flatMap(c => {
    const card = CardSchema.safeParse(c.kind === 'protocol' ? { kind: 'protocol', protocolId: c.protocolId } : { kind: c.kind, ...(c.title ? { title: c.title } : {}), text: c.text });
    if (card.success && (card.data.kind === 'text' || loadProtocol(card.data.protocolId))) return [card.data as Card];
    dropped.push(`card ${c.kind}`);
    return [];
  });

  // Sources are never the model's words: they are the manual of the protocol on screen (the pages it named, the one
  // whose note matches the question first, with the manual's own words) and of any protocol card it shows.
  const sources: Source[] = [];
  const current = context.protocolId ? loadProtocol(context.protocolId) : null;
  if (current && wire.manualPages.length) {
    const cited = manualSources(current, wire.manualPages);
    const note = answerFromManual(current, question, { procedureId: context.procedure });
    const at = note ? cited.findIndex(s => s.page === note.source.page) : -1;
    if (note && at >= 0) {
      cited.splice(at, 1);
      cited.unshift(note.source);
    }
    sources.push(...cited);
  }
  for (const card of cards) {
    const doc = card.kind === 'protocol' ? loadProtocol(card.protocolId) : null;
    if (doc && !sources.some(s => s.url === doc.source.url)) sources.push(...manualSources(doc));
  }
  const expression = (replyExpressions as readonly string[]).includes(wire.expression ?? '') ? (wire.expression as Expression) : undefined;
  return {
    reply: { say: fit(wire.say), ...(expression ? { expression } : {}), actions: actions.slice(0, 5), cards: cards.slice(0, 3), sources: sources.slice(0, 8) },
    dropped,
  };
}

type Checked = { ok: true; reply: ConverseReply; dropped: string[] } | { ok: false; issue: string; say?: string };

/** The model's raw content → a ConverseReply that passes ConverseReplySchema (minus anything broken), or why not. */
export function checkReply(content: unknown, context: ConverseContext, question = ''): Checked {
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
  const { reply: built, dropped } = fromWire(wire.data, context, question);
  const reply = ConverseReplySchema.safeParse(built);
  if (!reply.success) return { ok: false, issue: describeIssues(reply.error), say };
  return { ok: true, reply: reply.data, dropped };
}

// ---------------------------------------------------------------------------------------------------------------
// Find a protocol: Muse Spark with web search, as in scripts/find-protocol.ts.

// The answer is short on purpose: the app shows the protocol on this machine (or imports the PDF found), so only the
// document, the kit and a few lines are read from it, and every line written is time the user waits.
const findInstructions = `You are Chapp, a lab companion at the bench. The user names a kit, and maybe the part of its protocol they need.
1. Search the web for the vendor's own manual or protocol book for that exact kit (its catalog number when given). Prefer the newest version on the vendor's site. Before each search or page, say in a few words what you are doing: the user sees it live.
2. Answer only from that document: the requested section's steps, or the main procedure if they name none, in at most 6 short lines, with volumes, times and temperatures exactly as written.
3. Name the document, its version or date, and cite its URL. If you cannot find the vendor's document, say so; never fill in steps from memory or from another kit.
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
  const found = Boolean(vendorSource || namedCited || guessed);
  const url = namedCited ?? (named && details.vendor && isVendorUrl(named, details.vendor) ? named : undefined) ?? vendorSource?.url ?? guessed?.url;
  const title = details.document ?? sources.find(s => url && sameUrl(s.url, url))?.title;

  return {
    found,
    ...(details.vendor && details.kit ? { kit: { vendor: details.vendor, catalog: details.catalog ?? '', name: details.kit } } : {}),
    ...(found && url ? { document: { title: title ?? details.kit ?? 'Vendor manual', ...(details.version ? { version: details.version } : {}), url } } : {}),
    progress,
    answer,
    sources,
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
  const timeouts = { converse: 30_000, findProtocol: 60_000, transcribe: 20_000, ...options.timeouts };
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
      // DIARIZATION is the one mode the endpoint accepted in testing; for one speaker it is a plain transcript.
      const form = new FormData();
      form.append('request', new Blob([JSON.stringify({ mode: 'DIARIZATION', model: ASR_MODEL, audioEncoding: 'WAV' })], { type: 'application/json' }));
      form.append('audio', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'speech.wav');
      const body = await call('transcribe', '/asr/transcribe', { body: form }, timeouts.transcribe);
      if (typeof body.transcript !== 'string') throw new UpstreamError('Meta transcribe returned no transcript');
      // Lab names misheard ("pierced BCA protein acetate"): fixed here, and by Muse Spark only when still unsure.
      const terms = labTerms(knownProtocols());
      const fixed = fixLabWords(body.transcript.trim(), terms);
      const left = deadline - Date.now();
      return { transcript: needsModelFix(fixed, terms) && left > 1000 ? await fixTranscript(fixed, terms, Math.min(left, 8000)) : fixed };
    },

    async converse({ text, context, history = [] }) {
      const deadline = Date.now() + timeouts.converse;
      // The conversation so far (the app sends the last few turns), so a short answer like "yes" has its question.
      const earlier = history.map(t => ({ role: t.role === 'user' ? 'user' : 'assistant', content: t.text }));
      const messages: Json[] = [{ role: 'system', content: systemPrompt(context) }, ...earlier, { role: 'user', content: text }];
      let first: Checked | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        const left = deadline - Date.now();
        if (attempt > 0 && left < 3000) break;
        let body: Json;
        try {
          body = await call('converse', '/chat/completions', {
            body: JSON.stringify({ model: MODEL, reasoning_effort: effort.converse, messages, response_format: replyFormat }),
            json: true,
          }, left);
        } catch (error) {
          if (first && !first.ok && first.say) break; // The retry failed; fall back to the first answer's words.
          throw error;
        }
        const content = body.choices?.[0]?.message?.content;
        const checked = checkReply(content, context, text);
        if (checked.ok) {
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
        cards: [],
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

    readPlate: metaReadPlate({ apiKey, baseUrl, fetch: options.fetch, log }),
    importProtocol: (pdf, source, live) => importProtocol(pdf, source, { apiKey, baseUrl, fetch: options.fetch, log, onProgress: live?.onProgress, onIntro: live?.onIntro }),
    ...createKitVision({ apiKey, baseUrl, fetch: options.fetch, log }),
  };
}
