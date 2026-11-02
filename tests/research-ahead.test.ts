import { describe, expect, it, vi } from 'vitest';
import type { ConverseContext, FoundProtocol } from '../shared/ai.ts';
import { createConversation } from '../server/ai/conversation.ts';
import { EvidenceRegistry } from '../server/ai/evidence.ts';

// Research for the science specialist begins at the handoff, while the specialist is being called, and is collected by
// its research_science call; a specialist that answers without asking lets it go.

type Json = Record<string, any>;
const message = (text: string, id = 'response_final') => ({ id, output: [{ type: 'message', content: [{ type: 'output_text', text }] }] });
const calls = (items: { name: string; id: string; args: object }[], id = 'response_tools') => ({ id, output: items.map(c => ({ type: 'function_call', call_id: c.id, name: c.name, arguments: JSON.stringify(c.args) })) });
const never = async () => ({ data: { ok: false, error: 'This test never imports a protocol' } });
const notFound = async (): Promise<FoundProtocol> => ({ found: false, answer: '', sources: [], progress: [] });
const context: ConverseContext = { screen: 'chat' };
const handoff = (brief: string) => calls([{ name: 'transfer_to_science', id: 'hand', args: { brief } }], 'front');

describe('research ahead of the science specialist', () => {
  it('starts at the handoff, with the brief, and is what the specialist gets when it asks', async () => {
    const order: string[] = [];
    const researchScience = vi.fn(async (task: string, _live: unknown, _ms: number, registry: EvidenceRegistry) => {
      order.push('research');
      registry.register([[{ url: 'https://example.org/bca', title: 'BCA paper' }]], 12);
      return { data: { report: `evidence for ${JSON.parse(task).question}` } };
    });
    const respond = vi.fn(async (_body: Json) => {
      order.push(`respond ${respond.mock.calls.length}`);
      switch (respond.mock.calls.length) {
        case 1: return handoff('為什麼 BCA 會變紫色？');
        case 2: return calls([{ name: 'research_science', id: 'ask', args: { question: 'Why does the BCA reaction turn purple?' } }], 'science_1');
        default: return message('Because Cu⁺ and BCA form a purple complex.', 'science_2');
      }
    });
    const converse = createConversation({ respond, researchScience, findProtocol: notFound, importProtocol: never });
    const reply = await converse({ text: '為什麼會變紫？', context, history: [{ role: 'user', text: 'I am running BCA' }] });
    expect(reply.say).toBe('Because Cu⁺ and BCA form a purple complex.');
    expect(researchScience).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['respond 1', 'research', 'respond 2', 'respond 3']);
    const task = JSON.parse(researchScience.mock.calls[0]![0]);
    expect(task).toMatchObject({ question: '為什麼 BCA 會變紫色？', originalUserMessage: '為什麼會變紫？', recentConversation: [{ role: 'user', text: 'I am running BCA' }] });
    const output = respond.mock.calls[2]![0].input.find((i: Json) => i.type === 'function_call_output' && i.call_id === 'ask');
    expect(JSON.parse(output.output)).toEqual({ report: 'evidence for 為什麼 BCA 會變紫色？' });
  });

  it('shows a first part from memory at the handoff, plain, and keeps it until the reviewed answer replaces it', async () => {
    const shown: string[] = [];
    const respond = vi.fn(async (body: Json, live: { onText?: (delta: string) => void }) => {
      if (body.prompt_cache_key === 'chapp-quick') {
        expect(body.reasoning).toEqual({ effort: 'minimal' });
        expect(body.input.at(-1)).toEqual({ role: 'user', content: '為什麼 BCA 會變紫色？' });
        return message('BCA 變紫是 Cu⁺ 與 BCA 螯合的顏色。[[S1]] 詳見 https://example.org/paper 。', 'quick');
      }
      if (body.prompt_cache_key === 'chapp-front') return handoff('為什麼 BCA 會變紫色？');
      // The specialist's own draft streams nothing once the first part is on screen; the reply replaces it whole.
      live.onText?.('Because Cu⁺ and BCA form a purple complex, as the paper shows.');
      return message('Because Cu⁺ and BCA form a purple complex, as the paper shows.', 'science');
    });
    const researchScience = vi.fn(async () => ({ data: { report: 'none needed' } }));
    const converse = createConversation({ respond, researchScience, findProtocol: notFound, importProtocol: never });
    const reply = await converse({ text: '為什麼會變紫？', context }, { onText: delta => shown.push(delta) });
    expect(reply.say).toBe('Because Cu⁺ and BCA form a purple complex, as the paper shows.');
    expect(shown).toEqual(['先說我記得的，原文還在查：\n\nBCA 變紫是 Cu⁺ 與 BCA 螯合的顏色。 詳見  。\n\n']);
    expect(respond.mock.calls.map(c => c[0].prompt_cache_key).sort()).toEqual(['chapp-front', 'chapp-quick', 'chapp-science']);
  });

  it('is let go when the specialist answers without asking, and a second request in the turn is refused', async () => {
    let signal: AbortSignal | undefined;
    const researchScience = vi.fn((_task: string, live: { signal?: AbortSignal }) => new Promise<never>((_, reject) => {
      signal = live.signal;
      live.signal?.addEventListener('abort', () => reject(new DOMException('let go', 'AbortError')));
    }));
    const respond = vi.fn(async (_body: Json) => respond.mock.calls.length === 1 ? handoff('what is a blank?') : message('A blank is the well with no protein.'));
    const converse = createConversation({ respond, researchScience, findProtocol: notFound, importProtocol: never });
    const reply = await converse({ text: 'what is a blank?', context });
    expect(reply.say).toBe('A blank is the well with no protein.');
    expect(researchScience).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(true);

    const twice = vi.fn(async (_body: Json) => {
      switch (twice.mock.calls.length) {
        case 1: return handoff('why purple?');
        case 2: return calls([{ name: 'research_science', id: 'first', args: { question: 'Why purple at all?' } }, { name: 'research_science', id: 'second', args: { question: 'And why not blue?' } }], 'science_1');
        default: return message('Purple.', 'science_2');
      }
    });
    const quick = vi.fn(async () => ({ data: { report: 'one brief' } }));
    const again = createConversation({ respond: twice, researchScience: quick, findProtocol: notFound, importProtocol: never });
    await again({ text: 'why purple?', context });
    expect(quick).toHaveBeenCalledTimes(1);
    const outputs = Object.fromEntries(twice.mock.calls[2]![0].input.filter((i: Json) => i.type === 'function_call_output').map((i: Json) => [i.call_id, JSON.parse(i.output)]));
    expect(outputs.first).toEqual({ report: 'one brief' });
    expect(outputs.second).toMatchObject({ ok: false, error: expect.stringContaining('already requested') });
  });
});
