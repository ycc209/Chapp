import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ConverseContext, ConverseReply } from '../shared/ai.ts';
import { createMockProvider, MOCK_TRANSCRIPT } from '../server/ai/mock.ts';
import { chooseProvider } from '../server/ai/provider.ts';
import { createProvider } from '../server/ai/select.ts';
import { ConverseReplySchema, ConverseRequestSchema, FindProtocolRequestSchema } from '../server/ai/schema.ts';
import { BCA, bcaFacts, localProtocolId, protocolBrief, loadProtocol } from '../server/ai/protocols.ts';

// The mock must behave the same with or without the local BCA document (data/ is git-ignored), so every check here
// holds on a clean checkout; the ones that need the document's numbers say so.
// The hand-made protocol, with the manual's own words in its citations; a clean checkout has only the demo copy
// without them (server/demo/), on which these checks of quotes do not apply.
const bcaFile = new URL('../data/protocols/pierce-bca.json', import.meta.url);
const local = existsSync(bcaFile) && readFileSync(bcaFile, 'utf8').includes('"quote"');
const mock = createMockProvider();
const home: ConverseContext = { screen: 'home', protocolId: null };
const run: ConverseContext = { screen: 'run', protocolId: 'pierce-bca', step: 1, samples: 12, replicates: 2 };
const ask = async (text: string, context = home) => {
  const reply = await mock.converse({ text, context });
  expect(ConverseReplySchema.parse(reply)).toEqual(reply);
  return reply;
};
const requested = (reply: ConverseReply) => {
  expect(reply.actions).toEqual([]);
  return reply.pendingTools?.map(t => t.action) ?? [];
};

describe('mock provider: converse', () => {
  it('prepares the mock kit navigation and cites the manual before execution', async () => {
    const reply = await ask(MOCK_TRANSCRIPT);
    expect(reply.say).toBe('');
    expect(reply.continuationToken).toBeTruthy();
    expect(requested(reply)).toEqual([{ type: 'openProtocol', protocolId: 'pierce-bca' }, { type: 'navigate', to: '/protocol' }]);
    expect(reply.sources).toEqual([{ url: BCA.source.url, title: BCA.source.title }]);
  });

  it.each(['Pierce kit please', 'I have a protein assay to run', 'bca'])('hears the kit in "%s"', async text => {
    expect(requested(await ask(text))).toContainEqual({ type: 'navigate', to: '/protocol' });
  });

  it('moves to the next step and names it when it knows the protocol', async () => {
    const reply = await ask('next', run);
    expect(requested(reply)).toEqual([{ type: 'nextStep' }]);
    expect(reply.say).toBe(''); // It has not advanced until the browser acknowledges it.
    expect(requested(await ask('Next one', home))).toEqual([{ type: 'nextStep' }]);
    expect(requested(await ask('下一步', run))).toEqual([{ type: 'nextStep' }]);
  });

  it('goes back a step', async () => {
    expect(requested(await ask('go back', run))).toEqual([{ type: 'previousStep' }]);
  });

  it.each([
    ['Make it triplicates.', 3],
    ['in triplicate', 3],
    ['duplicates please', 2],
    ['4 replicates', 4],
    ['三重複', 3],
  ])('sets replicates from "%s"', async (text, replicates) => {
    const reply = await ask(text, run);
    expect(requested(reply)).toEqual([{ type: 'setReplicates', replicates }]);
  });

  it.each([
    ['12 samples', 12],
    ['I have twelve samples', 12],
    ['8 個樣本', 8],
  ])('sets samples from "%s"', async (text, samples) => {
    expect(requested(await ask(text, run))).toEqual([{ type: 'setSamples', samples }]);
  });

  it('takes samples and replicates together, with the run numbers the app shows', async () => {
    const reply = await ask('12 samples in triplicate', run);
    expect(requested(reply)).toEqual([{ type: 'setSamples', samples: 12 }, { type: 'setReplicates', replicates: 3 }]);
    expect(reply.say).toBe('');
    expect(new Set(reply.pendingTools?.map(t => t.callId)).size).toBe(2);
  });

  it('refuses a plan that does not fit one plate instead of setting it', async () => {
    const reply = await ask('200 samples', run);
    expect(requested(reply)).toEqual([]);
    expect(reply.say).toMatch(/96-well plate/);
    if (local) expect(requested(await ask('40 samples in quadruplicate', run))).toEqual([]);
  });

  it('greets back and says what to try next, in the user’s language', async () => {
    const hi = await ask('Hello!');
    expect(hi.expression).toBe('happy');
    expect(hi.say).toMatch(/Pierce BCA/);
    expect((await ask('hi', { screen: 'plan', protocolId: 'pierce-bca' })).say).toMatch(/how many samples/);
    expect((await ask('hey', run)).say).toMatch(/next/);
    expect((await ask('你好')).say).toMatch(/說明書/);
  });

  it('suggests what it can do for anything else', async () => {
    const reply = await ask('What is the meaning of life?');
    expect(reply.say).toMatch(/^I can help you run a kit/);
    expect(requested(reply)).toEqual([]);
  });

  it('reports a failed execution receipt without claiming the requested change succeeded', async () => {
    const pending = await ask('next', run);
    const reply = await mock.converse({ text: 'next', context: run, continuationToken: pending.continuationToken,
      toolResults: [{ callId: pending.pendingTools![0]!.callId, ok: false, message: 'The step changed while the answer was loading.' }],
    });
    expect(reply.say).toBe('Could not complete: The step changed while the answer was loading.');
    expect(reply.actions).toEqual([]);
    expect(reply.pendingTools).toBeUndefined();
  });

  it.skipIf(!local)('answers a question at the bench from the manual, with its page and words (storyboard ⑤)', async () => {
    const reply = await ask('What if it turns cloudy when I add B?', run);
    expect(reply.say).toBe('It turns cloudy when B goes in, then clears to green as you mix. That is normal.');
    expect(requested(reply)).toEqual([]);
    expect(reply.sources).toEqual([
      {
        url: BCA.source.url,
        title: BCA.source.title,
        page: 2,
        // The manual's own sentence, from the hand-made protocol (data/, not copied here).
        quote: expect.stringMatching(/turbidity/),
      },
    ]);
    // Said as a statement at the bench, or asked on another screen with the protocol open: the same note.
    expect((await ask('It turned cloudy when I added B', run)).sources[0]?.page).toBe(2);
    expect((await ask('What if it turns cloudy when I add B?', { screen: 'protocol', protocolId: 'pierce-bca' })).say).toMatch(/^It turns cloudy/);
  });

  it.skipIf(!local)('finds the step or note a bench question is about', async () => {
    // The step's own words from the manual, short enough to say (data/, not copied here).
    expect(await ask('How long do I incubate?', run)).toMatchObject({ say: expect.stringMatching(/incubate at 37°C/), sources: [{ page: 3 }] });
    expect((await ask('How long does the working reagent keep?', run)).say).toBe('Keeps for several days at room temperature in a closed container.');
    expect((await ask('I only have a little sample, can I use 10 µL?', run)).sources[0]?.page).toBe(3);
  });

  it('draws the working reagent as A2UI, for the run or the samples asked about', async () => {
    const reply = await ask('How much working reagent do I need?', run);
    expect(reply.a2ui).toEqual([
      { version: 'v0.9', createSurface: { surfaceId: 'answer', catalogId: 'chapp' } },
      { version: 'v0.9', updateComponents: { surfaceId: 'answer', components: [{ id: 'root', component: 'ReagentCard' }] } },
    ]);
    // The words point at the card; they carry no number of their own.
    expect(reply.say).not.toMatch(/\d/);
    const thirty = await ask('How much working reagent for 30 samples?', run);
    expect(thirty.a2ui?.[1]).toMatchObject({ updateComponents: { components: [{ id: 'root', component: 'ReagentCard', samples: 30 }] } });
    // Without a kit open there is nothing to work it out from.
    expect((await ask('How much working reagent do I need?')).a2ui).toBeUndefined();
  });

  it('leaves the plan, the kit and everything else to their own answers', async () => {
    expect(requested(await ask('12 samples in triplicate', run))).toHaveLength(2);
    expect(requested(await ask(MOCK_TRANSCRIPT, run))).toContainEqual({ type: 'navigate', to: '/protocol' });
    expect((await ask('Is sample 3 OK?', run)).sources).toEqual([]);
    // Without a protocol open there is no manual to answer from.
    expect((await ask('What if it turns cloudy when I add B?')).sources).toEqual([]);
  });

  it('answers the same request the same way', async () => {
    const first = await ask('12 samples in triplicate', run);
    const second = await ask('12 samples in triplicate', run);
    expect(requested(first)).toEqual(requested(second));
    expect(first.continuationToken).not.toBe(second.continuationToken);
  });
});

describe('mock provider: findProtocol and transcribe', () => {
  it('finds the Thermo Fisher BCA user guide, with progress lines and the catalog asked for', async () => {
    const found = await mock.findProtocol('Pierce BCA protein assay kit 23227');
    expect(found.found).toBe(true);
    expect(found.kit).toEqual({ vendor: 'Thermo Scientific', catalog: '23227', name: 'Pierce BCA Protein Assay Kit' });
    expect(found.document).toEqual({ title: BCA.source.title, version: 'MAN0011430 rev. D, 2026-06-18', url: BCA.source.url });
    expect(found.progress.length).toBeGreaterThanOrEqual(2);
    expect(found.answer).toContain('Read at 562 nm');
    expect(found.sources).toEqual([{ url: BCA.source.url, title: BCA.source.title }]);
    expect((await mock.findProtocol('BCA kit')).kit?.catalog).toBe('23225');
    // The guide is a protocol on this machine: the app opens that one.
    expect(found.protocolId).toBe(existsSync(bcaFile) ? 'pierce-bca' : undefined);
  });

  it.skipIf(!local)('knows a found manual as the protocol on this machine, by its document or its kit', () => {
    const doc = { title: 'Pierce BCA Protein Assay Kit User Guide', url: 'https://assets.thermofisher.com/TFS-Assets/LSG/manuals/MAN0011430_Pierce_BCA_Protein_Asy_UG.pdf' };
    expect(localProtocolId({ document: doc })).toBe('pierce-bca');
    expect(localProtocolId({ document: { title: 'User guide', url: 'https://example.com/MAN0011430_Pierce_BCA_Protein_Asy_UG.pdf' } })).toBe('pierce-bca');
    expect(localProtocolId({ kit: { vendor: 'Thermo Fisher Scientific', catalog: '23227', name: 'Pierce BCA' } })).toBe('pierce-bca');
    expect(localProtocolId({ document: { title: 'Bradford guide', url: 'https://example.com/bradford.pdf' }, kit: { vendor: 'Bio-Rad', catalog: '5000006', name: 'Bradford' } })).toBeUndefined();
  });

  it('transcribes to the Listening artboard’s sentence', async () => {
    expect(await mock.transcribe(new Uint8Array(100))).toEqual({ transcript: MOCK_TRANSCRIPT });
  });
});

describe('BCA facts', () => {
  it.skipIf(!local)('the fallback constants match the local document', () => {
    expect(bcaFacts()).toEqual(BCA);
  });

  it.skipIf(!local)('give the model a compact brief with this run’s computed numbers', () => {
    const brief = protocolBrief(loadProtocol('pierce-bca')!, { screen: 'run', protocolId: 'pierce-bca', step: 0, samples: 12, replicates: 2 });
    expect(brief).toContain('0: m-standards, Prepare the BSA standards');
    expect(brief).toContain('42 wells; working reagent 10.1 mL (BCA Reagent A 9.9 mL + BCA Reagent B 198 µL)');
    expect(brief).toContain('400 µL BSA stock');
    expect(brief.length).toBeLessThan(5000);
  });
});

describe('provider selection', () => {
  it('follows AI_PROVIDER, else meta with a key and mock without', () => {
    expect(chooseProvider({ AI_PROVIDER: 'mock', MODEL_API_KEY: 'k' })).toBe('mock');
    expect(chooseProvider({ AI_PROVIDER: ' META ', MODEL_API_KEY: 'k' })).toBe('meta');
    expect(chooseProvider({ MODEL_API_KEY: 'k' })).toBe('meta');
    expect(chooseProvider({})).toBe('mock');
    expect(chooseProvider({ AI_PROVIDER: '' })).toBe('mock');
    expect(() => chooseProvider({ AI_PROVIDER: 'openai' })).toThrow(/mock" or "meta/);
  });

  it('refuses meta without a key rather than failing on the first call', () => {
    expect(() => createProvider({ AI_PROVIDER: 'meta' })).toThrow(/MODEL_API_KEY/);
    expect(createProvider({}).name).toBe('mock');
  });
});

describe('request validation', () => {
  it('accepts a converse request and trims the text', () => {
    expect(ConverseRequestSchema.parse({ text: '  next  ', context: { screen: 'run', step: 2 } })).toEqual({ text: 'next', context: { screen: 'run', step: 2 } });
  });

  it.each([
    [{ text: '', context: { screen: 'home' } }],
    [{ text: 'hi' }],
    [{ text: 'hi', context: { screen: 'home', step: -1 } }],
    [{ text: 'hi', context: { screen: 'home', samples: 2.5 } }],
    [{ text: 'x'.repeat(12001), context: { screen: 'home' } }],
  ])('rejects %j', body => {
    expect(ConverseRequestSchema.safeParse(body).success).toBe(false);
  });

  it('needs a query to find a protocol', () => {
    expect(FindProtocolRequestSchema.safeParse({ query: ' ' }).success).toBe(false);
    expect(FindProtocolRequestSchema.parse({ query: ' Pierce BCA ' })).toEqual({ query: 'Pierce BCA' });
  });

  it('holds replies to the actions the app knows', () => {
    const ok = { say: 'Hi', actions: [], sources: [] };
    expect(ConverseReplySchema.safeParse(ok).success).toBe(true);
    expect(ConverseReplySchema.safeParse({ ...ok, actions: [{ type: 'navigate', to: '/nowhere' }] }).success).toBe(false);
    expect(ConverseReplySchema.safeParse({ ...ok, actions: [{ type: 'setReplicates', replicates: 0 }] }).success).toBe(false);
    expect(ConverseReplySchema.safeParse({ ...ok, actions: [{ type: 'launchRocket' }] }).success).toBe(false);
    expect(ConverseReplySchema.safeParse({ ...ok, say: ' ' }).success).toBe(false);
  });
});


describe('overview response contract', () => {
  it('preserves progressive snapshots and rejects a ready preview with no saved protocol', () => {
    const reply = { say: 'The preview is opening.', actions: [], sources: [], protocolPreview: { id: 'overview-1', state: 'reading', progress: ['Reading the manual'] } };
    expect(ConverseReplySchema.parse(reply)).toEqual(reply);
    expect(ConverseReplySchema.safeParse({ ...reply, protocolPreview: { id: 'overview-1', state: 'ready' } }).success).toBe(false);
    expect(ConverseReplySchema.parse({ ...reply, protocolPreview: { id: 'overview-1', state: 'ready', protocolId: 'demo-kit' } }).protocolPreview?.protocolId).toBe('demo-kit');
  });
});
