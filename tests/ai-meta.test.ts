import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConverseContext, FoundProtocol } from '../shared/ai.ts';
import { createMetaProvider, documentWatcher, isVendorUrl, parseFound, splitDetails } from '../server/ai/meta.ts';
import { UpstreamError } from '../server/ai/provider.ts';
import { BCA } from '../server/ai/protocols.ts';
import { readSource } from '../server/ai/sourceReader.ts';

vi.mock('../server/ai/sourceReader.ts', () => ({ readSource: vi.fn() }));
beforeEach(() => {
  vi.mocked(readSource).mockReset().mockRejectedValue(new Error('No original-document fixture was supplied; network reads are disabled in this test.'));
});

// The Meta provider against a fake fetch: request shapes, parsing, retries, timeouts and errors. No network.

const KEY = 'test-key-never-shown';
const local = existsSync(new URL('../data/protocols/pierce-bca.json', import.meta.url));
const home: ConverseContext = { screen: 'home', protocolId: null };

type Call = { url: string; init: RequestInit };
/** A fetch that answers each call with the next of `answers` (a body, a status + body, or an Error to throw). */
function fakeFetch(...answers: (unknown | { status: number; body: unknown } | Error)[]) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = answers.shift();
    if (next instanceof Error) throw next;
    const wrapped = next && typeof next === 'object' && typeof (next as { status?: unknown }).status === 'number';
    const { status, body } = wrapped ? (next as { status: number; body: unknown }) : { status: 200, body: next };
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const provider = (fetch: typeof globalThis.fetch, timeouts = {}) => createMetaProvider({ apiKey: KEY, fetch, log: () => {}, timeouts });
/** A Responses API reply whose message is `content`, as Muse Spark answers converse. */
const said = (content: unknown, id = 'resp_1') => ({ id, status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: typeof content === 'string' ? content : JSON.stringify(content) }] }] });
const toolReply = (calls: { name: string; arguments?: object; callId: string }[], id = 'resp_tools') => ({ id, status: 'completed', output: calls.map(c => ({ type: 'function_call', name: c.name, arguments: JSON.stringify(c.arguments ?? {}), call_id: c.callId, status: 'completed' })) });

describe('meta converse', () => {
  it('answers naturally without forcing JSON, truncating explanations, or interpreting the user with a command grammar', async () => {
    const explanation = 'A high R² describes how the fitted line follows the calibration points; it does not by itself establish that an unknown sample is accurate. '.repeat(7);
    const { fn, calls } = fakeFetch(said(explanation));
    const reply = await provider(fn).converse({ text: 'The curve looks beautiful, but my unknowns disagree. Help me reason through why.', context: home });
    expect(reply.say).toBe(explanation.trim());
    expect(reply.say.length).toBeGreaterThan(600);
    expect(reply.actions).toEqual([]);
    expect(reply.pendingTools).toBeUndefined();
    expect(reply.responseId).toBe('resp_1');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.meta.ai/v1/responses');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.model).toBe('muse-spark-1.3');
    expect(body.text?.format?.type).not.toBe('json_schema');
    // The front assistant hears it first: the lowest effort, the bench and the library, and the handoffs.
    expect(body.reasoning).toEqual({ effort: 'minimal' });
    expect(body.tools.some((t: { type: string }) => t.type === 'web_search')).toBe(false);
    expect(body.tools.map((t: { name?: string }) => t.name)).toEqual(expect.arrayContaining(['read_run', 'preview_protocol', 'perform_action', 'transfer_to_science', 'transfer_to_manual', 'transfer_to_numbers']));
    expect(body.prompt_cache_key).toBe('chapp-front');
    expect(body.instructions).toContain('Chapp');
    expect(body.instructions).not.toContain('one or two short sentences');
    expect(body.previous_response_id).toBeUndefined();
  });

  it('continues the conversation from the words the phone sends, statelessly, with the instructions every time', async () => {
    const { fn, calls } = fakeFetch(said('The second explanation was sample interference.', 'resp_2'));
    const reply = await provider(fn).converse({ text: 'Can you expand the second explanation?', context: home, history: [{ role: 'user', text: 'Why could it fail?' }, { role: 'chapp', text: 'Calibration range, sample interference, or handling.' }], previousResponseId: 'resp_1' });
    expect(reply.responseId).toBe('resp_2');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.previous_response_id).toBeUndefined();
    expect(body.include).toEqual(['web_search_call.results', 'reasoning.encrypted_content']);
    expect(body.input.filter((m: { role?: string }) => m.role !== 'developer')).toEqual([
      { role: 'user', content: 'Why could it fail?' },
      { role: 'assistant', content: 'Calibration range, sample interference, or handling.' },
      { role: 'user', content: 'Can you expand the second explanation?' },
    ]);
    // This turn's state goes after the record and before the new words, so the record stays a cached prefix.
    expect(body.input.at(-2)).toMatchObject({ role: 'developer', content: expect.stringContaining('"screen":"home"') });
    expect(body.instructions).toContain('Chapp');
    expect(body.instructions).not.toContain('Current state');
  });

  it('falls back to the phone\'s text history when the server has no record of the response id it was sent', async () => {
    const { fn, calls } = fakeFetch(said('You called sample B Moon.'));
    const reply = await provider(fn).converse({ text: 'What did I call the second sample?', context: home, history: [{ role: 'user', text: 'A is Star and B is Moon.' }, { role: 'chapp', text: 'I will use those names.' }], previousResponseId: 'resp_gone' });
    expect(reply.say).toBe('You called sample B Moon.');
    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.previous_response_id).toBeUndefined();
    expect(body.input.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant', 'developer', 'user']);
    expect(JSON.stringify(body.input)).toContain('A is Star and B is Moon.');
  });

  it.each([false, true])('replays this turn whole, its reasoning only when encrypted, and the next turn from its own record without it (%s)', async encrypted => {
    const response = toolReply([{ name: 'read_run', callId: 'read_state' }]);
    const reasoning = { type: 'reasoning', id: encrypted ? 'reasoning_portable' : 'reasoning_bare', ...(encrypted ? { encrypted_content: 'opaque-encrypted-context' } : {}) };
    const { fn, calls } = fakeFetch(
      { ...response, output: [reasoning, ...response.output] },
      said('Your plan still has twelve samples and two replicates.', 'resp_recovered'),
      said('Still twelve.', 'resp_next'),
    );
    const history = [{ role: 'user' as const, text: 'Keep my current plan unchanged.' }, { role: 'chapp' as const, text: 'I will only read it.' }];
    const p = provider(fn);
    const context: ConverseContext = { screen: 'plan', samples: 12, replicates: 2 };
    const reply = await p.converse({ text: 'What are the current counts?', context, history });
    expect(reply.responseId).toBe('resp_recovered');
    expect(calls).toHaveLength(2);
    const bodies = calls.map(c => JSON.parse(String(c.init.body)));
    for (const body of bodies) {
      expect(body.previous_response_id).toBeUndefined();
      expect(body.include).toEqual(['web_search_call.results', 'reasoning.encrypted_content']);
    }
    const continuation = bodies[1];
    expect(continuation.input.filter((item: { role?: string }) => item.role !== 'developer').slice(0, 3)).toEqual([
      { role: 'user', content: history[0].text },
      { role: 'assistant', content: history[1].text },
      { role: 'user', content: 'What are the current counts?' },
    ]);
    expect(continuation.input.filter((item: { type: string }) => item.type === 'reasoning')).toEqual(encrypted ? [{ ...reasoning, summary: [] }] : []);
    expect(JSON.stringify(continuation.input)).not.toContain('reasoning_bare');
    const toolPair = continuation.input.filter((item: { type: string }) => item.type === 'function_call' || item.type === 'function_call_output');
    expect(toolPair).toHaveLength(2);
    expect(toolPair[0]).toMatchObject({ type: 'function_call', name: 'read_run', call_id: 'read_state' });
    expect(toolPair[1]).toMatchObject({ type: 'function_call_output', call_id: 'read_state' });
    expect(JSON.parse(toolPair[1].output)).toMatchObject({ current: { samples: 12, replicates: 2 } });
    // The next turn: the server's record of what was said and done, without the reasoning, then the new words.
    await p.converse({ text: 'And now?', context, history: [], previousResponseId: 'resp_recovered' });
    const next = JSON.parse(String(calls[2].init.body));
    expect(next.previous_response_id).toBeUndefined();
    expect(next.input.filter((item: { type: string }) => item.type === 'reasoning')).toEqual([]);
    expect(next.input.filter((item: { type: string }) => item.type === 'function_call' || item.type === 'function_call_output')).toHaveLength(2);
    expect(JSON.stringify(next.input)).toContain('Your plan still has twelve samples');
    expect(next.input.at(-1)).toEqual({ role: 'user', content: 'And now?' });
  });

  it('does not retry an unrelated 400 as though the conversation expired', async () => {
    const { fn, calls } = fakeFetch({ status: 400, body: { error: { message: 'Unsupported tool parameter' } } });
    await expect(provider(fn).converse({ text: 'Explain that again', context: home, previousResponseId: 'resp_1' })).rejects.toThrow(/400|Unsupported/);
    expect(calls).toHaveLength(1);
  });

  it('does not advertise a source solely because its annotation is present, without an inline citation or original read', async () => {
    const url = 'https://www.thermofisher.com/order/catalog/product/23225';
    const response = said('I found the manufacturer’s page. This is a comparison only.');
    Object.assign(response.output[0].content[0], { annotations: [{ type: 'url_citation', url, title: 'Pierce BCA Protein Assay Kit' }] });
    const { fn } = fakeFetch(response);
    const reply = await provider(fn).converse({ text: 'Find the original documentation, but leave my current experiment alone.', context: { screen: 'run', protocolId: 'pierce-bca', samples: 12, replicates: 2 } });
    expect(reply.sources).toEqual([]);
    expect(readSource).not.toHaveBeenCalled();
    expect(reply.actions).toEqual([]);
    expect(reply.pendingTools).toBeUndefined();
  });

  it('discovers sources, reads original text, and reviews the final scientific answer against a checked quotation', async () => {
    const source = 'https://example.org/independent-calibration-study';
    const original = 'An independently prepared reference is required to detect a shared calibration-stock bias.';
    vi.mocked(readSource).mockResolvedValue({ url: source, title: 'Independent calibration study', format: 'html', pages: [{ text: original }], fetchedAt: '2026-10-31T00:00:00Z' });
    const discovery = { id: 'resp_science', status: 'completed', output: [{ type: 'web_search_call', action: { type: 'search', query: 'independent calibration reference' }, results: [{ url: source, title: 'Independent calibration study', snippet: 'Discovery only.' }] }, { type: 'message', content: [{ type: 'output_text', text: 'UNREAD GENERATED CLAIM MUST NOT BECOME EVIDENCE.' }] }] };
    const { fn, calls } = fakeFetch(
      toolReply([{ name: 'research_science', callId: 'research_calibration', arguments: { question: 'Can back-calculating the same standards reveal their shared stock concentration bias?' } }]),
      discovery,
      said('Use an independent reference. [[S1:P1:1]]', 'resp_explanation'),
      said({ paragraphs: [{ id: 'p1', text: original, kind: 'supported' }], citations: [{ paragraphId: 'p1', ref: 'S1:P1:1', quote: original }] }, 'resp_reviewed'),
    );
    const text = 'If all of my standards are thirty percent low, can recalculating those same standards catch it?';
    const history = [{ role: 'user' as const, text: 'All standards came from the same stock solution.' }];
    const reply = await provider(fn).converse({ text, context: home, history });
    expect(calls).toHaveLength(4);
    expect(readSource).toHaveBeenCalledWith(source, expect.objectContaining({ timeoutMs: expect.any(Number) }));
    const research = JSON.parse(String(calls[1].init.body));
    expect(research.reasoning).toEqual({ effort: 'low' });
    expect(research.tools).toEqual([{ type: 'web_search', search_context_size: 'medium' }]);
    expect(research.include).toContain('web_search_call.results');
    expect(research.stream).toBe(true);
    expect(research.previous_response_id).toBeUndefined();
    expect(JSON.parse(research.input)).toMatchObject({ originalUserMessage: text, recentConversation: history });
    const continuation = JSON.parse(String(calls[2].init.body));
    expect(continuation.previous_response_id).toBeUndefined();
    expect(continuation.input.at(-1)).toEqual(expect.objectContaining({ type: 'function_call_output', call_id: 'research_calibration' }));
    const evidence = JSON.parse(continuation.input.at(-1).output);
    expect(evidence.sources).toEqual([expect.objectContaining({ id: 'S1', status: 'read' })]);
    expect(evidence.excerpts).toEqual([expect.objectContaining({ id: 'S1:P1:1', text: original })]);
    expect(JSON.stringify(evidence)).not.toContain('UNREAD GENERATED CLAIM');
    const review = JSON.parse(String(calls[3].init.body));
    expect(review.previous_response_id).toBeUndefined();
    expect(review.reasoning).toEqual({ effort: 'low' });
    expect(review.tools).toBeUndefined();
    expect(review.text.format.name).toBe('evidence_review');
    expect(reply.responseId).toBe('resp_explanation');
    expect(reply.sources).toContainEqual({ url: source, title: 'Independent calibration study', quote: original });
    expect(reply.actions).toEqual([]);
    expect(reply.pendingTools).toBeUndefined();
  });

  it.skipIf(!local)('returns all independent read-tool results in one continuation without changing the plan', async () => {
    const { fn, calls } = fakeFetch(
      toolReply([{ name: 'read_run', callId: 'read_state' }, { name: 'calculate_plan', arguments: { replicates: 3 }, callId: 'read_plan' }]),
      said('With three sample replicates and two standard replicates, the hypothetical plan uses 54 wells.', 'resp_answer'),
    );
    const context: ConverseContext = { screen: 'plan', protocolId: 'pierce-bca', procedure: 'microplate', samples: 12, replicates: 2, standardReplicates: 2 };
    const reply = await provider(fn).converse({ text: 'What would happen if I did each sample three times? I am still deciding.', context });
    expect(reply.pendingTools).toBeUndefined();
    expect(reply.actions).toEqual([]);
    expect(context.replicates).toBe(2);
    expect(calls).toHaveLength(2);
    const continuation = JSON.parse(String(calls[1].init.body));
    expect(continuation.previous_response_id).toBeUndefined();
    const outputs = continuation.input.filter((x: { type: string }) => x.type === 'function_call_output');
    expect(outputs.map((x: { call_id: string }) => x.call_id).sort()).toEqual(['read_plan', 'read_state']);
    expect(JSON.parse(outputs.find((x: { call_id: string }) => x.call_id === 'read_plan').output)).toMatchObject({ plan: { replicates: 3, standardReplicates: 2 }, wells: 54 });
  });

  it.skipIf(!local)('waits for the browser receipt, then confirms the operation itself without a second model call, the same receipt only once', async () => {
    const { fn, calls } = fakeFetch(
      toolReply([{ name: 'perform_action', arguments: { type: 'setSamples', value: 11 }, callId: 'change_samples' }]),
      said('The plan now has eleven samples.', 'resp_done'),
    );
    const p = provider(fn);
    const original = { text: 'One of the twelve is unusable now; take it out of the plan.', context: { screen: 'plan', protocolId: 'pierce-bca', procedure: 'microplate', samples: 12, replicates: 2 } };
    const pending = await p.converse(original);
    expect(pending.pendingTools).toEqual([{ callId: 'change_samples', action: { type: 'setSamples', samples: 11 } }]);
    expect(pending.continuationToken).toBeTruthy();
    expect(pending.actions).toEqual([]);
    expect(calls).toHaveLength(1);
    const resumed = { ...original, context: { ...original.context, samples: 11 }, continuationToken: pending.continuationToken, toolResults: [{ callId: 'change_samples', ok: true, message: 'Applied sample count 11.' }] };
    const done = await p.converse(resumed);
    // The app's own word (confirm.ts); the model's second reply above is never asked for.
    expect(done.say).toBe('11 samples.');
    expect(done.pendingTools).toBeUndefined();
    expect(done.responseId).toBe(pending.responseId);
    expect(await p.converse(resumed)).toEqual(done);
    expect(calls).toHaveLength(1);
  });

  it.skipIf(!local)('passes a failed browser execution back to the model as failure', async () => {
    const { fn, calls } = fakeFetch(
      toolReply([{ name: 'perform_action', arguments: { type: 'setReplicates', value: 3 }, callId: 'change_replicates' }]),
      said('The plan stayed unchanged because the experiment was changed elsewhere.'),
    );
    const p = provider(fn);
    const request = { text: 'Use the three-replicate option we discussed.', context: { screen: 'plan', protocolId: 'pierce-bca', procedure: 'microplate', samples: 12, replicates: 2 } };
    const pending = await p.converse(request);
    const done = await p.converse({ ...request, continuationToken: pending.continuationToken, toolResults: [{ callId: 'change_replicates', ok: false, message: 'The active experiment changed; nothing was applied.' }] });
    expect(done.say).toMatch(/unchanged/);
    const body = JSON.parse(String(calls[1].init.body));
    expect(JSON.stringify(body.input)).toContain('false');
    expect(JSON.stringify(body.input)).toContain('nothing was applied');
  });

  it('reports an upstream failure without the key', async () => {
    const { fn } = fakeFetch({ status: 401, body: { error: { message: `Invalid key ${KEY}` } } });
    const error = await provider(fn).converse({ text: 'x', context: home }).catch(e => e);
    expect(error).toBeInstanceOf(UpstreamError);
    expect(error.message).toBe('Meta converse failed (401): Invalid key ***');
  });

  it('times out without automatically duplicating a potentially billable request', async () => {
    let calls = 0;
    const hang = (async (_url: string, init: RequestInit) => {
      calls++;
      return new Promise((_, fail) => init.signal!.addEventListener('abort', () => fail(init.signal!.reason)));
    }) as unknown as typeof fetch;
    const error = await provider(hang, { converse: 50 }).converse({ text: 'x', context: home }).catch(e => e);
    expect(error).toBeInstanceOf(UpstreamError);
    expect(error.message).toMatch(/converse timed out/);
    expect(calls).toBe(1);
  });

  it('cannot reach the API', async () => {
    const { fn } = fakeFetch(new TypeError('fetch failed'));
    await expect(provider(fn).converse({ text: 'x', context: home })).rejects.toThrow('Could not reach the Meta API for converse');
  });
});

describe('meta transcribe', () => {
  it('posts the WAV to /asr/transcribe as multipart with the request part', async () => {
    const { fn, calls } = fakeFetch({ transcript: ' Next step. ' });
    const audio = new Uint8Array([82, 73, 70, 70, 1, 2, 3]);
    expect(await provider(fn).transcribe(audio)).toEqual({ transcript: 'Next step.' });
    expect(calls[0].url).toBe('https://api.meta.ai/v1/asr/transcribe');
    const form = calls[0].init.body as FormData;
    const request = JSON.parse(await (form.get('request') as Blob).text());
    expect(request).toMatchObject({ mode: 'PUSH_TO_TALK', model: 'muse-voice-transcribe-1.0', audioEncoding: 'WAV', languageBias: ['Chinese (Taiwan)', 'English'] });
    expect(request.keywords).toEqual(expect.arrayContaining(['TRIzol', 'BCA', '三重複']));
    // Meta refuses a keyword over 30 characters.
    expect(request.keywords.every((k: string) => k.length <= 30)).toBe(true);
    const sent = form.get('audio') as File;
    expect(sent.type).toBe('audio/wav');
    expect(new Uint8Array(await sent.arrayBuffer())).toEqual(audio);
    expect((calls[0].init.headers as Record<string, string>)['content-type']).toBeUndefined();
  });

  it('writes Chinese as Taiwan does: the model hears it in Simplified', async () => {
    const { fn } = fakeFetch({ transcript: '把样本数改成12个, 然后计时开始,  add 25 uL, then mix' });
    expect(await provider(fn).transcribe(new Uint8Array(10))).toEqual({ transcript: '把樣本數改成12個，然後計時開始，add 25 uL, then mix' });
  });

  it('fails clearly when there is no transcript', async () => {
    const { fn } = fakeFetch({ segments: [] });
    await expect(provider(fn).transcribe(new Uint8Array(10))).rejects.toThrow('Meta transcribe returned no transcript');
  });
});

// A Responses API reply shaped like the live one saved on 2026-10-28 (data/smoke/find-protocol-*.json).
const PDF = 'https://documents.thermofisher.com/TFS-Assets/LSG/manuals/MAN0011430_Pierce_BCA_Protein_Asy_UG.pdf';
const message = (text: string, annotations: object[] = [], phase?: string) => ({
  type: 'message', role: 'assistant', ...(phase ? { phase } : {}), content: [{ type: 'output_text', text, annotations }],
});
const cite = (url: string, title: string) => ({ type: 'url_citation', url, title, start_index: 0, end_index: 10 });
const searchReply = (answer: string, annotations: object[]) => ({
  status: 'completed',
  error: null,
  output: [
    { type: 'reasoning', summary: [] },
    message('Looking for the Thermo Fisher manual.', [], 'commentary'),
    { type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'Pierce BCA 23225 user guide' } },
    message('Found it, opening the PDF.', [], 'commentary'),
    { type: 'web_search_call', status: 'completed', action: { type: 'open_page', url: PDF } },
    message(answer, annotations),
  ],
});
const details = `\n\n---\nVendor: Thermo Fisher Scientific\nCatalog: 23225\nKit: Pierce BCA Protein Assay Kit\nDocument: Pierce BCA Protein Assay Kit User Guide\nVersion: MAN0011430 Rev. D\nURL: ${PDF}`;

describe('meta findProtocol', () => {
  it('uses Muse Spark with web search and reads progress, sources, the document and the kit', async () => {
    const answer = '1. Mix 50 parts Reagent A with 1 part Reagent B.\n2. Add 200 µL to each well.';
    const { fn, calls } = fakeFetch(searchReply(answer + details, [cite(`${PDF}?ref=vastkind.com`, 'Pierce BCA Protein Assay Kit'), cite(PDF, ''), cite('https://www.example.org/bca?utm_source=x&page=2', 'A blog')]));
    const found = await provider(fn).findProtocol('Pierce BCA 23225');
    expect(found).toEqual({
      found: true,
      kit: { vendor: 'Thermo Fisher Scientific', catalog: '23225', name: 'Pierce BCA Protein Assay Kit' },
      document: { title: 'Pierce BCA Protein Assay Kit User Guide', version: 'MAN0011430 Rev. D', url: PDF },
      // The guide is a protocol on this machine (when data/ is there): the app opens that one.
      ...(local ? { protocolId: 'pierce-bca' } : {}),
      progress: ['Looking for the Thermo Fisher manual.', 'Found it, opening the PDF.'],
      answer,
      sources: [{ url: `${PDF}?ref=vastkind.com`, title: 'Pierce BCA Protein Assay Kit' }, { url: PDF }, { url: 'https://www.example.org/bca?utm_source=x&page=2', title: 'A blog' }],
    });
    const body = JSON.parse(calls[0].init.body as string);
    expect(calls[0].url).toBe('https://api.meta.ai/v1/responses');
    expect(body.tools).toEqual([{ type: 'web_search' }]);
    expect(body.input[1]).toEqual({ role: 'user', content: 'Pierce BCA 23225' });
  });

  it('is not found when nothing from the vendor was cited', () => {
    const none = '\nVendor: Thermo Fisher Scientific\nCatalog: 99999\nKit: none\nDocument: none\nVersion: none\nURL: none';
    const found = parseFound(searchReply('I could not find the vendor manual for 99999.' + none, [cite('https://www.example.org/bca', 'A blog')]), 'Thermo 99999');
    expect(found.found).toBe(false);
    expect(found.document).toBeUndefined();
    expect(found.answer).toBe('I could not find the vendor manual for 99999.');
  });

  it('takes the manual the model named when the page it opened carried a ?ref=, not another page from the search', () => {
    // Spark 1.1 and 1.2 on 2026-11-01: opened the PDF with ?ref=vastkind.com, wrote it without, cited nothing.
    const r: { output: Record<string, any>[] } = searchReply('The Pierce BCA user guide.' + details, []);
    r.output = r.output.map(o => (o.type === 'web_search_call' && o.action.type === 'open_page' ? { ...o, action: { type: 'open_page', url: `${PDF}?ref=vastkind.com` } } : o));
    r.output.splice(2, 0, { type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'BCA' }, results: [{ url: 'https://www.thermofisher.com/mc/en/home/life-science/protein-biology/protein-assay-data-analysis.html', title: 'Protein assay data analysis' }] });
    const found = parseFound(r, 'Thermo Pierce BCA Protein Assay Kit 23225');
    expect(found.found).toBe(true);
    expect(found.document?.url).toBe(PDF);
  });

  it('gives a reagent with no manual its product page, and nothing to read into steps', () => {
    const product = 'https://www.sigmaaldrich.com/US/en/product/sigma/s9888';
    const details = `\nVendor: Sigma-Aldrich\nCatalog: S9888\nKit: Sodium chloride\nDocument: none\nVersion: none\nURL: ${product}`;
    const found = parseFound(searchReply('No manual: it is a plain chemical.\nSodium chloride, ACS reagent, S9888; store at room temperature.' + details, [cite(product, 'Sodium chloride S9888')]), 'Sigma NaCl');
    expect(found).toMatchObject({ found: false, page: product, answer: 'No manual: it is a plain chemical.\nSodium chloride, ACS reagent, S9888; store at room temperature.' });
    expect(found.document).toBeUndefined();
  });

  it('falls back to search actions for progress and to the cited site when the details block is missing', () => {
    const r = searchReply('Steps from the Thermo Fisher guide.', [cite(PDF, 'Pierce BCA guide')]);
    r.output = r.output.filter(o => !('phase' in o));
    const found = parseFound(r, 'pierce bca');
    expect(found.progress).toEqual(['Searching: Pierce BCA 23225 user guide', 'Opening documents.thermofisher.com']);
    expect(found.found).toBe(true);
    expect(found.document).toEqual({ title: 'Pierce BCA guide', url: PDF });
  });

  it('reads what the search read of the manual, after the details, into an intro to show first', () => {
    const read = [
      'Title: Pierce BCA Protein Assay',
      'Summary: Colorimetric total-protein assay: proteins reduce Cu2+ and BCA turns purple. Read at 562 nm, 20-2000 ug/mL.',
      'Procedure: Microplate procedure',
      'Step: Pipette 25 uL of each standard or sample into a well | 3',
      'Step: Add 200 uL of working reagent and mix for 30 seconds | p. 3',
      'Bottle: Reagent A | 1000 mL',
      'Bottle: Albumin Standard Ampules, 2 mg/mL | 10 x 1 mL',
    ].join('\n');
    const found = parseFound(searchReply(`The Pierce BCA user guide, Rev. D.${details}\n${read}`, [cite(PDF, 'Pierce BCA guide')]), 'pierce bca 23225');
    expect(found.answer).toBe('The Pierce BCA user guide, Rev. D.');
    expect(found.document?.url).toBe(PDF);
    expect(found.intro).toMatchObject({
      title: 'Pierce BCA Protein Assay',
      kit: { name: 'Pierce BCA Protein Assay Kit', vendor: 'Thermo Fisher Scientific', catalogs: ['23225'] },
      source: { title: 'Pierce BCA Protein Assay Kit User Guide', url: PDF },
      overview: { cite: { page: 3 } },
      procedure: { name: 'Microplate procedure', steps: [{ text: 'Pipette 25 µL of each standard or sample into a well', page: 3 }, { text: 'Add 200 µL of working reagent and mix for 30 seconds', page: 3 }] },
      contents: [{ name: 'Reagent A', amount: '1000 mL' }, { name: 'Albumin Standard Ampules, 2 mg/mL', amount: '10 x 1 mL' }],
    });
    // Nothing read, or too little to show: no intro, and the manual's own comes first.
    expect(parseFound(searchReply(`The guide.${details}\nTitle: Pierce BCA Protein Assay`, [cite(PDF, 'Pierce BCA guide')])).intro).toBeUndefined();
  });

  it('names the manual as soon as the URL line is whole, before the search writes the rest', () => {
    const heard: FoundProtocol[] = [];
    const watch = documentWatcher('pierce bca', found => heard.push(found));
    watch({ type: 'response.output_item.added', item: { type: 'message', id: 'c1', phase: 'commentary' } });
    watch({ type: 'response.output_text.delta', item_id: 'c1', delta: 'URL: https://elsewhere.example/x.pdf\n' });
    watch({ type: 'response.output_item.done', item: { type: 'web_search_call', status: 'completed', action: { type: 'open_page', url: PDF } } });
    watch({ type: 'response.output_item.added', item: { type: 'message', id: 'm1' } });
    const text = `The Pierce BCA user guide.${details}\nTitle: Pierce BCA Protein Assay\nSummary: A copper assay.`;
    const cut = text.indexOf(PDF) + PDF.length;
    watch({ type: 'response.output_text.delta', item_id: 'm1', delta: text.slice(0, cut) });
    expect(heard).toEqual([]);
    watch({ type: 'response.output_text.delta', item_id: 'm1', delta: text.slice(cut, cut + 1) });
    expect(heard.map(f => [f.found, f.document?.url])).toEqual([[true, PDF]]);
    watch({ type: 'response.output_text.delta', item_id: 'm1', delta: text.slice(cut + 1) });
    expect(heard).toHaveLength(1);
  });

  it('fails on an empty or failed response', async () => {
    const { fn } = fakeFetch({ status: 'completed', output: [] }, { status: 'failed', error: { message: 'search unavailable' } });
    const p = provider(fn);
    await expect(p.findProtocol('x kit')).rejects.toThrow('returned no answer');
    await expect(p.findProtocol('x kit')).rejects.toThrow('search unavailable');
  });

  const saved = new URL('../data/smoke/', import.meta.url);
  const live = existsSync(saved) ? readdirSync(saved).filter(f => f.startsWith('find-protocol-')).map(f => new URL(f, saved)) : [];
  it.skipIf(!live.length)('parses the live replies saved by scripts/find-protocol.ts', () => {
    for (const file of live) {
      const { ask, response } = JSON.parse(readFileSync(file, 'utf8'));
      const found = parseFound(response, ask);
      expect(found.found).toBe(true);
      expect(found.progress.length).toBeGreaterThan(0);
      expect(found.sources.length).toBeGreaterThan(0);
      expect(found.answer.length).toBeGreaterThan(100);
    }
  });
});

describe('find-protocol helpers', () => {
  it('splits the details block off, tolerating markdown and "none"', () => {
    const { answer, details: d } = splitDetails('Steps here.\n\n---\n**Vendor:** Abcam\nCatalog: ab287843\nKit: 3T3-L1 Differentiation Kit\nDocument: none\nVersion: v5a\nURL: <https://content.abcam.com/x.pdf>');
    expect(answer).toBe('Steps here.');
    expect(d).toEqual({ vendor: 'Abcam', catalog: 'ab287843', kit: '3T3-L1 Differentiation Kit', version: 'v5a', url: 'https://content.abcam.com/x.pdf' });
    expect(splitDetails('No block at all.')).toEqual({ answer: 'No block at all.', details: {}, after: [] });
    // The block first, with what the search read after it; a stray label line in the prose is not the block.
    expect(splitDetails('Version: 2 of the guide is newer.\nIt moved.\nVendor: Abcam\nKit: X\nURL: https://a.example/x.pdf\nTitle: X assay')).toEqual({
      answer: 'Version: 2 of the guide is newer.\nIt moved.', details: { vendor: 'Abcam', kit: 'X', url: 'https://a.example/x.pdf' }, after: ['Title: X assay'],
    });
  });

  it.each([
    ['https://documents.thermofisher.com/a.pdf', 'Thermo Fisher Scientific', true],
    ['https://documents.thermofisher.com/a.pdf', 'Thermo Scientific', true],
    ['https://content.abcam.com/a.pdf', 'Abcam', true],
    ['https://www.bio-rad.com/a.pdf', 'Bio-Rad', true],
    ['https://www.sigmaaldrich.com/a.pdf', 'Sigma-Aldrich', true],
    ['https://www.researchgate.net/a.pdf', 'Abcam', false],
    ['not a url', 'Abcam', false],
  ])('%s is from %s: %s', (url, vendor, expected) => {
    expect(isVendorUrl(url, vendor)).toBe(expected);
  });
});
