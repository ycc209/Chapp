import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AIProvider, FindProtocolLive, FoundProtocol, ImportedProtocol, ProtocolIntro } from '../shared/ai.ts';
import { createHandler } from '../server/app.ts';
import { assemble, introOf } from '../server/ai/import.ts';
import { createMockProvider } from '../server/ai/mock.ts';
import { knownProtocols, localProtocolId, protocolBySha } from '../server/ai/protocols.ts';
import { UpstreamError } from '../server/ai/provider.ts';
import { downloadPdf, findAndImport, READING_LINE } from '../server/imports.ts';
import type { ProtocolSummary } from '../shared/protocol.ts';
import { intro, parts } from './import-fixture.ts';

// The import routes on an ephemeral port, saving into temporary folders, with a provider that "reads" any PDF as the
// made-up Demo kit (tests/import-fixture.ts) and counts how often it was asked.

const temp = (name: string) => mkdtempSync(join(tmpdir(), `chapp-${name}-`));
const dist = temp('dist');
writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Chapp</title>');

const pdf = (text = 'demo') => new TextEncoder().encode(`%PDF-1.7\n% ${text}\n<< /Type /Page >>\n<< /Type /Page >>\n%%EOF`);
const sha = async (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

let reads = 0;
async function demoImport(bytes: Uint8Array, source?: { url?: string }, live?: Pick<FindProtocolLive, 'onProgress' | 'onIntro'>): Promise<ImportedProtocol> {
  reads++;
  live?.onProgress?.('Reading the manual');
  live?.onIntro?.(introOf(intro(), source?.url)!);
  live?.onProgress?.('Turning it into steps');
  const { protocol, problems } = assemble(parts(), { sha256: await sha(bytes), pages: 2, ...(source?.url ? { url: source.url } : {}), fetchedAt: '2026-10-28T00:00:00Z', seconds: 1 });
  return { protocol, problems, sources: [] };
}
const reader: AIProvider = { ...createMockProvider(), importProtocol: demoImport };
const { importProtocol: _none, ...noImport } = createMockProvider();

const servers: Server[] = [];
async function start(provider: AIProvider, protocols: string, manuals: string): Promise<string> {
  const server = createServer(createHandler({ provider, providerName: 'meta', metaModelApi: false, dist, protocols, manuals }));
  servers.push(server);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterAll(() => servers.forEach(s => s.close()));

const upload = (base: string, body: Uint8Array | string, type = 'application/pdf') =>
  fetch(`${base}/api/import-protocol?name=demo.pdf`, { method: 'POST', headers: { 'content-type': type }, body: typeof body === 'string' ? body : new Blob([new Uint8Array(body)]) });

describe('POST /api/import-protocol', () => {
  const protocols = temp('protocols');
  const manuals = temp('manuals');
  let base: string, without: string;
  beforeAll(async () => {
    [base, without] = await Promise.all([start(reader, protocols, manuals), start(noImport as AIProvider, protocols, manuals)]);
  });

  it('reads the manual, saves it and serves it like any protocol, with its PDF', async () => {
    const res = await upload(base, pdf());
    expect(res.status).toBe(200);
    const body = (await res.json()) as ImportedProtocol;
    expect(body.protocol.id).toBe('demo-assay');
    expect(body.protocol.source.url).toBe('/api/protocols/demo-assay/manual.pdf');
    expect(existsSync(join(protocols, 'demo-assay.json'))).toBe(true);

    const served = await fetch(`${base}/api/protocols/demo-assay`);
    expect(served.status).toBe(200);
    expect(((await served.json()) as { title: string }).title).toBe('Demo Assay');
    // Library lists it with every other protocol on this computer.
    const list = (await (await fetch(`${base}/api/protocols`)).json()) as ProtocolSummary[];
    expect(list.find(p => p.id === 'demo-assay')).toMatchObject({ title: 'Demo Assay', kit: expect.any(String), steps: expect.any(Number) });
    const manual = await fetch(`${base}${body.protocol.source.url}`);
    expect(manual.headers.get('content-type')).toBe('application/pdf');
    expect(new Uint8Array(await manual.arrayBuffer())).toEqual(pdf());

    // The server's own lookups know it now: by catalog number, and by the file itself.
    expect(knownProtocols(protocols).map(p => p.id)).toContain('demo-assay');
    expect(localProtocolId({ kit: { vendor: 'Demo Bio', catalog: 'd100', name: 'Demo' } }, protocols)).toBe('demo-assay');
    expect(protocolBySha(await sha(pdf()), protocols)?.id).toBe('demo-assay');
  });

  it('does not read the same file twice', async () => {
    const before = reads;
    const body = (await (await upload(base, pdf())).json()) as ImportedProtocol;
    expect(body.protocol.id).toBe('demo-assay');
    expect(reads).toBe(before);
  });

  it('never replaces a document that is not the same manual', async () => {
    const hand = JSON.parse(readFileSync(join(protocols, 'demo-assay.json'), 'utf8'));
    delete hand.imported;
    writeFileSync(join(protocols, 'demo-assay.json'), JSON.stringify(hand));
    const body = (await (await upload(base, pdf('another printing'))).json()) as ImportedProtocol;
    expect(body.protocol.id).toBe('demo-assay-d100');
    expect(body.protocol.source.url).toBe('/api/protocols/demo-assay-d100/manual.pdf');
    expect(JSON.parse(readFileSync(join(protocols, 'demo-assay.json'), 'utf8')).imported).toBeUndefined();
  });

  it('streams its progress when asked for events', async () => {
    const res = await fetch(`${base}/api/import-protocol`, { method: 'POST', headers: { 'content-type': 'application/pdf', accept: 'text/event-stream' }, body: new Blob([pdf('streamed')]) });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const events = [...(await res.text()).matchAll(/event: (\w+)\ndata: (.*)\n/g)].map(m => [m[1], JSON.parse(m[2]!)]);
    expect(events.map(e => e[0])).toEqual(['progress', 'intro', 'progress', 'imported']);
    expect([events[0]![1].line, events[2]![1].line]).toEqual(['Reading the manual', 'Turning it into steps']);
    // What the kit is, before the protocol: an upload has no address on the web yet.
    expect(events[1]![1]).toMatchObject({ title: 'Demo Assay', source: { url: '' } });
    expect(events[3]![1].protocol.title).toBe('Demo Assay');
  });

  it('refuses what is not a PDF, and says when the server cannot read manuals', async () => {
    expect((await upload(base, '{"a":1}', 'application/json')).status).toBe(415);
    expect((await upload(base, '<html>not a pdf</html>')).status).toBe(400);
    expect((await fetch(`${base}/api/import-protocol`)).status).toBe(405);
    expect((await upload(without, pdf())).status).toBe(501);
    expect((await fetch(`${base}/api/protocols/nothing-here/manual.pdf`)).status).toBe(404);
  });

  it('answers 502 when the model fails', async () => {
    const failing = await start({ ...reader, importProtocol: async () => { throw new UpstreamError('Meta import (steps) timed out after 180 s'); } }, temp('p'), temp('m'));
    const res = await upload(failing, pdf('fails'));
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain('timed out');
  });
});

const bcaFile = new URL('../data/protocols/pierce-bca.json', import.meta.url);

describe.skipIf(!existsSync(bcaFile))('the mock reading a manual', () => {
  it('answers with the BCA protocol and saves nothing', async () => {
    const protocols = temp('mock-protocols');
    const base = await start(createMockProvider(), protocols, temp('mock-manuals'));
    const body = (await (await upload(base, pdf('any manual'))).json()) as ImportedProtocol;
    expect(body.protocol.id).toBe('pierce-bca');
    expect(knownProtocols(protocols)).toEqual([]);
  });
});

// ─── Find, then read ─────────────────────────────────────────────────────────────────────────────────────────────

const found = (over: Partial<FoundProtocol> = {}): FoundProtocol => ({
  found: true,
  kit: { vendor: 'Demo Bio', catalog: 'X9', name: 'Demo kit' },
  document: { title: 'Demo manual', url: 'https://demo.example/manual.pdf' },
  progress: ['Looking for the manual'],
  answer: 'Here it is.',
  sources: [],
  ...over,
});

/** A web that serves `files` by URL: [status, content-type, body, location?]. */
function web(files: Record<string, [number, string, Uint8Array | string, string?]>) {
  const asked: string[] = [];
  const fetch = (async (url: string) => {
    asked.push(url);
    const file = files[url];
    if (!file) return new Response('no', { status: 404 });
    const [status, type, body, location] = file;
    return new Response(status >= 300 && status < 400 ? null : typeof body === 'string' ? body : new Uint8Array(body), { status, headers: { 'content-type': type, ...(location ? { location } : {}) } });
  }) as typeof globalThis.fetch;
  return { fetch, asked };
}

describe('findAndImport', () => {
  const opts = () => ({ protocols: temp('fp'), manuals: temp('fm'), log: () => {} });

  it('reads the manual the search found and answers with its protocol', async () => {
    const lines: string[] = [];
    const intros: ProtocolIntro[] = [];
    const { fetch } = web({ 'https://demo.example/manual.pdf': [200, 'application/pdf', pdf('found')] });
    const provider: AIProvider = { ...reader, findProtocol: async (_q, live) => (live?.onProgress?.('Searching'), found()) };
    const o = opts();
    const out = await findAndImport(provider, 'demo kit X9', { onProgress: l => lines.push(l), onIntro: i => intros.push(i) }, { ...o, download: { fetch } });
    expect(intros.map(i => [i.title, i.source.url])).toEqual([['Demo Assay', 'https://demo.example/manual.pdf']]);
    expect(out.protocolId).toBe('demo-assay');
    expect(out.progress).toEqual(['Looking for the manual', READING_LINE, 'Turning it into steps']);
    expect(lines).toEqual(['Searching', READING_LINE, 'Turning it into steps']);
    const saved = knownProtocols(o.protocols)[0]!;
    expect(saved.source.url).toBe('https://demo.example/manual.pdf');
  });

  it('leaves the answer alone when the kit is known, nothing was found, or the provider cannot read', async () => {
    const o = opts();
    const known = { ...reader, findProtocol: async () => found({ protocolId: 'pierce-bca' }) };
    expect((await findAndImport(known, 'bca', undefined, o)).protocolId).toBe('pierce-bca');
    const none = { ...reader, findProtocol: async () => found({ found: false, document: undefined }) };
    expect((await findAndImport(none, 'nothing', undefined, o)).protocolId).toBeUndefined();
    const cannot = { ...(noImport as AIProvider), findProtocol: async () => found() };
    expect((await findAndImport(cannot, 'demo', undefined, o)).progress).toEqual(['Looking for the manual']);
  });

  it('keeps the search answer when the manual cannot be fetched', async () => {
    const { fetch } = web({ 'https://demo.example/manual.pdf': [200, 'text/html', '<html>a product page</html>'] });
    const out = await findAndImport({ ...reader, findProtocol: async () => found() }, 'demo', undefined, { ...opts(), download: { fetch } });
    expect(out.protocolId).toBeUndefined();
    expect(out.answer).toBe('Here it is.');
  });
});

describe('downloadPdf', () => {
  it('follows a redirect to the PDF', async () => {
    const { fetch } = web({
      'https://demo.example/m': [302, 'text/html', '', 'https://cdn.demo.example/m.pdf'],
      'https://cdn.demo.example/m.pdf': [200, 'application/octet-stream', pdf()],
    });
    expect(await downloadPdf('https://demo.example/m', { fetch })).toEqual(pdf());
  });

  it('fetches only public http(s) PDFs within the size limit', async () => {
    const { fetch, asked } = web({
      'https://demo.example/big.pdf': [200, 'application/pdf', pdf('x'.repeat(2000))],
      'https://demo.example/fake.pdf': [200, 'application/pdf', 'not really a pdf'],
      'https://demo.example/away': [302, 'text/html', '', 'http://127.0.0.1:3003/api/health'],
    });
    await expect(downloadPdf('file:///etc/passwd', { fetch })).rejects.toThrow('not http(s)');
    await expect(downloadPdf('http://localhost:3003/x.pdf', { fetch })).rejects.toThrow('does not fetch');
    await expect(downloadPdf('http://192.168.1.4/x.pdf', { fetch })).rejects.toThrow('does not fetch');
    await expect(downloadPdf('https://demo.example/away', { fetch })).rejects.toThrow('does not fetch');
    await expect(downloadPdf('https://demo.example/big.pdf', { fetch, maxBytes: 1000 })).rejects.toThrow('too large');
    await expect(downloadPdf('https://demo.example/fake.pdf', { fetch })).rejects.toThrow('not a PDF');
    expect(asked).not.toContain('http://127.0.0.1:3003/api/health');
  });

  it('gives up on a slow server', async () => {
    const slow = ((_url: string, init: RequestInit) =>
      new Promise((_, fail) => init.signal!.addEventListener('abort', () => fail(init.signal!.reason)))) as typeof globalThis.fetch;
    await expect(downloadPdf('https://demo.example/slow.pdf', { fetch: slow, timeoutMs: 20 })).rejects.toThrow('took too long');
  });
});
