import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHandler } from '../server/app.ts';
import { createMockProvider } from '../server/ai/mock.ts';
import { forgetProtocol, kitPhotos, saveProtocol, useKits, useMine } from '../src/state/library.ts';

// Deleting from the library: the server drops a protocol Chapp read from a manual, with the manual it kept and its
// step pictures, and never a built-in one; the phone forgets a protocol altogether (src/state/library.ts).

const cite = (quote: string) => ({ page: 1, quote });
const document = (id: string, imported: boolean) => ({
  format: 'chapp.protocol/1',
  id,
  title: `Demo ${id}`,
  summary: 'A small protocol, made up here.',
  source: { title: 'Demo manual', publisher: 'Demo Bio', docId: 'D1', revision: '1', date: '', url: 'https://demo.example/m.pdf', sha256: 'a'.repeat(64), pages: 1, fetchedAt: '2026-10-29T00:00:00.000Z' },
  kit: { name: 'Demo Kit', vendor: 'Demo Bio', variants: [{ catalog: 'D1', scale: '', contents: [{ component: 'insulin' }] }], cite: cite('Kit contents') },
  overview: { procedure: 'diff', steps: ['Grow to 80% confluence'], expected: [], cite: cite('To initiate differentiation') },
  components: [{ id: 'insulin', name: 'Insulin', role: 'reagent', suppliedBy: 'kit', cite: cite('Insulin') }],
  equipment: [],
  mixes: [],
  standardCurves: [],
  procedures: [{ id: 'diff', name: 'Differentiation', format: 'cells', steps: [{ id: 'grow', stage: 'prepare', title: 'Grow to 80%', key: 'Grow cells to ~80% confluence', cite: cite('culture cells until ~80% confluent') }], cite: cite('culture cells') }],
  defaults: { procedure: 'diff' },
  notes: [],
  ...(imported ? { imported: { at: '2026-10-31T00:00:00.000Z', model: 'muse-spark-1.3', seconds: 12, problems: [] } } : {}),
});

const protocols = mkdtempSync(join(tmpdir(), 'chapp-protocols-'));
const manuals = mkdtempSync(join(tmpdir(), 'chapp-manuals-'));
const pictures = mkdtempSync(join(tmpdir(), 'chapp-pictures-'));
const dist = mkdtempSync(join(tmpdir(), 'chapp-dist-'));
let server: Server;
let base: string;

beforeAll(async () => {
  for (const [id, imported] of [['read-kit', true], ['built-in', false]] as const) writeFileSync(join(protocols, `${id}.json`), JSON.stringify(document(id, imported)));
  mkdirSync(join(manuals, 'read-kit'), { recursive: true });
  writeFileSync(join(manuals, 'read-kit', 'manual.pdf'), '%PDF-1.4 demo');
  mkdirSync(join(pictures, 'v2', 'read-kit'), { recursive: true });
  writeFileSync(join(pictures, 'v2', 'read-kit', 'grow.svg'), '<svg/>');
  server = createServer(createHandler({ provider: createMockProvider(), providerName: 'mock', metaModelApi: false, dist, protocols, manuals, pictures }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>(done => server.close(() => done())));

describe('DELETE /api/protocols/:id', () => {
  it('lists which protocols were read from a manual, and removes one with its manual and pictures', async () => {
    const before = (await (await fetch(`${base}/api/protocols`)).json()) as { id: string; imported?: boolean }[];
    expect(before.map(p => [p.id, p.imported]).sort()).toEqual([['built-in', false], ['read-kit', true]]);
    const res = await fetch(`${base}/api/protocols/read-kit`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 'read-kit' });
    expect(existsSync(join(protocols, 'read-kit.json'))).toBe(false);
    expect(existsSync(join(manuals, 'read-kit'))).toBe(false);
    expect(existsSync(join(pictures, 'v2', 'read-kit'))).toBe(false);
    const after = (await (await fetch(`${base}/api/protocols`)).json()) as { id: string }[];
    expect(after.map(p => p.id)).toEqual(['built-in']);
    expect((await fetch(`${base}/api/protocols/read-kit`)).status).toBe(404);
    expect((await fetch(`${base}/api/protocols/read-kit`, { method: 'DELETE' })).status).toBe(404);
  });

  it('leaves a built-in protocol alone', async () => {
    const res = await fetch(`${base}/api/protocols/built-in`, { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('built into Chapp');
    expect(existsSync(join(protocols, 'built-in.json'))).toBe(true);
    expect((await fetch(`${base}/api/protocols/built-in`)).status).toBe(200);
  });
});

describe('forgetting a protocol on the phone', () => {
  const kept = new Map<string, string>();
  beforeEach(() => {
    kept.clear();
    vi.stubGlobal('localStorage', { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => kept.set(k, v), removeItem: (k: string) => kept.delete(k) });
    useMine.setState({ protocols: {} });
    useKits.setState({ kits: {} });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('takes it out of Saved and Recent and drops its kit photos, leaving the others', () => {
    saveProtocol('read-kit', { title: 'Demo read-kit', at: 5 });
    saveProtocol('built-in', { title: 'Demo built-in', at: 6 });
    useKits.setState({ kits: { 'read-kit': { insulin: 'data:image/jpeg;base64,AAAA' }, 'built-in': { insulin: 'data:image/jpeg;base64,BBBB' } } });
    forgetProtocol('read-kit');
    expect(useMine.getState().protocols).toEqual({ 'built-in': { usedAt: null, savedAt: 6, title: 'Demo built-in' } });
    expect(kitPhotos('read-kit')).toEqual({});
    expect(kitPhotos('built-in')).toEqual({ insulin: 'data:image/jpeg;base64,BBBB' });
  });
});
