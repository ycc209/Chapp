import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConverseLive, ConverseReply, FoundProtocol, ProtocolIntro, ProtocolPreview } from '../shared/ai.ts';
import { createConversation } from '../server/ai/conversation.ts';
import { converseLive } from '../src/api/converse.ts';
import { converse } from '../src/state/conversation.ts';
import { useChatLog } from '../src/state/conversationLog.ts';
import { useProtocolPreviews } from '../src/state/protocolPreview.ts';
import { useRun } from '../src/state/run.ts';
import { useSession } from '../src/state/session.ts';

const source = { url: 'https://www.thermofisher.com/original-manual.pdf?revision=C', title: 'Manufacturer manual' };
const intro: ProtocolIntro = {
  title: 'Confirmed assay manual', summary: 'The confirmed document overview.',
  kit: { name: 'Confirmed assay', vendor: 'Manufacturer', catalogs: ['12345'] },
  source: { title: source.title, publisher: 'Manufacturer', docId: 'MAN123', revision: 'C', url: source.url },
  overview: { steps: [], expected: [], cite: { page: 1, quote: 'Original overview.' } },
  procedure: { name: 'Original method', steps: [], others: [] },
  contents: [{ name: 'Original reagent', amount: '100 mL' }],
};
const reading: ProtocolPreview = { id: 'overview-1', state: 'reading', title: intro.title, source };
const ready: ProtocolPreview = { ...reading, state: 'ready', intro, protocolId: 'confirmed-assay' };
const reply = (say: string, responseId = 'answer-1', extra: Partial<ConverseReply> = {}): ConverseReply => ({ say, responseId, sources: [], actions: [], ...extra });
const encoder = new TextEncoder();
const frame = (event: string, data: unknown) => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
function stream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; } }), { headers: { 'content-type': 'text/event-stream' } });
  return { response, send: (event: string, data: unknown) => controller.enqueue(frame(event, data)), close: () => controller.close() };
}
const state = () => JSON.parse(JSON.stringify(useRun.getState()));
const options = () => ({ context: () => ({ screen: 'home', protocolId: 'pierce-bca', samples: 12, replicates: 2, standardReplicates: 2 }), protocol: () => null, navigate: vi.fn() });

beforeEach(() => {
  useSession.getState().newConversation();
  useProtocolPreviews.setState({ previews: {} });
  useRun.getState().reset();
  useRun.getState().setProtocol('pierce-bca');
  useRun.getState().goTo(2);
  useRun.getState().setDone('already-completed');
  useRun.getState().setReading('A1', 0.21);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('conversation-driven protocol overview', () => {
  it('carries the model clarification into a registered-source preview tool and streams it without a browser mutation', async () => {
    type Json = Record<string, any>;
    const message = (say: string) => ({ type: 'message', content: [{ type: 'output_text', text: say }] });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const previewProtocol = vi.fn(async (_request: { protocolId?: string; url?: string }, live: ConverseLive) => {
      live.onProtocol?.(reading);
      live.onProtocol?.({ ...reading, intro });
      await gate;
      live.onProtocol?.({ id: ready.id, state: 'ready', protocolId: ready.protocolId });
      return { data: { ok: true, protocolId: ready.protocolId, adopted: false } };
    });
    const respond = vi.fn(async (_body: Json) => {
      if (respond.mock.calls.length === 1) return { id: 'manufacturer-question', output: [
        { type: 'web_search_call', action: { type: 'search', query: 'manufacturer BCA kit' }, results: [source] },
        message('Is your box Manufacturer 12345? This is its manufacturer document, not read yet. [[S1]]'),
      ] };
      if (respond.mock.calls.length === 2) return { id: 'preview-call', output: [{ type: 'function_call', call_id: 'prepare', name: 'preview_protocol', arguments: JSON.stringify({ sourceId: 'S1' }) }] };
      return { id: 'prepared-answer', output: [message('The overview is ready. Your active experiment is unchanged.')] };
    });
    const backend = createConversation({ respond, previewProtocol, findProtocol: async (): Promise<FoundProtocol> => ({ found: false, answer: '', progress: [], sources: [] }), importProtocol: async () => ({ data: { ok: false } }) });
    const context = options().context(), original = structuredClone(context), onProtocol = vi.fn();
    const first = await backend({ text: 'I got a BCA kit.', context }, { onProtocol });
    expect(first.sources).toEqual([{ ...source, title: `${source.title} · search result, not read` }]);
    expect(first.protocolPreview).toBeUndefined();
    expect(first.pendingTools).toBeUndefined();
    expect(previewProtocol).not.toHaveBeenCalled();
    const confirmed = backend({ text: 'Yes, that one. Prepare its overview.', context, previousResponseId: first.responseId, history: [{ role: 'user', text: 'I got a BCA kit.' }, { role: 'chapp', text: first.say }] }, { onProtocol });
    await vi.waitFor(() => expect(onProtocol).toHaveBeenCalledTimes(2));
    expect(previewProtocol.mock.calls[0]![0]).toEqual({ url: source.url });
    expect(respond).toHaveBeenCalledTimes(2);
    expect(context).toEqual(original);
    release();
    const result = await confirmed;
    expect(onProtocol.mock.calls.map(([preview]) => preview.state)).toEqual(['reading', 'reading', 'ready']);
    expect(result.protocolPreview).toMatchObject(ready);
    expect(result.pendingTools).toBeUndefined();
    expect(result.actions).toEqual([]);
    expect(JSON.parse(respond.mock.calls[2]![0].input.at(-1).output)).toEqual({ ok: true, protocolId: ready.protocolId, adopted: false });
    // The confirmation replays the clarification turn from the server's record of it, instead of chaining on Meta's.
    expect(respond.mock.calls[1]![0].previous_response_id).toBeUndefined();
    expect(JSON.stringify(respond.mock.calls[1]![0].input)).toContain('Is your box Manufacturer 12345?');
    expect(respond.mock.calls[1]![0].input.at(-1)).toEqual({ role: 'user', content: 'Yes, that one. Prepare its overview.' });
    expect(context).toEqual(original);
  });

  it('delivers progressive protocol snapshots before the final conversational answer', async () => {
    const live = stream();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(live.response));
    const onProtocol = vi.fn();
    const result = converseLive({ text: 'Yes, prepare that manual.', context: { screen: 'chat' } }, { onProtocol });
    live.send('protocol', reading);
    await vi.waitFor(() => expect(onProtocol).toHaveBeenCalledWith(reading));
    live.send('protocol', { ...reading, intro });
    live.send('protocol', ready);
    live.send('reply', reply('The overview is ready.', 'overview-final', { protocolPreview: ready }));
    live.close();
    expect((await result).protocolPreview).toEqual(ready);
    expect(onProtocol.mock.calls.map(([preview]) => preview.state)).toEqual(['reading', 'reading', 'ready']);
  });

  it('keeps an ambiguous-product clarification in place, then preserves the confirmation and later natural follow-up history', async () => {
    const first = stream(), second = stream(), third = stream();
    const fetch = vi.fn().mockResolvedValueOnce(first.response).mockResolvedValueOnce(second.response).mockResolvedValueOnce(third.response);
    vi.stubGlobal('fetch', fetch);
    const page = options(), original = state();
    const ask = converse('我拿到一盒 BCA，幫我看看。', page);
    first.send('reply', reply('你的是 Manufacturer 12345 嗎？', 'clarify', { sources: [source] }));
    first.close();
    await ask;
    expect(page.navigate).not.toHaveBeenCalled();
    expect(useProtocolPreviews.getState().previews).toEqual({});
    expect(state()).toEqual(original);
    const confirm = converse('對，就是那盒，先準備總覽。', page);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const request = JSON.parse(fetch.mock.calls[1]![1].body);
    expect(request).toMatchObject({ previousResponseId: 'clarify', history: [{ role: 'user', text: '我拿到一盒 BCA，幫我看看。' }, { role: 'chapp', text: '你的是 Manufacturer 12345 嗎？' }] });
    second.send('protocol', reading);
    await vi.waitFor(() => expect(page.navigate).toHaveBeenCalledWith('/protocol?preview=overview-1'));
    expect(state()).toEqual(original);
    second.send('protocol', { ...reading, intro });
    second.send('protocol', ready);
    second.send('reply', reply('總覽已準備好，尚未切換目前實驗。', 'confirmed', { protocolPreview: ready }));
    second.close();
    await confirm;
    expect(page.navigate).toHaveBeenCalledTimes(1);
    expect(useProtocolPreviews.getState().previews[ready.id]).toMatchObject(ready);
    expect(state()).toEqual(original);
    const followup = converse('先休息一下，我今天有點累。', { ...page, context: () => ({ screen: 'chat' }) });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    const later = JSON.parse(fetch.mock.calls[2]![1].body);
    expect(later.previousResponseId).toBe('confirmed');
    expect(later.history.at(-1).text).toBe('總覽已準備好，尚未切換目前實驗。');
    third.send('reply', reply('可以，先休息一下。', 'relaxed'));
    third.close();
    await followup;
    expect(page.navigate).toHaveBeenCalledTimes(1);
    expect(state()).toEqual(original);
    expect(useChatLog.getState().exchanges.at(-1)?.say).toBe('可以，先休息一下。');
  });

  it('accepts a final ready snapshot in the nonstreaming fallback without adopting the protocol', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(reply('Prepared.', 'ready-json', { protocolPreview: ready })), { headers: { 'content-type': 'application/json' } })));
    const page = options(), original = state();
    await converse('Prepare the confirmed manual.', page);
    expect(useProtocolPreviews.getState().previews[ready.id]).toMatchObject(ready);
    expect(page.navigate).toHaveBeenCalledTimes(1);
    expect(state()).toEqual(original);
  });

  it('retains the readable intro and source when a sparse error snapshot arrives', async () => {
    const live = stream();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(live.response));
    const page = options(), original = state();
    const result = converse('Prepare that original handbook.', page);
    live.send('protocol', { ...reading, intro });
    await vi.waitFor(() => expect(useProtocolPreviews.getState().previews[reading.id]?.intro).toEqual(intro));
    live.send('protocol', { id: reading.id, state: 'error', error: 'Document extraction interrupted.' });
    live.send('reply', reply('The readable part is kept in the overview.', 'partial'));
    live.close();
    await result;
    expect(useProtocolPreviews.getState().previews[reading.id]).toMatchObject({ state: 'error', intro, source, error: 'Document extraction interrupted.' });
    expect(page.navigate).toHaveBeenCalledTimes(1);
    expect(state()).toEqual(original);
  });

  it('suppresses stale protocol, text and progress events after a new conversation replaces the request', async () => {
    const live = stream();
    const fetch = vi.fn().mockResolvedValue(live.response);
    vi.stubGlobal('fetch', fetch);
    const page = { ...options(), onText: vi.fn(), onProgress: vi.fn() };
    const old = converse('Prepare the previous manual.', page);
    const rejected = expect(old).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    useSession.getState().newConversation();
    expect(fetch.mock.calls[0]![1].signal.aborted).toBe(true);
    // This deliberately ignores AbortSignal like a late transport callback, ensuring the session guard protects UI state.
    live.send('protocol', ready);
    live.send('text', { delta: 'Stale answer must not appear.' });
    live.send('progress', { line: 'Stale reading progress' });
    live.send('reply', reply('Stale final answer.', 'old'));
    live.close();
    await rejected;
    expect(page.navigate).not.toHaveBeenCalled();
    expect(page.onText).not.toHaveBeenCalled();
    expect(page.onProgress).not.toHaveBeenCalled();
    expect(useProtocolPreviews.getState().previews).toEqual({});
    expect(useChatLog.getState().exchanges).toEqual([]);
    expect(useSession.getState().history).toEqual([]);
    expect(useSession.getState().status).not.toBe('Stale reading progress');
  });
});
