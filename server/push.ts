import type { IncomingMessage, ServerResponse } from 'node:http';
import { createCipheriv, createECDH, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, sign } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * Time's up on the lock screen (Timer-Done): Web Push with VAPID, sent by this server when an incubation timer ends,
 * so it arrives with the page closed or the phone locked.
 *
 *   GET  /api/push/key      → { publicKey }  the VAPID public key the phone subscribes with
 *   POST /api/push/timer    { subscription, id, endsAt, title, body, url } → 201 { id, endsAt }  (re-sent: replaced)
 *   POST /api/push/cancel   { endpoint, id } → 200 { cancelled }
 *
 * The VAPID key pair is made once, on first use, into data/push/vapid.json (git-ignored, never printed); timers wait
 * in data/push/timers.json, so a restart re-arms the ones still to come. Messages are encrypted for the phone
 * (RFC 8291, aes128gcm) and signed (RFC 8292). Only the known push services are ever posted to. Logs say what
 * happened and the push service's status, never an endpoint or a key.
 */

export type PushSubscriptionJson = { endpoint: string; keys: { p256dh: string; auth: string } };
export type PushMessage = { title: string; body: string; url: string; tag: string };
type Timer = { id: string; endsAt: number; subscription: PushSubscriptionJson; message: PushMessage };
export type VapidKeys = { publicKey: string; privateKey: string };

/** Delivers one encrypted message; returns the push service's HTTP status. Replaced in tests. */
export type PushSender = (subscription: PushSubscriptionJson, body: Uint8Array, headers: Record<string, string>) => Promise<number>;

export type PushOptions = {
  /** Where the keys and the waiting timers live: data/push/ in the app, a temporary folder in tests. */
  dir: string;
  send?: PushSender;
  /** The VAPID contact (RFC 8292 "sub"): a mailto: or https: URL. */
  subject?: string;
  /** Push services this server may post to; tests add their own. */
  allow?: RegExp;
  now?: () => number;
  log?: (line: string) => void;
};

/** Chrome (FCM), Firefox (Mozilla), Edge (WNS) and Safari (Apple): the endpoints a browser hands out. */
export const PUSH_SERVICES = /^https:\/\/(?:fcm\.googleapis\.com|android\.googleapis\.com|[a-z0-9-]+\.push\.services\.mozilla\.com|[a-z0-9.-]+\.notify\.windows\.com|web\.push\.apple\.com|[a-z0-9.-]+\.push\.apple\.com)\//;

/** The longest a timer may run (the protocol's 2 h alternative, with room to spare). */
const MAX_AHEAD = 48 * 3600 * 1000;
const MAX_TIMERS = 500;

export const b64url = (b: Uint8Array) => Buffer.from(b).toString('base64url');
export const fromB64url = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'));
const concat = (...parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts));
const utf8 = (s: string) => new Uint8Array(Buffer.from(s, 'utf8'));

// ─── Keys ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A new P-256 key pair: the public key as the 65-byte uncompressed point, the private one as its 32 bytes. */
export function newVapidKeys(): VapidKeys {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  const point = concat(new Uint8Array([4]), fromB64url(jwk.x!), fromB64url(jwk.y!));
  return { publicKey: b64url(point), privateKey: jwk.d! };
}

/** The server's VAPID keys from `dir`, made and saved (owner-only) the first time. */
export function vapidKeys(dir: string): VapidKeys {
  const file = join(dir, 'vapid.json');
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as VapidKeys;
    if (fromB64url(saved.publicKey).length === 65 && fromB64url(saved.privateKey).length === 32) return saved;
  } catch {
    // Not made yet.
  }
  const keys = newVapidKeys();
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(keys), { mode: 0o600 });
  return keys;
}

/** The Authorization header for one push service (RFC 8292): a JWT for its origin, valid 12 hours, and our public key. */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, now = Date.now()): string {
  const point = fromB64url(keys.publicKey);
  const key = createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', x: b64url(point.subarray(1, 33)), y: b64url(point.subarray(33, 65)), d: keys.privateKey },
    format: 'jwk',
  });
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })}`;
  const signature = sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${b64url(signature)}, k=${keys.publicKey}`;
}

// ─── Encryption (RFC 8291) ───────────────────────────────────────────────────────────────────────────────────────

const hkdf = (ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number) => new Uint8Array(hkdfSync('sha256', ikm, salt, info, length));

/**
 * The message encrypted for one browser: aes128gcm with a key agreed from a fresh key pair and the subscription's
 * p256dh and auth (RFC 8291 §3–4), as one record. `fixed` is for the RFC's test vector only.
 */
export function encryptMessage(plaintext: Uint8Array, subscription: PushSubscriptionJson, fixed?: { privateKey: Uint8Array; salt: Uint8Array }): Uint8Array {
  const ecdh = createECDH('prime256v1');
  if (fixed) ecdh.setPrivateKey(fixed.privateKey);
  else ecdh.generateKeys();
  const serverPublic = new Uint8Array(ecdh.getPublicKey());
  const clientPublic = fromB64url(subscription.keys.p256dh);
  const auth = fromB64url(subscription.keys.auth);
  const secret = new Uint8Array(ecdh.computeSecret(clientPublic));
  const ikm = hkdf(secret, auth, concat(utf8('WebPush: info\0'), clientPublic, serverPublic), 32);
  const salt = fixed?.salt ?? new Uint8Array(randomBytes(16));
  const cek = hkdf(ikm, salt, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(ikm, salt, utf8('Content-Encoding: nonce\0'), 12);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const sealed = concat(cipher.update(concat(plaintext, new Uint8Array([2]))), cipher.final(), cipher.getAuthTag());
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = serverPublic.length;
  return concat(header, serverPublic, sealed);
}

const fetchSender: PushSender = async (subscription, body, headers) => {
  const res = await fetch(subscription.endpoint, { method: 'POST', headers, body: Buffer.from(body), signal: AbortSignal.timeout(15_000) });
  await res.arrayBuffer().catch(() => null);
  return res.status;
};

// ─── Requests ────────────────────────────────────────────────────────────────────────────────────────────────────

const Subscription = z.object({
  endpoint: z.string().url().max(1000),
  keys: z.object({ p256dh: z.string().regex(/^[A-Za-z0-9_-]{80,100}={0,2}$/), auth: z.string().regex(/^[A-Za-z0-9_-]{16,32}={0,2}$/) }),
});
const TimerRequest = z.object({
  subscription: Subscription,
  id: z.string().regex(/^[\w:.-]{1,80}$/),
  endsAt: z.number().int(),
  title: z.string().min(1).max(120),
  body: z.string().max(300),
  url: z.string().regex(/^\/[^\s]*$/).max(200),
});
const CancelRequest = z.object({ endpoint: z.string().url().max(1000), id: z.string().regex(/^[\w:.-]{1,80}$/) });

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
};

async function readJson(req: IncomingMessage): Promise<{ ok: true; body: unknown } | { ok: false; status: number; error: string }> {
  const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/json') return { ok: false, status: 415, error: 'Send JSON (content-type: application/json)' };
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size <= 16 * 1024) chunks.push(chunk);
  }
  if (size > 16 * 1024) return { ok: false, status: 413, error: 'Body too large (limit 16 KB)' };
  try {
    return { ok: true, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
  } catch {
    return { ok: false, status: 400, error: 'The body is not valid JSON' };
  }
}

const describe = (error: z.ZodError) => error.issues.slice(0, 4).map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');

// ─── The handler and its timers ──────────────────────────────────────────────────────────────────────────────────

export function createPushHandler(options: PushOptions) {
  const { dir, subject = process.env.PUSH_SUBJECT || 'mailto:chapp@example.com', allow = PUSH_SERVICES, now = Date.now, log = (line: string) => console.log(line) } = options;
  const send = options.send ?? fetchSender;
  const file = join(dir, 'timers.json');
  const timers = new Map<string, Timer>();
  const handles = new Map<string, ReturnType<typeof setTimeout>>();
  let keys: VapidKeys | null = null;
  const key = (endpoint: string, id: string) => `${id} ${endpoint}`;
  const getKeys = () => (keys ??= vapidKeys(dir));

  let saving = Promise.resolve();
  const save = () => {
    const list = [...timers.values()];
    saving = saving
      .then(() => mkdir(dir, { recursive: true }))
      .then(() => writeFile(file, JSON.stringify(list), { mode: 0o600 }))
      .catch(error => log(`[push] could not save the timers: ${error instanceof Error ? error.message : error}`));
    return saving;
  };

  async function deliver(t: Timer): Promise<number> {
    const body = encryptMessage(utf8(JSON.stringify(t.message)), t.subscription);
    const headers = {
      authorization: vapidAuthorization(t.subscription.endpoint, getKeys(), subject, now()),
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: '3600',
      urgency: 'high',
    };
    const started = now();
    try {
      const status = await send(t.subscription, body, headers);
      log(`[push] ${t.id}: ${status} in ${((now() - started) / 1000).toFixed(1)} s`);
      return status;
    } catch (error) {
      log(`[push] ${t.id}: could not reach the push service (${error instanceof Error ? error.name : 'error'})`);
      return 0;
    }
  }

  function arm(t: Timer) {
    const k = key(t.subscription.endpoint, t.id);
    clearTimeout(handles.get(k));
    const wait = t.endsAt - now();
    const handle = setTimeout(
      () => {
        if (t.endsAt - now() > 1000) return arm(t); // A wait longer than setTimeout allows: go round again.
        handles.delete(k);
        if (timers.get(k) !== t) return;
        timers.delete(k);
        void save();
        void deliver(t);
      },
      Math.max(0, Math.min(wait, 2 ** 31 - 1)),
    );
    handle.unref?.();
    handles.set(k, handle);
  }

  // Timers saved before a restart: the ones still to come are armed again; ones whose time passed while the server was
  // down are dropped (a late "time's up" would only confuse).
  const loaded = readFile(file, 'utf8').then(
    raw => {
      for (const t of JSON.parse(raw) as Timer[]) {
        if (!t?.subscription?.endpoint || typeof t.endsAt !== 'number') continue;
        if (t.endsAt <= now()) continue;
        timers.set(key(t.subscription.endpoint, t.id), t);
        arm(t);
      }
    },
    () => {},
  );

  async function schedule(req: IncomingMessage, res: ServerResponse) {
    const read = await readJson(req);
    if (!read.ok) return json(res, read.status, { error: read.error });
    const parsed = TimerRequest.safeParse(read.body);
    if (!parsed.success) return json(res, 400, { error: `Invalid request: ${describe(parsed.error)}` });
    const { subscription, id, endsAt, title, body, url } = parsed.data;
    if (!allow.test(subscription.endpoint)) return json(res, 400, { error: 'Not a push service this server sends to' });
    if (endsAt < now() - 5000 || endsAt > now() + MAX_AHEAD) return json(res, 400, { error: 'endsAt is not a time in the next 48 hours' });
    await loaded;
    const k = key(subscription.endpoint, id);
    if (!timers.has(k) && timers.size >= MAX_TIMERS) return json(res, 503, { error: 'Too many timers waiting' });
    const t: Timer = { id, endsAt, subscription, message: { title, body, url, tag: 'chapp-timer' } };
    timers.set(k, t);
    arm(t);
    await save();
    return json(res, 201, { id, endsAt });
  }

  async function cancel(req: IncomingMessage, res: ServerResponse) {
    const read = await readJson(req);
    if (!read.ok) return json(res, read.status, { error: read.error });
    const parsed = CancelRequest.safeParse(read.body);
    if (!parsed.success) return json(res, 400, { error: `Invalid request: ${describe(parsed.error)}` });
    await loaded;
    const k = key(parsed.data.endpoint, parsed.data.id);
    const cancelled = timers.delete(k);
    clearTimeout(handles.get(k));
    handles.delete(k);
    if (cancelled) await save();
    return json(res, 200, { cancelled });
  }

  const handler = async function push(req: IncomingMessage, res: ServerResponse, path: string) {
    const route = path.slice('/api/push/'.length);
    const method = route === 'key' ? 'GET' : 'POST';
    if (!['key', 'timer', 'cancel'].includes(route)) return json(res, 404, { error: 'Not found' });
    if (req.method !== method && !(method === 'GET' && req.method === 'HEAD')) {
      res.setHeader('allow', method);
      return json(res, 405, { error: `Use ${method}` });
    }
    if (route === 'key') return json(res, 200, { publicKey: getKeys().publicKey });
    return route === 'timer' ? schedule(req, res) : cancel(req, res);
  };
  /** For tests: what is waiting, and a way to stop every timer. */
  return Object.assign(handler, {
    pending: () => [...timers.values()].map(t => ({ id: t.id, endsAt: t.endsAt })),
    ready: () => loaded,
    saved: () => saving,
    close: () => handles.forEach(h => clearTimeout(h)),
  });
}
