import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_SHARE_BYTES, SHARE_ID, SharedSetup, StoredShare } from '../shared/share.ts';

/**
 * Setups shared by QR code (shared/share.ts), kept as files on this computer only:
 *
 *   POST /api/share        SharedSetup (JSON, ≤ 3 MB) → 201 { id }
 *   GET  /api/share/:id    → StoredShare (the setup, its id, sharedAt)
 *
 * Errors are { error } with 400 (not a setup), 404, 405, 413 (too large), 415 (not JSON). A share is written once and
 * never changed: trimming it on the phone makes a new one.
 */

// Letters and digits that cannot be misread (no l, o, 0, 1). 32 of them, so a random byte maps on evenly.
const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

export function newShareId(): string {
  return Array.from(randomBytes(10), b => ALPHABET[b % 32]).join('');
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
};

/** The whole body, or null once it passes the limit; a body that is too big is still read to the end (and dropped), so
 * the client gets the 413 instead of a reset connection. */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((done, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
    });
    req.on('end', () => done(size > limit ? null : Buffer.concat(chunks)));
    req.on('error', fail);
  });
}

/** One line per problem, for the 400's message. */
const describe = (issues: { path: PropertyKey[]; message: string }[]) =>
  issues.slice(0, 5).map(i => `${i.path.length ? i.path.join('.') + ': ' : ''}${i.message}`).join('; ');

/**
 * The /api/share routes, storing into `dir` (data/shares/ in the app; a temporary folder in tests). Returns the
 * request handler server/app.ts calls for every path under /api/share.
 */
export function createShareHandler(dir: string) {
  async function create(req: IncomingMessage, res: ServerResponse) {
    const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (type !== 'application/json') return json(res, 415, { error: 'Send JSON (content-type: application/json)' });
    const body = await readBody(req, MAX_SHARE_BYTES);
    if (!body) return json(res, 413, { error: `Too large to share (limit ${MAX_SHARE_BYTES / 1024 / 1024} MB)` });
    let raw: unknown;
    try {
      raw = JSON.parse(body.toString('utf8'));
    } catch {
      return json(res, 400, { error: 'The body is not valid JSON' });
    }
    const parsed = SharedSetup.safeParse(raw);
    if (!parsed.success) return json(res, 400, { error: `Not a shared setup: ${describe(parsed.error.issues)}` });

    await mkdir(dir, { recursive: true });
    const stored: StoredShare = { ...parsed.data, id: '', sharedAt: new Date().toISOString() };
    // 'wx' never overwrites; on the rare clash, draw another id.
    for (let attempt = 0; ; attempt++) {
      stored.id = newShareId();
      try {
        await writeFile(join(dir, `${stored.id}.json`), JSON.stringify(stored), { flag: 'wx' });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 4) throw error;
      }
    }
    return json(res, 201, { id: stored.id });
  }

  async function read(res: ServerResponse, id: string) {
    // The id pattern is also what keeps the path inside `dir`.
    if (!SHARE_ID.test(id)) return json(res, 404, { error: 'No such share' });
    const raw = await readFile(join(dir, `${id}.json`), 'utf8').catch(() => null);
    if (raw === null) return json(res, 404, { error: 'No such share' });
    const parsed = StoredShare.safeParse(JSON.parse(raw));
    return parsed.success ? json(res, 200, parsed.data) : json(res, 500, { error: 'This share is damaged' });
  }

  return async function share(req: IncomingMessage, res: ServerResponse, path: string) {
    if (path === '/api/share') {
      if (req.method === 'POST') return create(req, res);
      res.setHeader('allow', 'POST');
      return json(res, 405, { error: 'Use POST' });
    }
    const id = /^\/api\/share\/([^/]+)$/.exec(path)?.[1];
    if (id === undefined) return json(res, 404, { error: 'Not found' });
    if (req.method === 'GET' || req.method === 'HEAD') return read(res, id);
    res.setHeader('allow', 'GET');
    return json(res, 405, { error: 'Use GET' });
  };
}
