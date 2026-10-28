import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createHandler } from '../server/app.ts';
import { createMockProvider } from '../server/ai/mock.ts';
import { b64url, createPushHandler, encryptMessage, fromB64url, PUSH_SERVICES, vapidAuthorization, vapidKeys, type PushSubscriptionJson } from '../server/push.ts';
import { pushSupport } from '../src/screens/run/push.ts';

// Web Push for Time's up: the encryption against RFC 8291's own example, the VAPID signature, and the timers the
// server keeps, delivered to a fake push service (nothing here touches the network).

describe('encryption (RFC 8291, aes128gcm)', () => {
  it('matches the RFC’s worked example byte for byte (Appendix A)', () => {
    const subscription: PushSubscriptionJson = {
      endpoint: 'https://push.example.net/push/JzLQ3raZJfFBR0aqvOMsLrt54w4rJUsV',
      keys: { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
    };
    const body = encryptMessage(new TextEncoder().encode('When I grow up, I want to be a watermelon'), subscription, {
      privateKey: fromB64url('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'),
      salt: fromB64url('DGv6ra1nlYgDCS1FRnbzlw'),
    });
    // The RFC prints the 86-octet header and the ciphertext as two base64url strings.
    const header = fromB64url('DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8');
    const sealed = fromB64url('8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ');
    expect(header).toHaveLength(86);
    expect(b64url(body)).toBe(b64url(new Uint8Array([...header, ...sealed])));
  });
});

/** The browser's side: a key pair and an auth secret, and the decryption a browser does on a push. */
function browser() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = new Uint8Array(16).map((_, i) => i * 7 + 1);
  const keys = { p256dh: b64url(ecdh.getPublicKey()), auth: b64url(auth) };
  const open = (body: Uint8Array) => {
    const salt = body.subarray(0, 16);
    const idlen = body[20]!;
    const server = body.subarray(21, 21 + idlen);
    const sealed = body.subarray(21 + idlen);
    const secret = ecdh.computeSecret(server);
    const info = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), server]);
    const ikm = new Uint8Array(hkdfSync('sha256', secret, auth, info, 32));
    const cek = new Uint8Array(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
    const nonce = new Uint8Array(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
    const d = createDecipheriv('aes-128-gcm', cek, nonce);
    d.setAuthTag(sealed.subarray(sealed.length - 16));
    const plain = Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]);
    expect(plain.at(-1)).toBe(2);
    return JSON.parse(plain.subarray(0, -1).toString('utf8'));
  };
  return { keys, open };
}

describe('VAPID', () => {
  it('makes the key pair once and keeps it to the owner', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chapp-vapid-'));
    const first = vapidKeys(dir);
    expect(fromB64url(first.publicKey)).toHaveLength(65);
    expect(fromB64url(first.privateKey)).toHaveLength(32);
    expect(vapidKeys(dir)).toEqual(first);
    expect(statSync(join(dir, 'vapid.json')).mode & 0o077).toBe(0);
  });

  it('signs a JWT for the push service’s origin that its public key verifies (RFC 8292)', () => {
    const keys = vapidKeys(mkdtempSync(join(tmpdir(), 'chapp-vapid-')));
    const now = Date.UTC(2026, 9, 28, 6, 0, 0);
    const header = vapidAuthorization('https://web.push.apple.com/QGuQyavXutnMH5hP', keys, 'mailto:lab@example.com', now);
    const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header)!;
    expect(k).toBe(keys.publicKey);
    const [h, p, sig] = jwt!.split('.');
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(JSON.parse(Buffer.from(p!, 'base64url').toString())).toEqual({ aud: 'https://web.push.apple.com', exp: now / 1000 + 12 * 3600, sub: 'mailto:lab@example.com' });
    const point = fromB64url(keys.publicKey);
    const pub = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64url(point.subarray(1, 33)), y: b64url(point.subarray(33)) }, format: 'jwk' });
    expect(verify('sha256', Buffer.from(`${h}.${p}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig!, 'base64url'))).toBe(true);
  });

  it('posts only to the browsers’ push services', () => {
    for (const ok of ['https://fcm.googleapis.com/fcm/send/abc', 'https://web.push.apple.com/QGuQ', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://wns2-par02p.notify.windows.com/w/?token=x'])
      expect(PUSH_SERVICES.test(ok), ok).toBe(true);
    for (const no of ['http://fcm.googleapis.com/x', 'https://127.0.0.1/x', 'https://evil.example/web.push.apple.com/', 'https://fcm.googleapis.com.evil.example/x'])
      expect(PUSH_SERVICES.test(no), no).toBe(false);
  });
});

// ─── The routes and the timers ───────────────────────────────────────────────────────────────────────────────────

const servers: Server[] = [];
afterAll(() => servers.forEach(s => s.close()));

type Sent = { endpoint: string; body: Uint8Array; headers: Record<string, string> };
async function start(dir: string, sent: Sent[]) {
  const server = createServer(
    createHandler({
      provider: createMockProvider(),
      providerName: 'mock',
      metaModelApi: false,
      push: { dir, allow: /^https:\/\/push\.example\//, log: () => {}, send: async (sub, body, headers) => (sent.push({ endpoint: sub.endpoint, body, headers }), 201) },
    }),
  );
  servers.push(server);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const post = (base: string, path: string, body: unknown) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }));
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('/api/push', () => {
  const message = { title: 'Incubation done · 30 min at 37 °C', body: 'Cool the plate to room temperature, then read at 562 nm.', url: '/run/6' };

  it('hands out the public key, never the private one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chapp-push-'));
    const base = await start(dir, []);
    const r = await fetch(`${base}/api/push/key`).then(x => x.json());
    expect(fromB64url(r.publicKey)).toHaveLength(65);
    expect(Object.keys(r)).toEqual(['publicKey']);
    expect(JSON.parse(readFileSync(join(dir, 'vapid.json'), 'utf8')).publicKey).toBe(r.publicKey);
  });

  it('pushes Timer-Done at the end time, encrypted for the browser and signed', async () => {
    const sent: Sent[] = [];
    const base = await start(mkdtempSync(join(tmpdir(), 'chapp-push-')), sent);
    const b = browser();
    const endsAt = Date.now() + 400;
    const r = await post(base, '/api/push/timer', { subscription: { endpoint: 'https://push.example/abc', keys: b.keys }, id: 'incubate', endsAt, ...message });
    expect(r).toEqual({ status: 201, body: { id: 'incubate', endsAt } });
    await wait(150);
    expect(sent).toHaveLength(0);
    await wait(500);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.headers).toMatchObject({ 'content-encoding': 'aes128gcm', ttl: '3600', urgency: 'high' });
    expect(sent[0]!.headers.authorization).toMatch(/^vapid t=.+, k=/);
    expect(b.open(sent[0]!.body)).toEqual({ ...message, tag: 'chapp-timer' });
  });

  it('a timer started again replaces the first; a stopped one is called off', async () => {
    const sent: Sent[] = [];
    const base = await start(mkdtempSync(join(tmpdir(), 'chapp-push-')), sent);
    const subscription = { endpoint: 'https://push.example/abc', keys: browser().keys };
    await post(base, '/api/push/timer', { subscription, id: 'incubate', endsAt: Date.now() + 300, ...message });
    await post(base, '/api/push/timer', { subscription, id: 'incubate', endsAt: Date.now() + 600, ...message });
    await post(base, '/api/push/timer', { subscription, id: 'shake', endsAt: Date.now() + 300, ...message });
    expect(await post(base, '/api/push/cancel', { endpoint: subscription.endpoint, id: 'shake' })).toEqual({ status: 200, body: { cancelled: true } });
    await wait(450);
    expect(sent).toHaveLength(0);
    await wait(400);
    expect(sent).toHaveLength(1);
  });

  it('keeps waiting timers across a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chapp-push-'));
    const before = createPushHandler({ dir, allow: /^https:\/\/push\.example\//, log: () => {}, send: async () => 201 });
    const server = createServer((req, res) => void before(req, res, new URL(req.url!, 'http://x').pathname));
    servers.push(server);
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const endsAt = Date.now() + 60_000;
    await post(base, '/api/push/timer', { subscription: { endpoint: 'https://push.example/abc', keys: browser().keys }, id: 'incubate', endsAt, ...message });
    await post(base, '/api/push/timer', { subscription: { endpoint: 'https://push.example/def', keys: browser().keys }, id: 'incubate', endsAt: Date.now() + 100, ...message });
    await wait(200);
    await before.saved();
    before.close();
    const after = createPushHandler({ dir, log: () => {}, send: async () => 201 });
    await after.ready();
    expect(after.pending()).toEqual([{ id: 'incubate', endsAt }]);
    after.close();
  });

  it('refuses what it should not send', async () => {
    const base = await start(mkdtempSync(join(tmpdir(), 'chapp-push-')), []);
    const keys = browser().keys;
    const timer = (over: object) => post(base, '/api/push/timer', { subscription: { endpoint: 'https://push.example/abc', keys }, id: 'incubate', endsAt: Date.now() + 1000, ...message, ...over });
    expect((await timer({ subscription: { endpoint: 'https://attacker.example/x', keys } })).status).toBe(400);
    expect((await timer({ endsAt: Date.now() - 60_000 })).status).toBe(400);
    expect((await timer({ endsAt: Date.now() + 72 * 3600_000 })).status).toBe(400);
    expect((await timer({ url: 'https://elsewhere.example/' })).status).toBe(400);
    expect((await timer({ subscription: { endpoint: 'https://push.example/abc', keys: { p256dh: 'x', auth: 'y' } } })).status).toBe(400);
    expect((await fetch(`${base}/api/push/timer`)).status).toBe(405);
    expect((await fetch(`${base}/api/push/other`)).status).toBe(404);
  });
});

describe('where the lock screen can be pinged (the phone’s side)', () => {
  const iphone = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1', platform: 'iPhone', maxTouchPoints: 5, serviceWorker: {} };
  const ipad = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15', platform: 'MacIntel', maxTouchPoints: 5, serviceWorker: {} };
  const mac = { ...ipad, maxTouchPoints: 0 };
  const chrome = { userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36', platform: 'Linux armv8l', maxTouchPoints: 5, serviceWorker: {} };
  const env = (nav: typeof iphone, over: Partial<Parameters<typeof pushSupport>[0]> = {}) => pushSupport({ nav, secure: true, standalone: false, pushApi: true, permission: 'default', ...over });

  it('an iPhone or iPad in Safari: only from the Home Screen', () => {
    expect(env(iphone, { pushApi: false, permission: null })).toBe('home-screen');
    expect(env(ipad, { pushApi: false, permission: null })).toBe('home-screen');
    expect(env(iphone, { standalone: true })).toBe('ask');
    expect(env({ ...iphone, standalone: true } as typeof iphone)).toBe('ask');
    expect(env(iphone, { standalone: true, pushApi: false, permission: null })).toBe('unsupported');
  });

  it('elsewhere, as the permission stands', () => {
    expect(env(chrome)).toBe('ask');
    expect(env(chrome, { permission: 'granted' })).toBe('ready');
    expect(env(chrome, { permission: 'denied' })).toBe('denied');
    expect(env(mac, { permission: 'granted' })).toBe('ready');
    expect(env(chrome, { secure: false })).toBe('unsupported');
  });
});
