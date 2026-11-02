import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConverseReply } from '../shared/ai.ts';
import * as streaming from '../src/api/converse.ts';
import { converse, discardSpeculation, speculate } from '../src/state/conversation.ts';
import { useChatLog } from '../src/state/conversationLog.ts';
import { useSession } from '../src/state/session.ts';

// The conversation started on words that had settled before the user finished (src/voice/controller.ts hands them
// over): what becomes of that start when the turn ends.

const reply = (say: string, responseId: string): ConverseReply => ({ say, responseId, actions: [], sources: [] });
const options = { context: () => ({ screen: 'run' }), protocol: () => null, navigate: vi.fn() };

beforeEach(() => {
  useSession.getState().newConversation();
  discardSpeculation();
});
afterEach(() => vi.restoreAllMocks());

describe('starting on words that have settled', () => {
  it('is taken over by the turn that ends with the same words: one request, its early text shown at once', async () => {
    let finish!: (r: ConverseReply) => void;
    const send = vi.spyOn(streaming, 'converseLive').mockImplementationOnce((request, live) => {
      live?.onText?.('好，');
      return new Promise(resolve => { finish = resolve; });
    });
    speculate('下一步', options);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].text).toBe('下一步');
    expect(useChatLog.getState().exchanges).toEqual([]);
    const turn = converse('下一步，', options);
    await vi.waitFor(() => expect(useChatLog.getState().exchanges.at(-1)?.say).toBe('好，'));
    finish(reply('好，下一步。', 'resp-1'));
    expect((await turn).say).toBe('好，下一步。');
    expect(send).toHaveBeenCalledTimes(1);
    expect(useSession.getState().thread?.id).toBe('resp-1');
    expect(useChatLog.getState().exchanges.at(-1)).toMatchObject({ ask: '下一步，', phase: 'reply', say: '好，下一步。' });
  });

  it('is dropped, its request aborted, when the turn ends with other words or on another screen', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const send = vi.spyOn(streaming, 'converseLive').mockImplementation((request, live) => {
      signals.push(live?.signal);
      return Promise.resolve(reply(`heard ${request.text}`, `resp-${signals.length}`));
    });
    speculate('下一', options);
    expect((await converse('上一步', options)).say).toBe('heard 上一步');
    expect(send).toHaveBeenCalledTimes(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    speculate('下一步', options);
    expect((await converse('下一步', { ...options, context: () => ({ screen: 'plan' }) })).say).toBe('heard 下一步');
    expect(send).toHaveBeenCalledTimes(4);
    expect(signals[2]?.aborted).toBe(true);
    expect(send.mock.calls[3]![0].context).toEqual({ screen: 'plan' });
  });

  it('starts once on the same words, and not at all while a turn is being answered', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const send = vi.spyOn(streaming, 'converseLive').mockImplementation(async request => {
      if (request.text === 'slow') await gate;
      return reply(`heard ${request.text}`, 'resp-x');
    });
    speculate('下一步', options);
    speculate('下一步。', options);
    expect(send).toHaveBeenCalledTimes(1);
    const slow = converse('slow', options);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    speculate('上一步', options);
    expect(send).toHaveBeenCalledTimes(2);
    release();
    await slow;
  });
});
