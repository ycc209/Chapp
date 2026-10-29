import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ConverseContext } from '../shared/ai.ts';
import { createMetaProvider, isVendorUrl, parseFound, replyFormat, splitDetails, systemPrompt } from '../server/ai/meta.ts';
import { UpstreamError } from '../server/ai/provider.ts';
import { BCA } from '../server/ai/protocols.ts';

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
const chat = (content: unknown) => ({ choices: [{ message: { role: 'assistant', content: typeof content === 'string' ? content : JSON.stringify(content) } }] });
const wire = (over: object = {}) => ({ say: 'Hello!', expression: 'happy', actions: [], a2ui: '[]', manualPages: [], ...over });

describe('meta converse', () => {
  it('asks Muse Spark for strict JSON and turns the flat wire format into a ConverseReply', async () => {
    const { fn, calls } = fakeFetch(chat(wire({
      say: 'I found the manual.',
      actions: [
        { type: 'navigate', to: '/protocol', value: 0, id: '' },
        { type: 'setSamples', to: '', value: 12, id: '' },
        { type: 'setReplicates', to: '', value: 3, id: '' },
        { type: 'nextStep', to: '', value: 0, id: '' },
      ],
    })));
    const reply = await provider(fn).converse({ text: 'Open it: 12 samples in triplicate, then the next step.', context: home });
    expect(reply).toEqual({
      say: 'I found the manual.',
      expression: 'happy',
      actions: [
        { type: 'navigate', to: '/protocol' },
        { type: 'setSamples', samples: 12 },
        { type: 'setReplicates', replicates: 3 },
        { type: 'nextStep' },
      ],
      sources: [],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.meta.ai/v1/chat/completions');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.model).toBe('muse-spark-1.3');
    expect(body.response_format).toEqual(replyFormat);
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user']);
    expect(body.messages[1].content).toBe('Open it: 12 samples in triplicate, then the next step.');
  });

  it.skipIf(!local)('cites the manual: the pages named for the protocol on screen', async () => {
    const { fn } = fakeFetch(chat(wire({ say: 'Add 25 µL per well.', manualPages: [3, 3, 99] })));
    const onScreen = await provider(fn).converse({ text: 'how much sample?', context: { screen: 'run', protocolId: 'pierce-bca', step: 2 } });
    expect(onScreen.sources).toEqual([{ url: BCA.source.url, title: BCA.source.title, page: 3 }]);
  });

  it('draws nothing when no kit is open: there is nothing to work the numbers out from', async () => {
    const a2ui = JSON.stringify([{ version: 'v0.9', createSurface: { surfaceId: 'answer', catalogId: 'chapp' } }, { version: 'v0.9', updateComponents: { surfaceId: 'answer', components: [{ id: 'root', component: 'ReagentCard' }] } }]);
    const { fn } = fakeFetch(chat(wire({ a2ui })));
    expect((await provider(fn).converse({ text: 'x', context: home })).a2ui).toBeUndefined();
  });

  it('drops a broken action, card or face instead of asking again', async () => {
    const bad = wire({
      say: 'Twelve it is.',
      expression: 'grumpy',
      actions: [{ type: 'navigate', to: '', value: 0, id: '' }, { type: 'setSamples', to: '', value: 12, id: '' }, { type: 'launchRocket', to: '', value: 0, id: '' }],
      a2ui: 'not even JSON',
    });
    const { fn, calls } = fakeFetch(chat(bad));
    expect(await provider(fn).converse({ text: '12', context: home })).toEqual({ say: 'Twelve it is.', actions: [{ type: 'setSamples', samples: 12 }], sources: [] });
    expect(calls).toHaveLength(1);
  });

  it('asks Muse Spark at minimal effort, so thinking does not eat the wait', async () => {
    const { fn, calls } = fakeFetch(chat(wire()));
    await provider(fn).converse({ text: 'hi', context: home });
    expect(JSON.parse(calls[0].init.body as string).reasoning_effort).toBe('minimal');
  });

  it('retries once on a reply with nothing usable, telling the model what was wrong', async () => {
    const { fn, calls } = fakeFetch(chat('{"say": "Sure", "actions": "all of them"}'), chat(wire({ say: 'Fixed.' })));
    const reply = await provider(fn).converse({ text: 'go', context: home });
    expect(reply.say).toBe('Fixed.');
    expect(calls).toHaveLength(2);
    const retry = JSON.parse(calls[1].init.body as string).messages;
    expect(retry.map((m: { role: string }) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(retry[3].content).toMatch(/actions/);
  });

  it('falls back to the words alone when the retry is no better', async () => {
    const bad = wire({ say: 'Twelve it is.', actions: 'twelve' });
    const { fn, calls } = fakeFetch(chat(bad), chat('not json at all'));
    expect(await provider(fn).converse({ text: '12', context: home })).toEqual({ say: 'Twelve it is.', expression: 'neutral', actions: [], sources: [] });
    expect(calls).toHaveLength(2);
  });

  it('says it lost track when neither reply has words', async () => {
    const { fn } = fakeFetch(chat('{}'), chat(''));
    const reply = await provider(fn).converse({ text: 'x', context: home });
    expect(reply.say).toMatch(/say that again/);
    expect(reply.actions).toEqual([]);
  });

  it('keeps the first answer’s words when the retry itself fails', async () => {
    const { fn } = fakeFetch(chat(wire({ say: 'Sure.', actions: 'none' })), { status: 500, body: { error: { message: 'oops' } } });
    expect((await provider(fn).converse({ text: 'x', context: home })).say).toBe('Sure.');
  });

  it('reports an upstream failure without the key', async () => {
    const { fn } = fakeFetch({ status: 401, body: { error: { message: `Invalid key ${KEY}` } } });
    const error = await provider(fn).converse({ text: 'x', context: home }).catch(e => e);
    expect(error).toBeInstanceOf(UpstreamError);
    expect(error.message).toBe('Meta converse failed (401): Invalid key ***');
  });

  it('times out', async () => {
    const hang = (async (_url: string, init: RequestInit) =>
      new Promise((_, fail) => init.signal!.addEventListener('abort', () => fail(init.signal!.reason)))) as unknown as typeof fetch;
    const error = await provider(hang, { converse: 50 }).converse({ text: 'x', context: home }).catch(e => e);
    expect(error).toBeInstanceOf(UpstreamError);
    expect(error.message).toMatch(/converse timed out/);
  });

  it('cannot reach the API', async () => {
    const { fn } = fakeFetch(new TypeError('fetch failed'));
    await expect(provider(fn).converse({ text: 'x', context: home })).rejects.toThrow('Could not reach the Meta API for converse');
  });
});

describe('meta converse prompt', () => {
  it('states the rules and the screen, and lists the protocols on this machine', () => {
    const prompt = systemPrompt({ screen: 'plan', protocolId: null, samples: 12, replicates: 2 });
    expect(prompt).toMatch(/one or two short sentences/);
    expect(prompt).toMatch(/Never guess a number/);
    expect(prompt).toContain('Right now: screen "plan", protocol none, 12 samples, 2 replicates.');
    expect(prompt).not.toContain('Steps (index');
    if (local) expect(prompt).toContain('pierce-bca (Pierce BCA Protein Assay Kit, Thermo Scientific)');
  });

  it.skipIf(!local)('carries the BCA facts when the BCA protocol is on screen', () => {
    const prompt = systemPrompt({ screen: 'run', protocolId: 'pierce-bca', step: 0, samples: 12, replicates: 2 });
    expect(prompt).toContain('Steps (index: id, title, what to do, page):');
    expect(prompt).toContain('400 µL BSA stock');
  });
});

describe('meta transcribe', () => {
  it('posts the WAV to /asr/transcribe as multipart with the request part', async () => {
    const { fn, calls } = fakeFetch({ transcript: ' Next step. ' });
    const audio = new Uint8Array([82, 73, 70, 70, 1, 2, 3]);
    expect(await provider(fn).transcribe(audio)).toEqual({ transcript: 'Next step.' });
    expect(calls[0].url).toBe('https://api.meta.ai/v1/asr/transcribe');
    const form = calls[0].init.body as FormData;
    expect(JSON.parse(await (form.get('request') as Blob).text())).toEqual({ mode: 'DIARIZATION', model: 'muse-voice-transcribe-1.0', audioEncoding: 'WAV' });
    const sent = form.get('audio') as File;
    expect(sent.type).toBe('audio/wav');
    expect(new Uint8Array(await sent.arrayBuffer())).toEqual(audio);
    expect((calls[0].init.headers as Record<string, string>)['content-type']).toBeUndefined();
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
      sources: [{ url: PDF, title: 'Pierce BCA Protein Assay Kit' }, { url: 'https://www.example.org/bca?page=2', title: 'A blog' }],
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

  it('falls back to search actions for progress and to the cited site when the details block is missing', () => {
    const r = searchReply('Steps from the Thermo Fisher guide.', [cite(PDF, 'Pierce BCA guide')]);
    r.output = r.output.filter(o => !('phase' in o));
    const found = parseFound(r, 'pierce bca');
    expect(found.progress).toEqual(['Searching: Pierce BCA 23225 user guide', 'Opening documents.thermofisher.com']);
    expect(found.found).toBe(true);
    expect(found.document).toEqual({ title: 'Pierce BCA guide', url: PDF });
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
    expect(splitDetails('No block at all.')).toEqual({ answer: 'No block at all.', details: {} });
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
