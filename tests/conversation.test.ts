import { describe, expect, it, vi } from 'vitest';
import type { ConverseContext, FoundProtocol } from '../shared/ai.ts';
import { createConversation } from '../server/ai/conversation.ts';
import { UpstreamError } from '../server/ai/provider.ts';

type Json = Record<string, any>;
const message = (text: string, id = 'response_final') => ({ id, output: [{ type: 'message', content: [{ type: 'output_text', text }] }] });
const calls = (items: { name: string; id: string; args: object }[]) => ({ id: 'response_tools', output: items.map(c => ({ type: 'function_call', call_id: c.id, name: c.name, arguments: JSON.stringify(c.args) })) });
const unusedImport = async () => ({ data: { ok: false, error: 'This test never imports a protocol' } });
const notFound = async (): Promise<FoundProtocol> => ({ found: false, answer: 'No document', sources: [], progress: [] });
const context: ConverseContext = { screen: 'plan', protocolId: 'pierce-bca', procedure: 'microplate', samples: 12, replicates: 2 };
const action = () => calls([{ name: 'perform_action', id: 'set_samples', args: { type: 'setSamples', value: 11 } }]);

describe('conversation tool orchestration', () => {
  it('delegates the original scientific question and recent conversation, then returns cited evidence without mutations', async () => {
    const source = { url: 'https://example.org/original-assay-study', title: 'Original assay study' };
    const researchScience = vi.fn(async (_question: string, _live: unknown, _milliseconds: number) => ({ data: { report: 'This pattern alone does not establish its cause.', sources: [source] }, sources: [source] }));
    const respond = vi.fn(async (_body: Json) => respond.mock.calls.length === 1
      ? calls([{ name: 'research_science', id: 'research', args: { question: 'Does dilution nonparallelism prove matrix suppression?' } }])
      : message('There are several possible explanations. An independent reference can test the shared calibration bias.'));
    const converse = createConversation({ respond, researchScience, findProtocol: notFound, importProtocol: unusedImport, timeoutMs: 90_000 });
    const history = Array.from({ length: 6 }, (_, i) => ({ role: i % 2 ? 'chapp' as const : 'user' as const, text: i === 4 ? 'The calibrator stock may be thirty percent lower than its label. ' + 'x'.repeat(12_000) : `earlier context ${i}` }));
    const text = 'After correcting dilution factors I get 200, 140 and 90. Does that prove suppression?';
    const original = structuredClone(context);
    const onProgress = vi.fn();
    const reply = await converse({ text, context, history }, { onProgress });
    expect(researchScience).toHaveBeenCalledTimes(1);
    const task = JSON.parse(researchScience.mock.calls[0]![0]);
    expect(task.originalUserMessage).toBe(text);
    expect(task.question).toBe('Does dilution nonparallelism prove matrix suppression?');
    expect(task.recentConversation).toEqual(history.slice(-4).map(t => ({ ...t, text: t.text.slice(0, 12_000) })));
    expect(researchScience.mock.calls[0]![2]).toBeGreaterThan(0);
    expect(researchScience.mock.calls[0]![2]).toBeLessThanOrEqual(90_000);
    expect(onProgress).toHaveBeenCalledWith('Checking the scientific sources…');
    expect(respond.mock.calls[1]![0].previous_response_id).toBeUndefined();
    expect(JSON.parse(respond.mock.calls[1]![0].input.at(-1).output)).toMatchObject({ report: 'This pattern alone does not establish its cause.' });
    expect(reply.sources).toEqual([source]);
    expect(reply.pendingTools).toBeUndefined();
    expect(reply.actions).toEqual([]);
    expect(context).toEqual(original);
  });

  it('allows at most one scientific research call per turn, including concurrent requests, and resets for the next turn', async () => {
    const researchScience = vi.fn(async () => ({ data: { report: null, retrieved: [], limitation: 'No verified evidence found.' } }));
    const respond = vi.fn(async (_body: Json) => respond.mock.calls.length % 2 === 1 ? calls([
      { name: 'research_science', id: 'research_once', args: { question: 'Check the calibration assumptions.' } },
      { name: 'research_science', id: 'research_twice', args: { question: 'Check them again independently.' } },
    ]) : message('The available evidence is insufficient; no change was made.'));
    const converse = createConversation({ respond, researchScience, findProtocol: notFound, importProtocol: unusedImport });
    for (let turn = 1; turn <= 2; turn++) {
      const reply = await converse({ text: `Scientific question ${turn}`, context });
      expect(researchScience).toHaveBeenCalledTimes(turn);
      const outputs = respond.mock.calls[turn * 2 - 1]![0].input;
      expect(JSON.parse(outputs.find((o: Json) => o.type === 'function_call_output' && o.call_id === 'research_twice').output)).toMatchObject({ ok: false, error: expect.stringContaining('already requested in this turn') });
      expect(reply.pendingTools).toBeUndefined();
    }
  });

  it('starts independent manufacturer searches together, then sends both results in model order', async () => {
    const started: string[] = [];
    const release = new Map<string, (value: FoundProtocol) => void>();
    const respond = vi.fn(async (_body: Json) => respond.mock.calls.length === 1
      ? calls([{ name: 'find_protocol', id: 'find_bca', args: { query: 'Pierce BCA' } }, { name: 'find_protocol', id: 'find_bradford', args: { query: 'Pierce Bradford' } }])
      : message('Both original manuals are available; your current run is unchanged.'));
    const converse = createConversation({
      respond, importProtocol: unusedImport,
      findProtocol: query => { started.push(query); return new Promise(resolve => { release.set(query, resolve); }); },
    });
    const before = structuredClone(context);
    const result = converse({ text: 'Compare the manufacturer manuals for BCA and Bradford; leave my experiment alone.', context });
    // Neither first search can finish until the second has started. A sequential
    // implementation fails here instead of merely passing a two-result assertion.
    await vi.waitFor(() => expect(started).toEqual(['Pierce BCA', 'Pierce Bradford']));
    expect(respond).toHaveBeenCalledTimes(1);
    release.get('Pierce Bradford')!({ found: true, progress: [], answer: 'Bradford manufacturer evidence', sources: [{ url: 'https://www.thermofisher.com/bradford' }] });
    release.get('Pierce BCA')!({ found: true, progress: [], answer: 'BCA manufacturer evidence', sources: [{ url: 'https://www.thermofisher.com/bca' }] });
    const reply = await result;
    expect(respond).toHaveBeenCalledTimes(2);
    const input = respond.mock.calls[1]![0].input.filter((i: Json) => i.type === 'function_call_output');
    expect(input.map((i: Json) => i.call_id)).toEqual(['find_bca', 'find_bradford']);
    expect(JSON.parse(input[0].output)).toMatchObject({ found: true, sourceIds: [{ id: expect.any(String), status: 'searched' }] });
    expect(JSON.parse(input[0].output).answer).toBeUndefined();
    expect(JSON.parse(input[1].output)).toMatchObject({ found: true, sourceIds: [{ id: expect.any(String), status: 'searched' }] });
    expect(reply.sources).toHaveLength(0);
    expect(reply.pendingTools).toBeUndefined();
    expect(context).toEqual(before);
  });

  it('rejects absent, substituted and duplicated browser receipts before making another model call', async () => {
    const respond = vi.fn(async (_body: Json) => respond.mock.calls.length === 1 ? action() : message('The app confirmed eleven samples.'));
    const converse = createConversation({ respond, findProtocol: notFound, importProtocol: unusedImport });
    const request = { text: 'Please correct the sample count to eleven.', context };
    const pending = await converse(request);
    const resume = { ...request, continuationToken: pending.continuationToken };
    for (const toolResults of [[], [{ callId: 'invented_call', ok: true, message: 'Done' }], [{ callId: 'set_samples', ok: true, message: 'Done' }, { callId: 'set_samples', ok: true, message: 'Done' }]]) {
      await expect(converse({ ...resume, toolResults })).rejects.toThrow('exactly once');
    }
    expect(respond).toHaveBeenCalledTimes(1);
    const receipts = [{ callId: 'set_samples', ok: true, message: 'Updated to 11 samples.' }];
    const completed = await converse({ ...resume, context: { ...context, samples: 11 }, toolResults: receipts });
    // The app's receipt ends the front's operation: its own confirmation, no second model call.
    expect(completed.say).toBe('11 samples.');
    expect(await converse({ ...resume, context: { ...context, samples: 11 }, toolResults: receipts })).toEqual(completed);
    expect(respond).toHaveBeenCalledTimes(1);
    await expect(converse({ ...resume, toolResults: [{ ...receipts[0]!, ok: false }] })).rejects.toThrow('Conflicting');
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it('resumes a failed answer using the same receipts without issuing the mutation a second time', async () => {
    const respond = vi.fn(async (_body: Json) => {
      if (respond.mock.calls.length === 1) return action();
      if (respond.mock.calls.length === 2) throw new UpstreamError('Connection interrupted after the browser executed the action');
      return message('The sample count could not be changed: readings are already on the plate.');
    });
    const converse = createConversation({ respond, findProtocol: notFound, importProtocol: unusedImport });
    const request = { text: 'Make it eleven samples.', context };
    const pending = await converse(request);
    // A failed operation is the model's to explain (a successful one ends with the app's own confirmation).
    const resume = { ...request, continuationToken: pending.continuationToken, toolResults: [{ callId: 'set_samples', ok: false, message: 'Readings are already on the plate; the layout was kept.' }] };
    await expect(converse(resume)).rejects.toThrow('Connection interrupted');
    const completed = await converse(resume);
    expect(completed.pendingTools).toBeUndefined();
    expect(respond).toHaveBeenCalledTimes(3);
    expect(respond.mock.calls[2]![0].input).toEqual(respond.mock.calls[1]![0].input);
    // The state as a developer message, the user's words, the call and its receipt.
    expect(respond.mock.calls[2]![0].input).toHaveLength(4);
    expect(respond.mock.calls[2]![0].input[0]).toMatchObject({ role: 'developer', content: expect.stringContaining('"samples":12') });
    expect(respond.mock.calls[2]![0].input.at(-1)).toMatchObject({ type: 'function_call_output', call_id: 'set_samples' });
    expect(respond.mock.calls[2]![0].previous_response_id).toBeUndefined();
  });

  it('accepts a saved proposal only once even when two calls in one response try to accept it', async () => {
    let proposalId = '';
    const respond = vi.fn(async (body: Json) => {
      if (respond.mock.calls.length === 1) return calls([{ name: 'propose_action', id: 'propose', args: { type: 'setReplicates', value: 3 } }]);
      if (respond.mock.calls.length === 2) {
        proposalId = JSON.parse(body.input.at(-1).output).proposalId;
        return message('We can use three replicates if you choose that plan.', 'response_proposal');
      }
      if (respond.mock.calls.length === 3) return calls([
        { name: 'accept_proposal', id: 'accept_first', args: { proposalId } },
        { name: 'accept_proposal', id: 'accept_duplicate', args: { proposalId } },
      ]);
      return message('The app applied the proposed plan once.');
    });
    const converse = createConversation({ respond, findProtocol: notFound, importProtocol: unusedImport });
    await converse({ text: 'What would three replicates involve? Do not change anything yet.', context });
    const pending = await converse({ text: 'Use that plan.', context, previousResponseId: 'response_proposal' });
    expect(pending.pendingTools).toEqual([{ callId: 'accept_first', action: { type: 'setReplicates', replicates: 3 } }]);
    await converse({ text: 'Use that plan.', context: { ...context, replicates: 3 }, continuationToken: pending.continuationToken,
      toolResults: [{ callId: 'accept_first', ok: true, message: 'Applied three replicates.' }],
    });
    const inputs = respond.mock.calls[3]![0].input;
    const outputOf = (callId: string) => JSON.parse(inputs.find((i: Json) => i.type === 'function_call_output' && i.call_id === callId).output);
    expect(outputOf('accept_duplicate')).toMatchObject({ ok: false, error: expect.stringContaining('no longer available') });
    expect(outputOf('accept_first')).toMatchObject({ ok: true });
  });

  it('rejects a stale proposal when the standards plan changed before acceptance', async () => {
    let proposalId = '';
    const respond = vi.fn(async (body: Json) => {
      if (respond.mock.calls.length === 1) return calls([{ name: 'propose_action', id: 'propose', args: { type: 'setReplicates', value: 3 } }]);
      if (respond.mock.calls.length === 2) {
        proposalId = JSON.parse(body.input.at(-1).output).proposalId;
        return message('Three replicates are an option.', 'response_proposal');
      }
      if (respond.mock.calls.length === 3) return calls([{ name: 'accept_proposal', id: 'accept', args: { proposalId } }]);
      return message('Your standards plan changed. I need to recalculate the proposal.');
    });
    const converse = createConversation({ respond, findProtocol: notFound, importProtocol: unusedImport });
    await converse({ text: 'Consider three replicates, but leave the plan as it is.', context: { ...context, standards: 'kit', standardReplicates: 2 } });
    const reply = await converse({ text: 'Use the option we discussed.', context: { ...context, standards: 'five', standardReplicates: 1 }, previousResponseId: 'response_proposal' });
    expect(reply.pendingTools).toBeUndefined();
    expect(JSON.parse(respond.mock.calls[3]![0].input.at(-1).output)).toMatchObject({ ok: false, error: expect.stringContaining('experiment has changed') });
  });
});

describe('conversation evidence boundaries', () => {
  const url = 'https://original.example/manual.pdf?edition=2';
  const doc = { url, title: 'Original manual', format: 'pdf' as const, pages: [{ page: 4, text: 'A negative control can produce nonspecific signal; this alone does not identify contamination.' }], fetchedAt: '2026-10-31T00:00:00Z' };

  it('reads the actual discovered manual, holds drafts, and returns the reviewed answer and chain', async () => {
    const readSource = vi.fn(async (_url: string) => doc);
    const seenText: string[] = [];
    const respond = vi.fn(async (_body: Json, live: any) => {
      if (respond.mock.calls.length === 1) return calls([{ name: 'find_protocol', id: 'find', args: { query: 'Original kit manual' } }]);
      live.onText?.('The draft claims something unverified [[S1:P4:1]].');
      return message('The draft claims something unverified [[S1:P4:1]].');
    });
    const reviewAnswer = vi.fn(async ({ registry }: any) => {
      expect(registry.get('S1')).toMatchObject({ status: 'read', document: doc });
      return { say: 'Reviewed answer.', sources: [{ url, page: 4 }], responseId: 'reviewed_chain', rejectedParagraphs: 0 };
    });
    const converse = createConversation({ respond, readSource, reviewAnswer, importProtocol: unusedImport,
      findProtocol: async () => ({ found: true, answer: 'Untrusted discovery prose', progress: [], sources: [{ url }], document: { title: 'Manual', url } }) });
    const reply = await converse({ text: 'Find the original manual; leave my run alone.', context }, { onText: delta => seenText.push(delta) });
    expect(readSource).toHaveBeenCalledTimes(1);
    expect(readSource.mock.calls[0]?.[0]).toBe(url);
    const toolData = JSON.parse(respond.mock.calls[1]![0].input.at(-1).output);
    expect(toolData).toMatchObject({ document: { sourceId: 'S1' }, original: { excerpts: [expect.objectContaining({ page: 4 })] } });
    expect(JSON.stringify(toolData)).not.toContain('Untrusted discovery prose');
    expect(seenText.join('')).not.toContain('unverified');
    expect(reply).toMatchObject({ say: 'Reviewed answer.', responseId: 'reviewed_chain', actions: [], sources: [{ url, page: 4 }] });
  });

  it('retains read evidence and the visible answer across turns without refetching', async () => {
    const readSource = vi.fn(async (_url: string) => doc);
    const respond = vi.fn(async (_body: Json) => respond.mock.calls.length === 1 ? calls([{ name: 'find_protocol', id: 'find', args: { query: 'Manual' } }]) : message(respond.mock.calls.length === 2 ? 'See [[S1:P4:1]].' : 'That observation alone does not prove the cause.'));
    const reviewAnswer = vi.fn(async ({ registry }: any) => ({ say: registry.renderCitations('See [[S1:P4:1]].').text, sources: [{ url, page: 4, quote: doc.pages[0]!.text }], responseId: `checked_${reviewAnswer.mock.calls.length}`, rejectedParagraphs: 0 }));
    const converse = createConversation({ respond, readSource, reviewAnswer, importProtocol: unusedImport,
      findProtocol: async () => ({ found: true, answer: '', progress: [], sources: [{ url }], document: { title: 'Manual', url } }) });
    const first = await converse({ text: 'Read the manual', context });
    const second = await converse({ text: 'Does that observation prove the cause?', context, previousResponseId: first.responseId });
    expect(readSource).toHaveBeenCalledTimes(1);
    expect(reviewAnswer).toHaveBeenCalledTimes(2);
    expect(second.sources).toEqual([{ url, page: 4, quote: doc.pages[0]!.text }]);
    // What the last turn showed and read goes with this turn's state (a developer message), not in the instructions.
    const state = respond.mock.calls[2]![0].input.find((i: Json) => i.role === 'developer').content;
    expect(state).toContain('The previous answer actually shown');
    expect(state).toContain('A negative control');
    expect(respond.mock.calls[2]![0].instructions).not.toContain('A negative control');
  });

  it('never streams a generated citation destination or lets one valid link validate another', async () => {
    const leaked: string[] = [];
    const respond = vi.fn(async (_body: Json, live: any) => {
      for (const delta of ['Found ', '[paper](', 'https://invented.example/', ') and [[S999]].']) live.onText?.(delta);
      return message('Found [paper](https://invented.example/) and [[S999]].');
    });
    const converse = createConversation({ respond, findProtocol: notFound, importProtocol: unusedImport });
    const reply = await converse({ text: 'Explain this source.', context }, { onText: delta => leaked.push(delta) });
    expect(leaked.join('')).not.toContain('invented.example');
    expect(reply.say).not.toContain('](https://invented.example/');
    expect(reply.sources).toEqual([]);
  });
});
