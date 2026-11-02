import type { Action, ConverseContext, ConverseLive, ConverseReply, ProtocolPreview } from '../../shared/ai.ts';
import type { Protocol } from '../../shared/protocol.ts';
import { converseLive } from '../api/converse.ts';
import { keepAwake } from '../lib/awake.ts';
import { normalizeHeard } from '../voice/heard.ts';
import { executeAssistantAction, type ActionReceipt } from './assistantActions.ts';
import { useChatLog } from './conversationLog.ts';
import { clearEvents, eventsSinceSpoken } from './runEvents.ts';
import { useSession } from './session.ts';
import { useProtocolPreviews } from './protocolPreview.ts';
import { useShown } from './shown.ts';

export type PageExecution = { ok: boolean; message: string } | null;
export type ConversationOptions = {
  context: () => ConverseContext;
  protocol: () => Protocol | null;
  navigate: (to: string) => void;
  executePage?: (action: Action) => PageExecution | Promise<PageExecution>;
  onText?: (text: string) => void;
  onProgress?: (line: string) => void;
};

// A single chain owns the conversation. Parallel research inside a turn does not fork user turns.
let waiting = Promise.resolve();
let sequence = Date.now();
let busy = false;
const active = new Set<AbortController>();
useSession.subscribe((now, before) => {
  if (now.generation !== before.generation) for (const controller of active) controller.abort();
});

type Live = Required<Pick<ConverseLive, 'onText' | 'onProgress' | 'onProtocol'>>;
/** A turn started on words that had settled before the user finished, kept until the turn ends with the same words. */
type Speculation = {
  key: string;
  thread?: string;
  generation: number;
  context: string;
  abort: AbortController;
  claimed: boolean;
  /** What arrived before the turn was confirmed: shown the moment it is. */
  held: { texts: string[]; progress: string[]; protocols: ProtocolPreview[] };
  live?: Live;
  reply: Promise<ConverseReply>;
};
let speculation: Speculation | null = null;

const withEvents = (context: ConverseContext, events: string[]): ConverseContext => (events.length ? { ...context, events } : context);

/** The context as far as it bears on the answer: a timer's seconds left tick on while the user is still speaking. */
const sameContext = (context: ConverseContext) => JSON.stringify({ ...context, timers: context.timers?.map(t => t.id), paused: context.paused?.map(t => t.id) });

/**
 * Starts the conversation on words still being heard (src/voice/controller.ts, once they have not changed for
 * STABLE_MS): the request goes now; its text, progress and actions are held back; converse() takes it over when the
 * turn ends with the same words in the same context and conversation, and drops it otherwise, aborting the call.
 * Nothing shows until then. (LiveKit's agents call this preemptive generation; Deepgram's Flux starts on an eager end
 * of turn the same way.)
 */
export function speculate(text: string, options: ConversationOptions) {
  const key = normalizeHeard(text);
  if (!key || busy) return;
  if (speculation && !speculation.abort.signal.aborted && speculation.key === key) return;
  discardSpeculation();
  const session = useSession.getState();
  const context = withEvents(options.context(), eventsSinceSpoken());
  const abort = new AbortController();
  active.add(abort);
  const s: Speculation = { key, thread: session.thread?.id, generation: session.generation, context: sameContext(context), abort, claimed: false, held: { texts: [], progress: [], protocols: [] }, reply: Promise.resolve() as unknown as Promise<ConverseReply> };
  s.reply = converseLive({ text, context, history: session.history.slice(-64), previousResponseId: session.thread?.id, ...(session.summary ? { summary: session.summary } : {}) }, {
    signal: abort.signal,
    onText: delta => (s.live ? s.live.onText(delta) : s.held.texts.push(delta)),
    onProgress: line => (s.live ? s.live.onProgress(line) : s.held.progress.push(line)),
    onProtocol: preview => (s.live ? s.live.onProtocol(preview) : s.held.protocols.push(preview)),
  });
  s.reply.catch(() => {}).finally(() => { if (!s.claimed) active.delete(abort); });
  speculation = s;
}

/** Drops the start made on words that did not become the turn. */
export function discardSpeculation() {
  if (speculation && !speculation.claimed) speculation.abort.abort();
  speculation = null;
}

/** The start made on these very words, in this context and conversation, if there is one; it is this turn's now. */
function claim(text: string, context: ConverseContext): Speculation | null {
  const s = speculation;
  const session = useSession.getState();
  if (!s || s.claimed || s.abort.signal.aborted || s.key !== normalizeHeard(text) || s.thread !== session.thread?.id || s.generation !== session.generation || s.context !== sameContext(context)) return null;
  s.claimed = true;
  speculation = null;
  return s;
}

/** Execute requested tools, return their receipts, then expose the model's final answer. */
export function converse(text: string, given: ConversationOptions): Promise<ConverseReply> {
  const generation = useSession.getState().generation;
  const id = ++sequence;
  // What the user did by hand since they last spoke goes with this turn, once (src/state/runEvents.ts).
  const events = eventsSinceSpoken();
  clearEvents();
  const options: ConversationOptions = { ...given, context: () => withEvents(given.context(), events) };
  // Claimed now, synchronously: the microphone closes right after handing the words over and drops what is unclaimed.
  // A start made on other words is stale once this turn begins, since its answer would follow this one's.
  let prepared = claim(text, options.context());
  if (!prepared) discardSpeculation();
  useChatLog.getState().add({ id, ask: text, phase: 'thinking', say: '', done: [], go: [] });
  const task = waiting.then(async () => {
    if (generation !== useSession.getState().generation) {
      prepared?.abort.abort();
      throw new DOMException('Conversation replaced', 'AbortError');
    }
    busy = true;
    const abort = prepared?.abort ?? new AbortController();
    active.add(abort);
    // The screen stays on until the answer is in: a locked phone loses the connection, and the answer with it.
    const awake = keepAwake();
    const session = useSession.getState();
    session.setHeard('');
    session.setStatus('Thinking');
    session.setExpression('thinking');
    let continuationToken: string | undefined;
    let toolResults: { callId: string; ok: boolean; message: string }[] | undefined;
    const done: string[] = [];
    const receipts: { callId: string; ok: boolean; message: string }[] = [];
    const opened = new Set<string>();
    const showProtocol = (preview: ProtocolPreview) => {
      if (abort.signal.aborted || generation !== useSession.getState().generation) return;
      useProtocolPreviews.getState().receive(preview);
      useChatLog.getState().set(id, { protocolPreviewId: preview.id });
      if (!opened.has(preview.id)) {
        opened.add(preview.id);
        options.navigate(`/protocol?preview=${encodeURIComponent(preview.id)}`);
      }
    };
    try {
      for (let step = 0; step < 12; step++) {
        let streamed = '';
        const requestContext = options.context();
        const live: Live = {
          onProtocol: showProtocol,
          onText: delta => {
            if (abort.signal.aborted || generation !== useSession.getState().generation) return;
            streamed += delta;
            useChatLog.getState().set(id, { say: streamed, progress: undefined });
            options.onText?.(streamed);
          },
          onProgress: line => {
            if (abort.signal.aborted || generation !== useSession.getState().generation) return;
            useChatLog.getState().set(id, { progress: line });
            useSession.getState().setStatus(line);
            options.onProgress?.(line);
          },
        };
        const request = () => ({
          text, context: requestContext, history: session.history.slice(-64),
          previousResponseId: session.thread?.id, ...(session.summary ? { summary: session.summary } : {}),
          ...(continuationToken ? { continuationToken, toolResults } : {}),
        });
        let reply: ConverseReply;
        if (prepared) {
          const early = prepared;
          prepared = null;
          for (const delta of early.held.texts) live.onText(delta);
          for (const line of early.held.progress) live.onProgress(line);
          for (const preview of early.held.protocols) live.onProtocol(preview);
          early.live = live;
          try {
            reply = await early.reply;
          } catch (error) {
            // An early start that failed is made again as the ordinary turn it would have been.
            if (abort.signal.aborted) throw error;
            streamed = '';
            reply = await converseLive(request(), { signal: abort.signal, ...live });
          }
        } else reply = await converseLive(request(), { signal: abort.signal, ...live });
        if (abort.signal.aborted) throw new DOMException('Conversation replaced', 'AbortError');
        if (reply.protocolPreview) showProtocol(reply.protocolPreview);
        if (reply.pendingTools?.length) {
          if (!reply.continuationToken) throw new Error('The action could not be continued');
          continuationToken = reply.continuationToken;
          toolResults = [];
          let failed = false;
          for (const tool of reply.pendingTools) {
            if (abort.signal.aborted) throw new DOMException('Conversation replaced', 'AbortError');
            const result: ActionReceipt = failed ? { callId: tool.callId, ok: false, message: 'Skipped because an earlier action failed. Reassess the current state before proposing another change.' } : await executeAssistantAction(tool.action, {
              callId: tool.callId, exchangeId: id, navigate: options.navigate, protocol: options.protocol(),
              context: toolResults.length ? options.context() : requestContext, executePage: options.executePage,
            });
            failed ||= !result.ok;
            toolResults.push(result);
            receipts.push(result);
            if (result.ok) done.push(result.message);
          }
          useChatLog.getState().set(id, { say: '', done, progress: 'Checking the result…' });
          continue;
        }
        // Legacy/mock replies may suggest actions. They are not evidence of an executed tool.
        const face = reply.expression ?? 'neutral';
        useSession.getState().answered(reply.responseId, { role: 'user', text }, { role: 'chapp', text: reply.say });
        useSession.getState().setExchange({ ask: text, say: reply.say });
        useSession.getState().setStatus('');
        useSession.getState().setExpression(face);
        if (reply.a2ui) useShown.getState().clear();
        useChatLog.getState().set(id, { phase: 'reply', say: reply.say, sources: reply.sources, done, a2ui: reply.a2ui, confirm: reply.confirm, progress: undefined });
        return reply;
      }
      throw new Error('This request needs too many consecutive actions. Please ask for the next part.');
    } catch (error) {
      for (const previewId of opened) {
        const preview = useProtocolPreviews.getState().previews[previewId];
        if (preview?.state === 'reading') useProtocolPreviews.getState().receive({ id: previewId, state: 'error', error: 'The manual reading was interrupted. The preview already received is still available.' });
      }
      const reason = error instanceof Error ? error.message : 'The answer could not be completed';
      const message = receipts.length ? `${receipts.map(r => r.message).join('\n')}\nThe follow-up answer was interrupted; the results above were returned by the app.` : reason;
      useChatLog.getState().set(id, { phase: 'error', say: message, done });
      if (generation === useSession.getState().generation) {
        // The action may have succeeded before a connection failed. Keep its actual receipt locally;
        // the next turn must not continue a server history that has not seen that outcome.
        if (receipts.length) useSession.getState().addTurns(
          { role: 'user', text },
          { role: 'chapp', text: `The app returned these execution results: ${receipts.map(r => `${r.ok ? 'Succeeded' : 'Failed'}: ${r.message}`).join('\n')}\nThe follow-up answer did not finish. Do not repeat an action that already succeeded.` },
        );
        useSession.getState().setStatus('');
        useSession.getState().setExpression('sad');
      }
      throw receipts.length ? new Error(message) : error;
    } finally {
      busy = false;
      active.delete(abort);
      awake();
    }
  });
  waiting = task.then(() => {}, () => {});
  return task;
}
