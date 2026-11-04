import { describe, expect, it, vi } from 'vitest';
import type { ConverseContext, FoundProtocol } from '../shared/ai.ts';
import { confirmation } from '../server/ai/confirm.ts';
import { createConversation } from '../server/ai/conversation.ts';

// A bench operation ends with the app's receipt: the app confirms it itself, so a command is one model call, or none
// at all when the app performed it through `route`.

type Json = Record<string, any>;
const message = (text: string, id = 'response_final') => ({ id, output: [{ type: 'message', content: [{ type: 'output_text', text }] }] });
const calls = (items: { name: string; id: string; args: object }[], id = 'response_tools') => ({ id, output: items.map(c => ({ type: 'function_call', call_id: c.id, name: c.name, arguments: JSON.stringify(c.args) })) });
const never = async () => ({ data: { ok: false, error: 'This test never imports a protocol' } });
const notFound = async (): Promise<FoundProtocol> => ({ found: false, answer: '', sources: [], progress: [] });
const context: ConverseContext = { screen: 'run', protocolId: 'pierce-bca', procedure: 'microplate', step: 1, samples: 12, replicates: 2 };
/** The record as the model sees it, without this turn's state (a developer message that precedes this turn's words). */
const said = (input: Json[]) => input.filter(i => i.role !== 'developer');
const kinds = (input: Json[]) => said(input).map(i => i.type ?? i.role);

describe("a bench operation ends with the app's receipt", () => {
  it("confirms the front assistant's operation itself, in the user's language, with no second model call, and the next turn replays it", async () => {
    const respond = vi.fn(async (_body: Json) => respond.mock.calls.length === 1 ? calls([{ name: 'perform_action', id: 'go', args: { type: 'nextStep' } }], 'front_1') : message('這一步要加 working reagent。', 'front_2'));
    const converse = createConversation({ respond, findProtocol: notFound, importProtocol: never });
    const pending = await converse({ text: '好 下一步', context });
    expect(pending.pendingTools).toEqual([{ callId: 'go', action: { type: 'nextStep' } }]);
    const done = await converse({ text: '好 下一步', context: { ...context, step: 2 }, continuationToken: pending.continuationToken, toolResults: [{ callId: 'go', ok: true, message: 'Moved to step 3: Load the plate.' }] });
    expect(done).toMatchObject({ say: '好，下一步。', responseId: 'front_1', actions: [] });
    expect(respond).toHaveBeenCalledTimes(1);
    await converse({ text: '這一步要做什麼？', context: { ...context, step: 2 }, previousResponseId: 'front_1' });
    const input = said(respond.mock.calls[1]![0].input);
    expect(kinds(input)).toEqual(['user', 'function_call', 'function_call_output', 'assistant', 'user']);
    expect(input[3]).toEqual({ role: 'assistant', content: '好，下一步。' });
    expect(JSON.parse(input[2].output)).toMatchObject({ ok: true, message: 'Moved to step 3: Load the plate.' });
    expect(respond.mock.calls[1]![0].input.at(-2)).toMatchObject({ role: 'developer', content: expect.stringContaining('"stepNumber":3') });
  });

  it('answers in the language the user spoke', () => {
    expect(confirmation([{ type: 'setSamples', samples: 11 }], 'take one out')).toBe('11 samples.');
    expect(confirmation([{ type: 'nextStep' }, { type: 'startTimer', id: 'm-incubate', seconds: 1800 }], 'next and start the timer')).toBe('Next step. Timer started.');
    expect(confirmation([{ type: 'setReplicates', replicates: 3 }], '改成三重複')).toBe('三重複。');
    expect(confirmation([{ type: 'markDone', id: 'B' }], 'B 好了')).toBe('好，B 記下了。');
  });

  it("still asks the model after a failure, and after a specialist's own operation", async () => {
    const respond = vi.fn(async (_body: Json) => respond.mock.calls.length === 1 ? calls([{ name: 'perform_action', id: 'back', args: { type: 'previousStep' } }]) : message('這已經是第一步了，沒有改動。'));
    const converse = createConversation({ respond, findProtocol: notFound, importProtocol: never });
    const pending = await converse({ text: '上一步', context: { ...context, step: 0 } });
    const done = await converse({ text: '上一步', context: { ...context, step: 0 }, continuationToken: pending.continuationToken, toolResults: [{ callId: 'back', ok: false, message: 'Already at the first step.' }] });
    expect(done.say).toBe('這已經是第一步了，沒有改動。');
    expect(respond).toHaveBeenCalledTimes(2);
    expect(JSON.parse(respond.mock.calls[1]![0].input.at(-1).output)).toMatchObject({ ok: false, message: 'Already at the first step.' });

    const specialist = vi.fn(async (_body: Json) => specialist.mock.calls.length === 1
      ? calls([{ name: 'transfer_to_numbers', id: 'hand', args: { brief: '改成三重複' } }], 'front')
      : specialist.mock.calls.length === 2 ? calls([{ name: 'perform_action', id: 'set', args: { type: 'setReplicates', value: 3 } }], 'numbers_1') : message('三重複：全部 54 孔，working reagent 要 12 mL。', 'numbers_2'));
    const talk = createConversation({ respond: specialist, findProtocol: notFound, importProtocol: never });
    const waiting = await talk({ text: '改成三重複', context });
    expect(waiting.pendingTools).toEqual([{ callId: 'set', action: { type: 'setReplicates', replicates: 3 } }]);
    const said = await talk({ text: '改成三重複', context: { ...context, replicates: 3 }, continuationToken: waiting.continuationToken, toolResults: [{ callId: 'set', ok: true, message: 'Replicates: 3.' }] });
    expect(said.say).toBe('三重複：全部 54 孔，working reagent 要 12 mL。');
    expect(specialist).toHaveBeenCalledTimes(3);
    expect(specialist.mock.calls[2]![0].prompt_cache_key).toBe('chapp-numbers');
  });
});

describe('a command performed without a model call', () => {
  it('performs a routed command with no model call, confirms it, and records the turn for the next one', async () => {
    const respond = vi.fn(async (_body: Json) => message('這一步要加 working reagent。', 'front_2'));
    const route = vi.fn(async (request: { text: string }) => request.text === '下一步' ? { type: 'nextStep' as const } : null);
    const converse = createConversation({ respond, route, findProtocol: notFound, importProtocol: never });
    const pending = await converse({ text: '下一步', context });
    expect(pending.pendingTools).toHaveLength(1);
    const call = pending.pendingTools![0]!;
    expect(call.callId).toMatch(/^route_/);
    expect(call.action).toEqual({ type: 'nextStep' });
    expect(respond).not.toHaveBeenCalled();
    const done = await converse({ text: '下一步', context: { ...context, step: 2 }, continuationToken: pending.continuationToken, toolResults: [{ callId: call.callId, ok: true, message: 'Moved to step 3.' }] });
    expect(done.say).toBe('好，下一步。');
    expect(done.responseId).toMatch(/^local_/);
    expect(respond).not.toHaveBeenCalled();
    await converse({ text: '這一步要做什麼？', context: { ...context, step: 2 }, previousResponseId: done.responseId });
    expect(said(respond.mock.calls[0]![0].input)).toEqual([{ role: 'user', content: '下一步' }, { role: 'assistant', content: '好，下一步。' }, { role: 'user', content: '這一步要做什麼？' }]);
  });

  it('tells the model what the app could not do, as the call it would have made', async () => {
    const respond = vi.fn(async (_body: Json) => message('這已經是第一步了。'));
    const converse = createConversation({ respond, route: async () => ({ type: 'previousStep' as const }), findProtocol: notFound, importProtocol: never });
    const pending = await converse({ text: '上一步', context: { ...context, step: 0 } });
    const done = await converse({ text: '上一步', context: { ...context, step: 0 }, continuationToken: pending.continuationToken, toolResults: [{ callId: pending.pendingTools![0]!.callId, ok: false, message: 'Already at the first step.' }] });
    expect(done.say).toBe('這已經是第一步了。');
    const input = said(respond.mock.calls[0]![0].input);
    expect(kinds(input)).toEqual(['user', 'function_call', 'function_call_output']);
    expect(input[1]).toMatchObject({ type: 'function_call', name: 'perform_action', arguments: '{"type":"previousStep"}' });
    expect(JSON.parse(input[2].output)).toMatchObject({ ok: false, message: 'Already at the first step.' });
  });
});
