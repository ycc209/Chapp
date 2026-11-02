import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AIProvider, ConverseRequest } from '../shared/ai.ts';
import { createHandler, MAX_AUDIO } from '../server/app.ts';
import { createMockProvider, MOCK_TRANSCRIPT } from '../server/ai/mock.ts';
import { UpstreamError } from '../server/ai/provider.ts';

// The real handler on an ephemeral port, with the mock provider, a provider whose model is down, and a spy.

const dist = mkdtempSync(join(tmpdir(), 'chapp-dist-'));
writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Chapp</title>');

const down: AIProvider = {
  transcribe: async () => { throw new UpstreamError('Meta transcribe timed out after 20 s'); },
  converse: async () => { throw new UpstreamError('Meta converse failed (500): boom'); },
  findProtocol: async () => { throw new UpstreamError('Meta find-protocol timed out after 60 s'); },
};
const seen: { converse?: ConverseRequest; query?: string; wav?: number } = {};
const spy: AIProvider = {
  transcribe: async wav => { seen.wav = wav.length; return { transcript: 'ok' }; },
  converse: async request => { seen.converse = request; return { say: 'ok', actions: [], sources: [] }; },
  findProtocol: async query => { seen.query = query; return { found: false, progress: [], answer: '', sources: [] }; },
};

const servers: Server[] = [];
async function start(provider: AIProvider, providerName: 'mock' | 'meta' = 'mock'): Promise<string> {
  const server = createServer(createHandler({ provider, providerName, metaModelApi: false, dist }));
  servers.push(server);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
let mock: string, failing: string, spying: string;
beforeAll(async () => {
  [mock, failing, spying] = await Promise.all([start(createMockProvider()), start(down, 'meta'), start(spy)]);
});
afterAll(() => servers.forEach(s => s.close()));

/** A WAV header and a few samples of silence: all the route checks before handing it on. */
function wav(samples = 160): Uint8Array {
  const data = samples * 2;
  const b = Buffer.alloc(44 + data);
  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(36 + data, 4); b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii'); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii'); b.writeUInt32LE(data, 40);
  return new Uint8Array(b);
}

const postJson = (base: string, path: string, body: unknown) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const postWav = (base: string, body: Uint8Array | string, type = 'audio/wav') =>
  fetch(`${base}/api/voice`, { method: 'POST', headers: { 'content-type': type }, body: typeof body === 'string' ? body : new Blob([new Uint8Array(body)]) });

describe('routes with the mock provider', () => {
  it('GET /api/health reports the provider', async () => {
    const res = await fetch(`${mock}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, provider: 'mock', metaModelApi: false });
  });

  it('POST /api/converse returns pending tools and accepts execution receipts before the final answer', async () => {
    const res = await postJson(mock, '/api/converse', { text: MOCK_TRANSCRIPT, context: { screen: 'home', protocolId: null } });
    expect(res.status).toBe(200);
    const reply = await res.json();
    expect(reply.actions).toEqual([]);
    expect(reply.say).toBe('');
    expect(reply.pendingTools).toEqual([expect.objectContaining({ action: { type: 'navigate', to: '/protocol' } })]);
    const completed = await postJson(mock, '/api/converse', {
      text: MOCK_TRANSCRIPT, context: { screen: 'protocol', protocolId: 'pierce-bca' }, continuationToken: reply.continuationToken,
      toolResults: [{ callId: reply.pendingTools[0].callId, ok: true, message: 'Opened the protocol.' }],
    });
    expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({ say: 'Opened the protocol.', actions: [] });
  });

  it('POST /api/find-protocol answers with a FoundProtocol', async () => {
    const res = await postJson(mock, '/api/find-protocol', { query: 'Pierce BCA' });
    expect(res.status).toBe(200);
    expect((await res.json()).found).toBe(true);
  });

  it('POST /api/voice answers with a Transcript', async () => {
    const res = await postWav(mock, wav());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ transcript: MOCK_TRANSCRIPT });
  });

  it('still serves protocols and the app', async () => {
    expect((await fetch(`${mock}/api/protocols/no-such-kit`)).status).toBe(404);
    expect((await fetch(`${mock}/api/nothing`)).status).toBe(404);
    const page = await fetch(`${mock}/run/3`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<title>Chapp</title>');
    expect((await fetch(`${mock}/missing.png`)).status).toBe(404);
  });
});

describe('routes hand the provider only validated input', () => {
  it('passes the trimmed converse request through', async () => {
    const res = await postJson(spying, '/api/converse', { text: ' next ', context: { screen: 'run', step: 2, extra: 'dropped' } });
    expect(res.status).toBe(200);
    expect(seen.converse).toEqual({ text: 'next', context: { screen: 'run', step: 2 } });
  });

  it('passes the query and the whole recording', async () => {
    await postJson(spying, '/api/find-protocol', { query: ' Abcam ab287843 ' });
    expect(seen.query).toBe('Abcam ab287843');
    await postWav(spying, wav(1000), 'audio/wav; codecs=1');
    expect(seen.wav).toBe(44 + 2000);
  });
});

describe('bad input gets a 4xx with a message', () => {
  it.each([
    ['/api/converse', '{not json', 400, /not valid JSON/],
    ['/api/converse', { text: '', context: { screen: 'home' } }, 400, /text/],
    ['/api/converse', { text: 'hi' }, 400, /context/],
    ['/api/converse', { text: 'hi', context: { screen: 'home', samples: -1 } }, 400, /samples/],
    ['/api/find-protocol', {}, 400, /query/],
    ['/api/find-protocol', { query: 7 }, 400, /query/],
  ])('POST %s %j → %i', async (path, body, status, message) => {
    const res = await postJson(mock, path, body);
    expect(res.status).toBe(status);
    expect((await res.json()).error).toMatch(message);
  });

  it('wants JSON as JSON', async () => {
    const res = await fetch(`${mock}/api/converse`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    expect(res.status).toBe(415);
  });

  it('wants POST', async () => {
    const res = await fetch(`${mock}/api/converse`);
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });

  it('turns away what is not a WAV recording', async () => {
    expect((await postWav(mock, 'hello there, not audio')).status).toBe(400);
    expect((await postWav(mock, wav(), 'audio/webm')).status).toBe(415);
    const header = wav(0);
    expect((await postWav(mock, header)).status).toBe(400);
  });

  it('caps the size of bodies', async () => {
    const big = new Uint8Array(MAX_AUDIO + 1);
    big.set(wav(1));
    const res = await postWav(mock, big);
    expect(res.status).toBe(413);
    expect((await res.json()).error).toMatch(/too large/);
    const long = await postJson(mock, '/api/converse', { text: 'x', context: { screen: 'x'.repeat(1024 * 1024) } });
    expect(long.status).toBe(413);
  });
});

describe('a failing model gets a 502 with a short message', () => {
  it.each([
    ['/api/converse', { text: 'hi', context: { screen: 'home' } }, /converse failed/],
    ['/api/find-protocol', { query: 'Pierce BCA' }, /timed out/],
  ])('%s', async (path, body, message) => {
    const res = await postJson(failing, path, body);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(message);
  });

  it('/api/voice', async () => {
    const res = await postWav(failing, wav());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'Meta transcribe timed out after 20 s' });
  });

  it('health still answers', async () => {
    expect(await (await fetch(`${failing}/api/health`)).json()).toEqual({ ok: true, provider: 'meta', metaModelApi: false });
  });
});
