import { describe, expect, it, vi } from 'vitest';
import type { ConverseContext, FoundProtocol } from '../shared/ai.ts';
import { AGENTS, agentPrompt, handoffTarget, turnState } from '../server/ai/agents.ts';
import { createConversation } from '../server/ai/conversation.ts';
import { actionFromArguments } from '../server/ai/conversationTools.ts';

type Json = Record<string, any>;
const message = (text: string, id = 'response_final') => ({ id, output: [{ type: 'message', content: [{ type: 'output_text', text }] }] });
const calls = (items: { name: string; id: string; args: object }[], id = 'response_tools') => ({ id, output: items.map(c => ({ type: 'function_call', call_id: c.id, name: c.name, arguments: JSON.stringify(c.args) })) });
const never = async () => ({ data: { ok: false, error: 'This test never imports a protocol' } });
const notFound = async (): Promise<FoundProtocol> => ({ found: false, answer: '', sources: [], progress: [] });
const context: ConverseContext = { screen: 'run', protocolId: 'pierce-bca', procedure: 'microplate', step: 1, samples: 12, replicates: 2 };
const names = (tools: Json[]) => tools.map(t => t.name ?? t.type);

describe('the front assistant and its specialists', () => {
  it('gives the front assistant the bench, the library and the handoffs, and each specialist its own tools', () => {
    expect(names(AGENTS.front.tools)).toEqual(['perform_action', 'propose_action', 'accept_proposal', 'read_run', 'preview_protocol', 'transfer_to_science', 'transfer_to_manual', 'transfer_to_numbers']);
    expect(names(AGENTS.science.tools)).toEqual(expect.arrayContaining(['web_search', 'research_science', 'read_source', 'transfer_to_front']));
    expect(names(AGENTS.science.tools)).not.toContain('perform_action');
    expect(names(AGENTS.manual.tools)).toEqual(expect.arrayContaining(['find_protocol', 'preview_protocol', 'import_protocol', 'read_source', 'transfer_to_front']));
    expect(names(AGENTS.numbers.tools)).toEqual(expect.arrayContaining(['calculate_plan', 'calculate_solution', 'analyze_results', 'show_card', 'perform_action']));
    for (const agent of Object.keys(AGENTS) as (keyof typeof AGENTS)[]) expect(names(AGENTS[agent].tools)).not.toContain(`transfer_to_${agent}`);
    expect(handoffTarget('transfer_to_science')).toBe('science');
    expect(handoffTarget('transfer_to_nobody')).toBeNull();
    expect(handoffTarget('read_run')).toBeNull();
  });

  it('tells the front assistant to open a library protocol at once, and the manual specialist to ask only when the library has none', () => {
    const front = agentPrompt('front');
    expect(front).toContain('Chapp');
    expect(front).toMatch(/call preview_protocol with that protocolId at once, without asking/);
    expect(front).toContain('transfer_to_science');
    expect(front).not.toContain('research_science');
    const manual = agentPrompt('manual');
    expect(manual).toContain('Library first');
    expect(manual).toContain('ask one question');
    // The instructions are the same every turn; what changes goes with the turn (a developer message after the record).
    expect(front).not.toContain('Current state');
    expect(turnState({ screen: 'home' })).toContain('"screen":"home"');
    const state = turnState({ screen: 'home', step: 2 }, 'Earlier: the user mentioned a Bradford kit.');
    expect(state).toContain('"stepNumber":3');
    expect(state).toContain('Earlier: the user mentioned a Bradford kit.');
  });

  it('hands a question from the front assistant to the science specialist on the same chain, with its own prompt, tools and effort', async () => {
    const respond = vi.fn(async (_body: Json) => respond.mock.calls.length === 1
      ? calls([{ name: 'transfer_to_science', id: 'go', args: { brief: '為什麼 BCA 會變紫色？' } }], 'front_response')
      : message('BCA 變紫是 Cu⁺ 與 BCA 的螯合物。'));
    const onProgress = vi.fn();
    const converse = createConversation({ respond, findProtocol: notFound, importProtocol: never, efforts: { science: 'high' } });
    const reply = await converse({ text: '為什麼 BCA 會變紫色？', context }, { onProgress });
    expect(reply).toMatchObject({ say: 'BCA 變紫是 Cu⁺ 與 BCA 的螯合物。', actions: [], responseId: 'response_final' });
    const [first, second] = respond.mock.calls.map(c => c[0]);
    expect(first).toMatchObject({ reasoning: { effort: 'minimal' }, prompt_cache_key: 'chapp-front' });
    expect(names(first.tools)).toContain('transfer_to_science');
    expect(names(first.tools)).not.toContain('research_science');
    expect(second.previous_response_id).toBeUndefined();
    expect(second).toMatchObject({ reasoning: { effort: 'high' }, prompt_cache_key: 'chapp-science' });
    expect(names(second.tools)).toEqual(expect.arrayContaining(['web_search', 'research_science']));
    expect(second.instructions).toContain('science specialist');
    expect(second.instructions).not.toContain('You hear everything first');
    // Replayed, not chained: this turn's state, the user's words, the front's handoff call and its output, in order.
    expect(second.input[0]).toMatchObject({ role: 'developer', content: expect.stringContaining('"stepNumber":2') });
    expect(second.input[1]).toEqual({ role: 'user', content: '為什麼 BCA 會變紫色？' });
    expect(second.input.some((i: Json) => i.type === 'function_call' && i.name === 'transfer_to_science')).toBe(true);
    expect(second.input.at(-1)).toEqual({ type: 'function_call_output', call_id: 'go', output: expect.stringContaining('"handedTo":"science"') });
    expect(JSON.parse(second.input.at(-1).output).brief).toBe('為什麼 BCA 會變紫色？');
    expect(onProgress).toHaveBeenCalledWith('Looking into the science…');
  });

  it('runs a bench action in the browser first and lets the specialist take over after its receipt', async () => {
    const respond = vi.fn(async (_body: Json) => respond.mock.calls.length === 1
      ? calls([{ name: 'perform_action', id: 'set', args: { type: 'setSamples', value: 8 } }, { name: 'transfer_to_numbers', id: 'go', args: { brief: '8 個樣本要多少 working reagent？' } }])
      : message('8 個樣本的用量如下。'));
    const converse = createConversation({ respond, findProtocol: notFound, importProtocol: never });
    const request = { text: '改成 8 個樣本，然後算一下 reagent', context };
    const pending = await converse(request);
    expect(pending.pendingTools).toEqual([{ callId: 'set', action: { type: 'setSamples', samples: 8 } }]);
    const reply = await converse({ ...request, context: { ...context, samples: 8 }, continuationToken: pending.continuationToken, toolResults: [{ callId: 'set', ok: true, message: 'Samples: 8' }] });
    expect(reply.say).toBe('8 個樣本的用量如下。');
    const second = respond.mock.calls[1]![0];
    expect(second.prompt_cache_key).toBe('chapp-numbers');
    expect(names(second.tools)).toContain('calculate_plan');
    expect(second.input.filter((i: Json) => i.type === 'function_call_output').map((i: Json) => i.call_id)).toEqual(['go', 'set']);
    expect(JSON.parse(second.input.at(-1).output)).toMatchObject({ ok: true, message: 'Samples: 8', currentState: { samples: 8 } });
  });

  it('allows two handoffs a turn, one per response, and never to the specialist already answering', async () => {
    const respond = vi.fn(async (_body: Json) => {
      switch (respond.mock.calls.length) {
        case 1: return calls([{ name: 'transfer_to_science', id: 'h1', args: { brief: 'a' } }]);
        case 2: return calls([{ name: 'transfer_to_science', id: 'same', args: { brief: 'b' } }, { name: 'transfer_to_numbers', id: 'h2', args: { brief: 'c' } }]);
        case 3: return calls([{ name: 'transfer_to_manual', id: 'h3', args: { brief: 'd' } }]);
        default: return message('Answered with what I have.');
      }
    });
    const converse = createConversation({ respond, findProtocol: notFound, importProtocol: never });
    const reply = await converse({ text: 'x', context });
    expect(reply.say).toBe('Answered with what I have.');
    const outputs = (n: number) => Object.fromEntries(respond.mock.calls[n]![0].input.filter((i: Json) => i.type === 'function_call_output').map((i: Json) => [i.call_id, JSON.parse(i.output)]));
    expect(outputs(1).h1).toMatchObject({ handedTo: 'science' });
    expect(outputs(2).same).toMatchObject({ ok: false, error: expect.stringContaining('already that specialist') });
    expect(outputs(2).h2).toMatchObject({ handedTo: 'numbers' });
    expect(outputs(3).h3).toMatchObject({ ok: false, error: expect.stringContaining('limit') });
    expect(respond.mock.calls.map(c => c[0].prompt_cache_key)).toEqual(['chapp-front', 'chapp-science', 'chapp-numbers', 'chapp-numbers']);
  });

  it('starts every turn at the front again, whoever answered the last one', async () => {
    const respond = vi.fn(async (_body: Json) => respond.mock.calls.length === 1
      ? calls([{ name: 'transfer_to_science', id: 'go', args: { brief: 'why' } }], 'front_response')
      : message('Because.', `final_${respond.mock.calls.length}`));
    const converse = createConversation({ respond, findProtocol: notFound, importProtocol: never });
    const first = await converse({ text: 'why?', context });
    await converse({ text: 'thanks', context, previousResponseId: first.responseId });
    expect(respond.mock.calls.map(c => c[0].prompt_cache_key)).toEqual(['chapp-front', 'chapp-science', 'chapp-front']);
    // The next turn replays the server's own record of the last one (the words, the handoff, the answer), not a chain.
    const replayed = respond.mock.calls[2]![0].input;
    expect(respond.mock.calls[2]![0].previous_response_id).toBeUndefined();
    expect(replayed[0]).toEqual({ role: 'user', content: 'why?' });
    expect(replayed.some((i: Json) => i.type === 'function_call' && i.name === 'transfer_to_science')).toBe(true);
    expect(JSON.stringify(replayed)).toContain('Because.');
    expect(replayed.at(-1)).toEqual({ role: 'user', content: 'thanks' });
  });

  it('reads an operation the model put in target as the operation itself', () => {
    expect(actionFromArguments({ target: 'nextStep' }, context)).toEqual({ type: 'nextStep' });
    expect(actionFromArguments({ type: 'markDone', target: 'vial-a' }, context)).toEqual({ type: 'markDone', id: 'vial-a' });
  });

  it('sets how the standards are made by name ("five standards" is the five-vial way)', () => {
    expect(actionFromArguments({ type: 'setStandards', target: 'five' }, context)).toEqual({ type: 'setStandards', standards: 'five' });
    expect(actionFromArguments({ type: 'setStandards', target: 'Kit' }, context)).toEqual({ type: 'setStandards', standards: 'kit' });
    expect(() => actionFromArguments({ type: 'setStandards', target: 'seven' }, context)).toThrow();
  });
});
