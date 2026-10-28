import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHandler } from '../server/app.ts';
import { createMockProvider } from '../server/ai/mock.ts';
import { newShareId } from '../server/share.ts';
import { MAX_SHARE_BYTES, SHARE_ID, SharedSetup, shareIdFrom, shareLink, StoredShare, type SharedSetup as Setup } from '../shared/share.ts';

// The share format, and POST/GET /api/share on the real handler with a temporary data/shares/.

const all: Setup = {
  format: 'chapp.share/1',
  scope: 'all',
  protocolId: 'pierce-bca',
  procedure: 'microplate',
  kit: [
    { id: 'reagent-a', label: 'BCA Reagent A' },
    { id: 'bsa', label: 'Albumin Standard', detail: 'BSA · 2 mg/mL' },
    { id: 'diluent', label: 'PBS', detail: 'The diluent · use the same for yours' },
  ],
  plan: { samples: 12, replicates: 2 },
  results: { readings: { A1: 0.095, B1: 0.097, A2: 1.452 }, sampleData: true, r2: 0.998 },
};
const { results: _results, ...noresults } = { ...all, scope: 'noresults' as const };
const { plan: _plan, ...protocolOnly } = { ...noresults, scope: 'protocol' as const };

/** A JPEG data URL of about `bytes` characters (not a real picture: the server checks the shape, not the pixels). */
const photo = (bytes: number) => `data:image/jpeg;base64,${'A'.repeat(Math.floor(bytes / 4) * 4)}`;

describe('the shared-setup format', () => {
  it('takes the three scopes the Share-QR artboard offers', () => {
    expect(SharedSetup.safeParse(all).success).toBe(true);
    expect(SharedSetup.safeParse(noresults).success).toBe(true);
    expect(SharedSetup.safeParse(protocolOnly).success).toBe(true);
  });

  it('keeps what a trimmed share left out from coming along', () => {
    expect(SharedSetup.safeParse({ ...all, scope: 'noresults' }).success).toBe(false);
    expect(SharedSetup.safeParse({ ...noresults, scope: 'protocol' }).success).toBe(false);
    expect(SharedSetup.safeParse({ ...protocolOnly, scope: 'all' }).success).toBe(false);
  });

  it('rejects what is not a setup', () => {
    const bad = (patch: Record<string, unknown>) => SharedSetup.safeParse({ ...all, ...patch }).success;
    expect(bad({ format: 'chapp.share/2' })).toBe(false);
    expect(bad({ protocolId: '../etc/passwd' })).toBe(false);
    expect(bad({ plan: { samples: 0, replicates: 2 } })).toBe(false);
    expect(bad({ plan: { samples: 12.5, replicates: 2 } })).toBe(false);
    expect(bad({ plan: { samples: 200, replicates: 2 } })).toBe(false);
    expect(bad({ results: { readings: { Z9: 1 } } })).toBe(false);
    expect(bad({ results: { readings: {} } })).toBe(false);
    expect(bad({ results: { readings: { A1: Number.NaN } } })).toBe(false);
    expect(bad({ kit: [{ id: 'bsa', label: 'BSA' }, { id: 'bsa', label: 'BSA again' }] })).toBe(false);
    expect(bad({ kit: [{ id: 'bsa', label: 'BSA', photo: 'https://example.com/bsa.jpg' }] })).toBe(false);
    expect(bad({ extra: true })).toBe(false);
    // A downscaled photo is fine.
    expect(bad({ kit: [{ id: 'bsa', label: 'BSA', photo: photo(40_000) }] })).toBe(true);
  });

  it('reads the share id back out of a QR code', () => {
    const id = newShareId();
    expect(id).toMatch(SHARE_ID);
    expect(shareIdFrom(shareLink('https://lab-mac.example.ts.net:8444', id))).toBe(id);
    expect(shareIdFrom(shareLink('http://localhost:5175/', id))).toBe(id);
    expect(shareIdFrom(`https://elsewhere.example/import/?s=${id}&x=1`)).toBe(id);
    expect(shareIdFrom(`https://example.com/share?s=${id}`)).toBeNull();
    expect(shareIdFrom('https://example.com/import?s=../../etc')).toBeNull();
    expect(shareIdFrom(`javascript:alert(1)//import?s=${id}`)).toBeNull();
    expect(shareIdFrom('WIFI:S:lab;T:WPA;P:secret;;')).toBeNull();
  });
});

describe('POST and GET /api/share', () => {
  const dist = mkdtempSync(join(tmpdir(), 'chapp-dist-'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Chapp</title>');
  const shares = join(mkdtempSync(join(tmpdir(), 'chapp-shares-')), 'shares'); // made on the first share
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createServer(createHandler({ provider: createMockProvider(), providerName: 'mock', metaModelApi: false, dist, shares }));
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  const post = (body: unknown, type = 'application/json') =>
    fetch(`${base}/api/share`, { method: 'POST', headers: { 'content-type': type }, body: typeof body === 'string' ? body : JSON.stringify(body) });

  it('stores a setup and gives it back as sent, with its id and time', async () => {
    const before = Date.now();
    const res = await post(all);
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect(id).toMatch(SHARE_ID);
    expect(existsSync(join(shares, `${id}.json`))).toBe(true);

    const got = await fetch(`${base}/api/share/${id}`);
    expect(got.status).toBe(200);
    const stored = StoredShare.parse(await got.json());
    const { id: storedId, sharedAt, ...setup } = stored;
    expect(storedId).toBe(id);
    expect(setup).toEqual(all);
    expect(Date.parse(sharedAt)).toBeGreaterThanOrEqual(before - 1000);
  });

  it('makes a new share for each trim, never overwriting one', async () => {
    const ids = await Promise.all([all, noresults, protocolOnly].map(async s => ((await (await post(s)).json()) as { id: string }).id));
    expect(new Set(ids).size).toBe(3);
    const trimmed = (await (await fetch(`${base}/api/share/${ids[2]}`)).json()) as Record<string, unknown>;
    expect(trimmed.scope).toBe('protocol');
    expect(trimmed).not.toHaveProperty('plan');
    expect(trimmed).not.toHaveProperty('results');
  });

  it('answers 404 for a share that is not here, and never reads outside data/shares', async () => {
    expect((await fetch(`${base}/api/share/${newShareId()}`)).status).toBe(404);
    expect((await fetch(`${base}/api/share/..%2F..%2Fpackage`)).status).toBe(404);
    expect((await fetch(`${base}/api/share/abc`)).status).toBe(404);
    expect((await fetch(`${base}/api/share/a/b`)).status).toBe(404);
  });

  it('rejects what is not a setup, with a message', async () => {
    const bad = await post({ ...all, plan: { samples: -1, replicates: 2 } });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/plan\.samples/);
    expect((await post('{not json')).status).toBe(400);
    expect((await post(all, 'text/plain')).status).toBe(415);
  });

  it('takes photos up to the limit and refuses a bigger body with 413', async () => {
    const kit = (each: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: `bottle-${i}`, label: `Bottle ${i}`, photo: photo(each) }));
    const fits = await post({ ...all, kit: kit(600_000, 4) });
    expect(fits.status).toBe(201);

    const huge = JSON.stringify({ ...all, kit: kit(900_000, 4) });
    expect(huge.length).toBeGreaterThan(MAX_SHARE_BYTES);
    const res = await post(huge);
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toMatch(/3 MB/);
  });

  it('only POSTs to /api/share and only GETs a share', async () => {
    const list = await fetch(`${base}/api/share`);
    expect(list.status).toBe(405);
    expect(list.headers.get('allow')).toBe('POST');
    const { id } = (await (await post(all)).json()) as { id: string };
    const del = await fetch(`${base}/api/share/${id}`, { method: 'DELETE' });
    expect(del.status).toBe(405);
    expect(del.headers.get('allow')).toBe('GET');
  });

  it('keeps every share as one file named by its id', () => {
    for (const file of readdirSync(shares)) expect(file).toMatch(/^[a-km-np-z2-9]{10}\.json$/);
  });
});
