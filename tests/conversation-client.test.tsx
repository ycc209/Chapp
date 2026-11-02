import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ConverseReply, ConverseContext } from '../shared/ai.ts';
import * as streaming from '../src/api/converse.ts';
import * as actions from '../src/state/assistantActions.ts';
import { converse } from '../src/state/conversation.ts';
import { useSession } from '../src/state/session.ts';
import { useChatLog } from '../src/state/conversationLog.ts';
import { ReplyText, ReplySources } from '../src/components/chapp/ReplyText.tsx';

const reply = (say: string, responseId = 'resp-final'): ConverseReply => ({ say, responseId, actions: [], sources: [] });
const options = { context: () => ({ screen: 'chat' }), protocol: () => null, navigate: vi.fn() };

beforeEach(() => { useSession.getState().newConversation(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('conversation streaming', () => {
  it('delivers incremental text and progress before the final response', async () => {
    const encoder = new TextEncoder();
    const chunks = ['event: progress\ndata: {"line":"Searching"}\n\n', 'event: text\ndata: {"delta":"Hello "}\n\n', 'event: text\ndata: {"delta":"there"}\n\n', `event: reply\ndata: ${JSON.stringify(reply('Hello there'))}\n\n`];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({ start(controller) { for (const c of chunks) controller.enqueue(encoder.encode(c)); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } })));
    const onText = vi.fn(), onProgress = vi.fn();
    const result = await streaming.converseLive({ text: 'Hi', context: { screen: 'chat' } }, { onText, onProgress });
    expect(onText.mock.calls.flat()).toEqual(['Hello ', 'there']);
    expect(onProgress).toHaveBeenCalledWith('Searching');
    expect(result.say).toBe('Hello there');
  });

  it('rejects an interrupted stream instead of treating partial prose as a completed answer', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('event: text\ndata: {"delta":"I have"}\n\n', { headers: { 'content-type': 'text/event-stream' } })));
    await expect(streaming.converseLive({ text: 'Change it', context: { screen: 'chat' } })).rejects.toThrow('before its answer');
  });
});

describe('one conversation across screens', () => {
  it('returns an execution failure to the model before recording the final answer', async () => {
    const send = vi.spyOn(streaming, 'converseLive')
      .mockResolvedValueOnce({ ...reply(''), pendingTools: [{ callId: 'call-1', action: { type: 'setSamples', samples: 1000 } }], continuationToken: 'continue-1' })
      .mockImplementationOnce(async request => {
        expect(useSession.getState().history).toEqual([]);
        expect(request.toolResults).toEqual([{ callId: 'call-1', ok: false, message: 'The plate is full.' }]);
        return reply('The plate is full; the plan has not changed.');
      });
    vi.spyOn(actions, 'executeAssistantAction').mockResolvedValue({ callId: 'call-1', ok: false, message: 'The plate is full.' });
    const result = await converse('Make it 1000 samples', options);
    expect(send).toHaveBeenCalledTimes(2);
    expect(result.say).toContain('has not changed');
    expect(useChatLog.getState().exchanges.at(-1)?.done).toEqual([]);
    expect(useSession.getState().history.at(-1)?.text).toBe(result.say);
  });

  it('serializes turns and gives a follow-up the completed response from the preceding screen', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const send = vi.spyOn(streaming, 'converseLive').mockImplementationOnce(async () => { await gate; return reply('Would you like the original manual?', 'resp-home'); }).mockResolvedValueOnce(reply('I will find that manual.', 'resp-run'));
    const first = converse('Tell me about Bradford', { ...options, context: () => ({ screen: 'home' }) });
    const second = converse('Yes, that one', { ...options, context: () => ({ screen: 'run' }) });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    release();
    await Promise.all([first, second]);
    expect(send.mock.calls[1]![0]).toMatchObject({ previousResponseId: 'resp-home', history: [{ role: 'user', text: 'Tell me about Bradford' }, { role: 'chapp', text: 'Would you like the original manual?' }] });
    expect(useSession.getState().thread?.id).toBe('resp-run');
  });

  it('validates an action against the state seen by the model, then sends the current state back', async () => {
    let current: ConverseContext = { screen: 'run', samples: 12 };
    vi.spyOn(streaming, 'converseLive').mockImplementationOnce(async () => {
      current = { screen: 'run', samples: 20 };
      return { ...reply(''), pendingTools: [{ callId: 'stale', action: { type: 'setSamples', samples: 5 } }], continuationToken: 'cont-stale' };
    }).mockImplementationOnce(async request => { expect(request.context.samples).toBe(20); return reply('The plan changed meanwhile.'); });
    const execute = vi.spyOn(actions, 'executeAssistantAction').mockResolvedValue({ callId: 'stale', ok: false, message: 'The run changed.' });
    await converse('Set five samples', { ...options, context: () => current });
    expect(execute.mock.calls[0]![1].context.samples).toBe(12);
  });

  it('does not apply the rest of a stale batch to a newly selected run', async () => {
    vi.spyOn(streaming, 'converseLive').mockResolvedValueOnce({ ...reply(''), pendingTools: [
      { callId: 'old-1', action: { type: 'setSamples', samples: 5 } },
      { callId: 'old-2', action: { type: 'setReplicates', replicates: 3 } },
    ], continuationToken: 'old-run' }).mockImplementationOnce(async request => {
      expect(request.toolResults?.[1]).toMatchObject({ callId: 'old-2', ok: false, message: expect.stringContaining('Skipped') });
      return reply('The active run changed; neither action was applied.');
    });
    const execute = vi.spyOn(actions, 'executeAssistantAction').mockResolvedValue({ callId: 'old-1', ok: false, message: 'The active protocol changed.' });
    await converse('Five samples, triplicate', options);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('keeps a completed action when the continuation connection fails', async () => {
    vi.spyOn(streaming, 'converseLive').mockResolvedValueOnce({ ...reply(''), pendingTools: [{ callId: 'saved-change', action: { type: 'setSamples', samples: 5 } }], continuationToken: 'continue-saved' }).mockRejectedValueOnce(new Error('Network disconnected'));
    vi.spyOn(actions, 'executeAssistantAction').mockResolvedValue({ callId: 'saved-change', ok: true, message: 'The run now has 5 samples.' });
    await expect(converse('Set five samples', options)).rejects.toThrow('5 samples');
    expect(useSession.getState().thread).toBeNull();
    expect(useSession.getState().history.at(-1)?.text).toContain('Succeeded: The run now has 5 samples.');
    expect(useChatLog.getState().exchanges.at(-1)?.say).toContain('results above were returned by the app');
  });

  it('retains older turns as labelled excerpts once the request history reaches its limit', () => {
    for (let i = 0; i < 40; i++) useSession.getState().answered(`resp-${i}`, { role: 'user', text: `question-${i}` }, { role: 'chapp', text: `answer-${i}` });
    expect(useSession.getState().history).toHaveLength(64);
    expect(useSession.getState().summary).toContain('Earlier conversation excerpts');
    expect(useSession.getState().summary).toContain('question-0');
    expect(useSession.getState().summary).toContain('answer-7');
    expect(useSession.getState().summary.length).toBeLessThanOrEqual(24000);
  });

  it('keeps the response chain after more than eight answers', () => {
    for (let i = 1; i <= 12; i++) useSession.getState().answered(`resp-${i}`, { role: 'user', text: String(i) }, { role: 'chapp', text: `answer ${i}` });
    expect(useSession.getState().thread).toEqual({ id: 'resp-12', replies: 12 });
    expect(useSession.getState().history).toHaveLength(24);
  });
});

describe('readable answers and sources', () => {
  it('renders paragraphs, lists and source links without executing model HTML or unsafe links', () => {
    const html = renderToStaticMarkup(<><ReplyText text={'**Why it works**\n\n- Protein binds the dye.\n- Compare the blank.\n\n<img src=x onerror=alert(1)> [unsafe](javascript:alert) [manual](https://example.org/manual)'} /><ReplySources sources={[{ url: 'javascript:alert(1)', title: 'Unsafe' }, { url: 'https://example.org/manual', title: 'Original manual', page: 2 }]} /></>);
    expect(html).toContain('<strong');
    expect(html).toContain('<ul');
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('Original manual');
    expect(html).toContain('p. 2');
    expect(html).toContain('href="https://example.org/manual#page=2"');
  });

  it('opens the exact cited PDF page while preserving the original query string', () => {
    const html = renderToStaticMarkup(<ReplySources sources={[{ url: 'https://example.org/manual.pdf?version=2#section', title: 'Original manual', page: 4 }]} />);
    expect(html).toContain('href="https://example.org/manual.pdf?version=2#page=4"');
    expect(html).not.toContain('#section');
  });
});
