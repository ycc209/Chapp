import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { AIProvider, ConverseContext, FoundProtocol } from '../shared/ai.ts';
import { readEvents } from '../shared/sse.ts';
import { Protocol } from '../shared/protocol.ts';
import { createHandler } from '../server/app.ts';
import { checkReply, createMetaProvider, systemPrompt } from '../server/ai/meta.ts';
import { createMockProvider } from '../server/ai/mock.ts';
import { UpstreamError } from '../server/ai/provider.ts';
import { loadProtocol, protocolBrief } from '../server/ai/protocols.ts';
import { converseContext } from '../src/screens/home/useConverse.ts';
import { applyActions } from '../src/state/actions.ts';
import { useRun } from '../src/state/run.ts';
import { useSession } from '../src/state/session.ts';

// Phase 2's conversation with Muse Spark: the run state it is told, the replies saved from the live model replayed,
// find-protocol streamed, and transcripts fixed. A fake fetch stands in for the API: no network.

const KEY = 'test-key-never-shown';
const local = existsSync(new URL('../data/protocols/pierce-bca.json', import.meta.url));
const bca = local ? loadProtocol('pierce-bca') : null;

/** A fetch that answers each call with the next Response, recording what was asked. */
function fakeFetch(...answers: Response[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return answers.shift() ?? new Response('{}', { status: 500 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const provider = (fetch: typeof globalThis.fetch) => createMetaProvider({ apiKey: KEY, fetch, log: () => {} });
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
/** A text/event-stream body that arrives in small, awkward pieces, as it does over the network. */
function stream(text: string, piece = 37) {
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (at >= bytes.length) return c.close();
      c.enqueue(bytes.slice(at, (at += piece)));
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}
const sse = (events: object[]) => events.map(e => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';

describe('what Chapp is told', () => {
  it('sends the run as the app keeps it: plan, standards, step and title, timers, readings', () => {
    const ends = Date.now() + 754_000;
    useRun.setState({ protocolId: 'pierce-bca', procedure: 'microplate', samples: 12, replicates: 3, standardReplicates: 1, standards: 'five', step: 4, done: {}, timers: { 'm-incubate': ends, 'm-add-wr': Date.now() - 5000 }, readingsFrom: 'sample' });
    const context = converseContext('results', bca);
    expect(context).toMatchObject({
      screen: 'results', protocolId: 'pierce-bca', procedure: 'microplate', step: 4, samples: 12, replicates: 3,
      standardReplicates: 1, standards: 'five', readingsFrom: 'sample',
      timers: [{ id: 'm-incubate', secondsLeft: 754 }, { id: 'm-add-wr', secondsLeft: 0 }],
    });
    if (bca) expect(context.stepTitle).toBe('Incubate');
    // The run screen says which step is on screen.
    expect(converseContext('run', bca, { step: 2, stepTitle: 'Load the plate' })).toMatchObject({ step: 2, stepTitle: 'Load the plate' });
  });

  it('leaves the step out before the run has started, away from the bench', () => {
    useRun.setState({ step: 0, done: {}, timers: {} });
    const context = converseContext('home', null);
    expect(context.step).toBeUndefined();
    expect(context.timers).toBeUndefined();
    expect(converseContext('run', null).step).toBe(0);
  });

  it('assumes no kit on Home before one is named, or after New conversation set the run aside', () => {
    useRun.setState({ protocolId: null, aside: false, step: 0, done: {}, timers: {} });
    expect(converseContext('home', null)).toEqual({ screen: 'home' });
    useRun.setState({ protocolId: 'pierce-bca', aside: true, timers: { 'm-incubate': Date.now() + 60_000 } });
    expect(converseContext('home', bca)).toEqual({ screen: 'home' });
    // On the run's own screens it still goes along, and once the run is back it goes along on Home too.
    expect(converseContext('plan', bca).protocolId).toBe('pierce-bca');
    useRun.setState({ aside: false, timers: {} });
    expect(converseContext('home', bca).protocolId).toBe('pierce-bca');
    expect(systemPrompt({ screen: 'home' })).toContain("No kit is open in this conversation: don't assume one.");
  });

  it('sends the conversation so far, so "yes, find it" knows the kit', async () => {
    const said = JSON.stringify({ say: 'Looking up its manual.', expression: 'thinking', actions: [{ type: 'findProtocol', to: '', value: 0, id: '', query: 'Pierce Bradford Protein Assay Kit' }], a2ui: '[]', manualPages: [] });
    const { fn, calls } = fakeFetch(json({ id: 'resp_1', output: [{ type: 'message', content: [{ type: 'output_text', text: said }] }] }));
    const reply = await provider(fn).converse({
      text: 'Yes, find it',
      context: { screen: 'home' },
      history: [{ role: 'user', text: 'I got a Pierce Bradford kit' }, { role: 'chapp', text: 'Want me to look it up?' }],
    });
    expect(reply.actions).toEqual([{ type: 'findProtocol', query: 'Pierce Bradford Protein Assay Kit' }]);
    const sent = JSON.parse(String(calls[0]!.init.body));
    expect(sent.input.map((m: { role: string; content: string }) => [m.role, m.content])).toEqual([
      ['user', 'I got a Pierce Bradford kit'],
      ['assistant', 'Want me to look it up?'],
      ['user', 'Yes, find it'],
    ]);
    expect(sent.text.format.schema.properties.actions.items.required).toContain('query');
  });

  it('opens the Overview on the kit Chapp chose to look up, under what the user said', () => {
    useSession.setState({ exchange: { ask: 'Yes, find it', say: 'Looking up its manual.' } });
    const went: string[] = [];
    applyActions([{ type: 'findProtocol', query: 'Pierce Bradford Protein Assay Kit' }], to => went.push(to));
    expect(went).toEqual(['/protocol']);
    expect(useSession.getState().exchange).toEqual({ ask: 'Yes, find it', say: 'Looking up its manual.', query: 'Pierce Bradford Protein Assay Kit' });
    // New conversation forgets what was said.
    useSession.getState().addTurns({ role: 'user', text: 'hi' });
    useSession.getState().newConversation();
    expect(useSession.getState()).toMatchObject({ history: [], exchange: null });
  });

  it('continues Meta’s copy of the conversation, until a turn answered on the phone or a few replies start it afresh', () => {
    const s = () => useSession.getState();
    s().newConversation();
    s().answered('resp_1', { role: 'user', text: 'hi' }, { role: 'chapp', text: 'Hello!' });
    expect(s().thread).toEqual({ id: 'resp_1', replies: 1 });
    s().answered('resp_2', { role: 'user', text: 'and?' }, { role: 'chapp', text: 'Yes.' });
    expect(s().thread).toEqual({ id: 'resp_2', replies: 2 });
    // "Next" answered on the phone: Meta never saw it, so the next question goes with the recent turns.
    s().addTurns({ role: 'user', text: 'next' }, { role: 'chapp', text: 'Step 3.' });
    expect(s().thread).toBeNull();
    expect(s().history).toHaveLength(6);
    // Eight replies on one copy, then the next question starts afresh.
    for (let i = 1; i <= 7; i++) s().answered(`resp_${i}`, { role: 'user', text: String(i) });
    expect(s().thread).toEqual({ id: 'resp_7', replies: 7 });
    s().answered('resp_8', { role: 'user', text: '8' });
    expect(s().thread).toBeNull();
    s().answered(undefined, { role: 'user', text: 'mock' });
    expect(s().thread).toBeNull();
    s().newConversation();
  });

  it('puts the run state in the prompt, after what never changes', () => {
    const context: ConverseContext = {
      screen: 'run', protocolId: null, step: 4, stepTitle: 'Incubate', samples: 12, replicates: 2, standardReplicates: 1, standards: 'five',
      timers: [{ id: 'm-incubate', secondsLeft: 725 }, { id: 'm-add-wr', secondsLeft: 0 }], readingsFrom: 'sample',
    };
    const prompt = systemPrompt(context);
    expect(prompt).toContain('Right now: screen "run", protocol none, step index 4 (Incubate), 12 samples, 2 replicates, standards: five standards × 1, timer m-incubate running, 12 min 5 s left, timer m-add-wr has rung, plate readings: sample data');
    expect(prompt.trimEnd().endsWith('.')).toBe(true);
    expect(prompt.indexOf('Right now')).toBeGreaterThan(prompt.indexOf('Protocols you have'));
    expect(prompt).toMatch(/language of the user's message: English stays English/);
  });

  it.skipIf(!local)('works the run’s numbers out with its own standards', () => {
    const brief = protocolBrief(bca!, { screen: 'run', protocolId: 'pierce-bca', step: 3, stepTitle: 'Add the reagent', samples: 12, replicates: 3, standardReplicates: 1, standards: 'five' });
    expect(brief).toContain('The user is on step 3: "Add the reagent" (m-add-wr, Add working reagent and mix).');
    expect(brief).toMatch(/12 samples × 3 replicates and 5 standards \(five standards\) × 1 = 41 wells/);
    const ready = protocolBrief(bca!, { screen: 'plan', protocolId: 'pierce-bca', samples: 12, replicates: 2, standards: 'ready' });
    expect(ready).toContain('the standards are already made');
  });
});

describe('a reply that is partly broken', () => {
  it('keeps what is good and cites the manual’s matching note first, in its own words', () => {
    const content = JSON.stringify({ say: 'That is normal; it clears to green as you mix.', expression: 'neutral', actions: [], a2ui: '[]', manualPages: [3, 2] });
    const checked = checkReply(content, { screen: 'run', protocolId: 'pierce-bca', step: 3 }, 'What if it turns cloudy when I add B?');
    expect(checked.ok).toBe(true);
    if (!checked.ok || !local) return;
    expect(checked.reply.sources[0]).toMatchObject({ page: 2, quote: expect.stringMatching(/turbidity/) });
    expect(checked.reply.sources[1]).toMatchObject({ page: 3 });
  });

  it('cuts an answer too long to read aloud at a sentence', () => {
    const say = `${'This is a long sentence about the kit. '.repeat(20)}`;
    const checked = checkReply(JSON.stringify({ say, actions: [], a2ui: '[]', manualPages: [] }), { screen: 'home' });
    expect(checked.ok && checked.reply.say.length).toBeLessThanOrEqual(600);
    expect(checked.ok && checked.reply.say.endsWith('kit.')).toBe(true);
  });
});

// Replies saved from the live model by scripts/converse-smoke.ts (data/smoke/converse/, git-ignored), replayed through
// today's checks: the storyboard's lines must come out with the right actions and pages.
const saved = new URL('../data/smoke/converse/', import.meta.url);
type Saved = { label: string; text: string; context: ConverseContext; effort?: string; raw: { body: { choices?: { message: { content: string } }[] } }[] };
const replies: Saved[] = existsSync(saved)
  ? readdirSync(saved)
      .filter(f => /^\d{4}-.*\.json$/.test(f))
      .map(f => JSON.parse(readFileSync(new URL(f, saved), 'utf8')) as Saved)
      // Since the prompt that says which language to answer in and what sample data is (the first run, at high effort, did not).
      .filter(r => r.effort && r.raw.at(-1)?.body.choices)
  : [];

describe.skipIf(!replies.length || !local)('live replies to the storyboard', () => {
  const expected: Record<string, (r: ReturnType<typeof checkReply> & { ok: true }) => void> = {
    'home-bca': r => expect(r.reply.actions).toContainEqual({ type: 'navigate', to: '/protocol' }),
    'home-fresh': r => expect(r.reply.actions).toContainEqual({ type: 'navigate', to: '/protocol' }),
    'home-zh': r => expect(r.reply.actions).toContainEqual({ type: 'navigate', to: '/protocol' }),
    'plan-samples': r => expect(r.reply.actions).toContainEqual({ type: 'setSamples', samples: 12 }),
    'plan-triplicates': r => expect(r.reply.actions).toEqual([{ type: 'setReplicates', replicates: 3 }]),
    'run-cloudy': r => {
      expect(r.reply.actions).toEqual([]);
      expect(r.reply.sources[0]).toMatchObject({ page: 2, quote: expect.stringMatching(/turbidity/) });
    },
    'run-next': r => expect(r.reply.actions).toEqual([{ type: 'nextStep' }]),
    'run-timer': r => expect(r.reply.actions).toEqual([{ type: 'startTimer', id: 'm-incubate', seconds: 1800 }]),
    'results-sample': r => expect(r.reply.say).toMatch(/example|sample/i),
    'results-blank': r => expect(r.reply.sources.map(s => s.page)).toContain(3),
  };

  it.each(replies.map(r => [`${r.label} (${r.effort})`, r] as const))('%s', (_, saved) => {
    const checked = checkReply(saved.raw.at(-1)!.body.choices![0]!.message.content, saved.context, saved.text);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    // Spoken in the language it was asked in.
    const chinese = /[㐀-鿿]/;
    expect(chinese.test(checked.reply.say)).toBe(chinese.test(saved.text));
    expected[saved.label]?.(checked);
  });
});

// A streamed find-protocol shaped like the live one (data/smoke/converse/find-protocol-stream-*.json).
const PDF = 'https://documents.thermofisher.com/TFS-Assets/LSG/manuals/MAN0011430_Pierce_BCA_Protein_Asy_UG.pdf';
const commentary = (text: string) => ({ type: 'response.output_item.done', item: { type: 'message', phase: 'commentary', content: [{ type: 'output_text', text }] } });
const answer = {
  type: 'message',
  content: [{
    type: 'output_text',
    text: `1. Mix 50 parts A with 1 part B.\n\nVendor: Thermo Fisher Scientific\nCatalog: 23225\nKit: Pierce BCA Protein Assay Kit\nDocument: Pierce BCA Protein Assay Kit User Guide\nVersion: MAN0011430 Rev. D\nURL: ${PDF}`,
    annotations: [{ type: 'url_citation', url: PDF, title: 'Pierce BCA guide' }],
  }],
};
const completed = (output: object[]) => ({ type: 'response.completed', response: { status: 'completed', error: null, output } });

describe('find-protocol, streamed', () => {
  it('hands each progress line on as it comes, then the found manual', async () => {
    const events = [
      { type: 'response.created' },
      commentary('Looking for the Thermo Fisher manual.'),
      { type: 'response.output_item.done', item: { type: 'web_search_call', action: { type: 'search', query: 'Pierce BCA' } } },
      commentary('Found it, opening the PDF.'),
      { type: 'response.output_text.delta', delta: '1. Mix' },
      completed([commentary('Looking for the Thermo Fisher manual.').item, commentary('Found it, opening the PDF.').item, answer]),
    ];
    const { fn, calls } = fakeFetch(stream(sse(events)));
    const heard: string[] = [];
    const found = await provider(fn).findProtocol('Pierce BCA', { onProgress: line => heard.push(line) });
    expect(heard).toEqual(['Looking for the Thermo Fisher manual.', 'Found it, opening the PDF.']);
    expect(found.progress).toEqual(heard);
    expect(found).toMatchObject({ found: true, document: { url: PDF }, ...(local ? { protocolId: 'pierce-bca' } : {}) });
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).toMatchObject({ stream: true, reasoning: { effort: 'low' }, tools: [{ type: 'web_search' }] });
  });

  it('fails clearly when the stream fails or stops before the answer', async () => {
    const failed = stream(sse([commentary('Looking.'), { type: 'response.failed', response: { status: 'failed', error: { message: 'search unavailable' } } }]));
    const cut = stream('event: response.created\ndata: {"type":"response.created"}\n\n');
    const { fn } = fakeFetch(failed, cut);
    const p = provider(fn);
    await expect(p.findProtocol('x kit')).rejects.toThrow('search unavailable');
    await expect(p.findProtocol('x kit')).rejects.toThrow('ended before the answer');
  });

  it('stops the search upstream when the user leaves', async () => {
    const stop = new AbortController();
    const hang = (async (_url: string, init: RequestInit) =>
      new Promise((_, fail) => init.signal!.addEventListener('abort', () => fail(new DOMException('aborted', 'AbortError'))))) as unknown as typeof fetch;
    const searching = provider(hang).findProtocol('Pierce BCA', { signal: stop.signal });
    stop.abort();
    await expect(searching).rejects.toThrow('find-protocol was cancelled');
  });

  const recorded = existsSync(saved) ? readdirSync(saved).filter(f => f.startsWith('find-protocol-stream-')) : [];
  it.skipIf(!recorded.length)('replays the live streams saved on 2026-10-28', async () => {
    for (const file of recorded) {
      const { query, lines } = JSON.parse(readFileSync(new URL(file, saved), 'utf8')) as { query: string; lines: { line: string }[] };
      const { fn } = fakeFetch(stream(lines.map(l => l.line).join('\n') + '\n', 512));
      const heard: string[] = [];
      const found = await provider(fn).findProtocol(query, { onProgress: line => heard.push(line) });
      expect(heard.length).toBeGreaterThan(0);
      expect(found.progress).toEqual(heard);
      expect(found.found).toBe(true);
      expect(found.document?.url).toMatch(/MAN0011430/);
    }
  });
});

describe('POST /api/find-protocol with accept: text/event-stream', () => {
  const found: FoundProtocol = { found: true, progress: ['Looking.', 'Found it.'], answer: 'Steps.', sources: [], document: { title: 'Guide', url: PDF }, protocolId: 'pierce-bca' };
  const live: AIProvider = {
    transcribe: async () => ({ transcript: '' }),
    converse: async () => ({ say: '', actions: [], sources: [] }),
    findProtocol: async (_query, l) => {
      for (const line of found.progress) l?.onProgress?.(line);
      return found;
    },
  };
  const failing: AIProvider = { ...live, findProtocol: async () => { throw new UpstreamError('Meta find-protocol timed out after 60 s'); } };

  async function post(provider: AIProvider, accept?: string) {
    const server = createServer(createHandler({ provider, providerName: 'meta', metaModelApi: false, dist: tmpdir() }));
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/find-protocol`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(accept ? { accept } : {}) },
        body: JSON.stringify({ query: 'Pierce BCA' }),
      });
      const events = [];
      if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) for await (const e of readEvents(res.body!)) events.push({ event: e.event, data: JSON.parse(e.data) });
      return { res, events, body: events.length ? null : await res.json() };
    } finally {
      server.close();
    }
  }

  it('streams each progress line, then the FoundProtocol', async () => {
    const { res, events } = await post(live, 'text/event-stream');
    expect(res.status).toBe(200);
    expect(events).toEqual([
      { event: 'progress', data: { line: 'Looking.' } },
      { event: 'progress', data: { line: 'Found it.' } },
      { event: 'found', data: found },
    ]);
  });

  it('still answers in one piece without the header, and the mock streams just its answer', async () => {
    expect((await post(live)).body).toEqual(found);
    const { events } = await post(createMockProvider(), 'text/event-stream');
    expect(events.map(e => e.event)).toEqual(['found']);
    expect(events[0]!.data.progress.length).toBeGreaterThan(0);
  });

  it('sends a failure as an error event', async () => {
    const { res, events } = await post(failing, 'text/event-stream');
    expect(res.status).toBe(200);
    expect(events).toEqual([{ event: 'error', data: { error: 'Meta find-protocol timed out after 60 s' } }]);
  });
});

describe('server-sent events', () => {
  it('reads events split anywhere across chunks', async () => {
    const text = 'event: progress\ndata: {"line":"a"}\n\n: a comment\nevent: found\r\ndata: {"found":true}\r\n\r\ndata: last';
    for (const piece of [1, 3, 7, 1000]) {
      const events = [];
      for await (const e of readEvents(stream(text, piece).body!)) events.push(e);
      expect(events).toEqual([{ event: 'progress', data: '{"line":"a"}' }, { event: 'found', data: '{"found":true}' }, { event: 'message', data: 'last' }]);
    }
  });
});

describe('transcribe', () => {
  const asr = (transcript: string) => json({ transcript });
  const chat = (content: object) => json({ choices: [{ message: { content: JSON.stringify(content) } }] });

  it('puts lab names right on the server, without a model call when the local fixes are sure', async () => {
    const { fn, calls } = fakeFetch(asr('I just got a pierce PCA Protein Assay Kit. Help me run it.'));
    expect(await provider(fn).transcribe(new Uint8Array(10))).toEqual({ transcript: 'I just got a Pierce BCA Protein Assay Kit. Help me run it.' });
    expect(calls).toHaveLength(1);
  });

  it('asks Muse Spark, at minimal effort, only when a name still looks misheard', async () => {
    const { fn, calls } = fakeFetch(asr('I have a PCA kit'), chat({ text: 'I have a BCA kit' }));
    expect(await provider(fn).transcribe(new Uint8Array(10))).toEqual({ transcript: 'I have a BCA kit' });
    expect(calls[1]!.url).toBe('https://api.meta.ai/v1/chat/completions');
    expect(JSON.parse(calls[1]!.init.body as string).reasoning_effort).toBe('minimal');
  });

  it('keeps its own words when the model fails or rewrites the sentence', async () => {
    const { fn } = fakeFetch(asr('I have a PCA kit'), new Response('{}', { status: 500 }), asr('I have a PCA kit'), chat({ text: 'Please tell me everything about protein quantification kits' }));
    const p = provider(fn);
    expect((await p.transcribe(new Uint8Array(10))).transcript).toBe('I have a PCA kit');
    expect((await p.transcribe(new Uint8Array(10))).transcript).toBe('I have a PCA kit');
  });
});

it.skipIf(!local)('the BCA document still validates (the fixtures above assume it)', () => {
  expect(Protocol.safeParse(JSON.parse(readFileSync(new URL('../data/protocols/pierce-bca.json', import.meta.url), 'utf8'))).success).toBe(true);
});
