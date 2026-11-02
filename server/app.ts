import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { z } from 'zod';
import type { AIProvider, FindProtocolLive, Health } from '../shared/ai.ts';
import { Protocol } from '../shared/protocol.ts';
import { UpstreamError, type ProviderName } from './ai/provider.ts';
import { ConverseRequestSchema, describeIssues, FindProtocolRequestSchema } from './ai/schema.ts';
import { createShareHandler } from './share.ts';
import { createImportHandler, findAndImport } from './imports.ts';
import { createKitHandler } from './kit.ts';
import { createPictureHandler } from './pictures.ts';
import { streamConverse, streamFindProtocol, wantsEvents } from './events.ts';
import { createPlateHandler } from './ai/plate.ts';
import { deleteProtocol, loadProtocol, protocolList } from './ai/protocols.ts';
import { createPushHandler, type PushOptions } from './push.ts';

/**
 * Every route the server answers, as one request handler: server/index.ts listens with it, and the tests call it on
 * an ephemeral port with whichever provider they need.
 *
 *   GET  /api/health          → Health
 *   GET  /api/protocols       → ProtocolSummary[]: every protocol in data/protocols/, the newest first (Library)
 *   GET  /api/protocols/:id   → a chapp.protocol/1 document from data/protocols/
 *   DELETE /api/protocols/:id → { deleted }: a protocol Chapp read from a manual goes, with its manual and pictures
 *                             (409 for a built-in one, which stays)
 *   GET  /api/protocols/:id/pictures/:step.svg → a step card's picture, drawn once and kept (server/pictures.ts)
 *   POST /api/voice           audio/wav (≤ 10 MB) → Transcript
 *   POST /api/converse        ConverseRequest (≤ 100 KB) → ConverseReply
 *   POST /api/find-protocol   { query } (≤ 100 KB) → FoundProtocol; with accept: text/event-stream, its progress
 *                             as it happens, then the FoundProtocol (server/events.ts)
 *   POST /api/share          SharedSetup (≤ 3 MB) → 201 { id }   (server/share.ts, stored in data/shares/)
 *   GET  /api/share/:id       → StoredShare
 *   POST /api/kit/* (≤ 8 MB of JSON; a video to follow ≤ 150 MB)   (server/kit.ts: kit photos and videos; 501 without)
 *   POST /api/read-plate      ReadPlateRequest (≤ 12 MB) → PlateReading   (server/ai/plate.ts)
 *   GET  /api/push/key, POST /api/push/timer, POST /api/push/cancel        (server/push.ts: time's up on the lock screen)
 *   POST /api/import-protocol application/pdf (≤ 20 MB) → ImportedProtocol, saved to data/protocols/   (server/imports.ts)
 *   GET  /api/protocols/:id/manual.pdf → the manual an imported protocol was read from
 *   anything else            the built app from dist/, index.html for client-side routes
 *
 * Errors are { error } with 400 (bad input), 404, 405, 413 (too large), 415 (not WAV/JSON), 502 (the model failed).
 */

export type AppOptions = {
  provider: AIProvider;
  providerName: ProviderName;
  metaModelApi: boolean;
  /** Overridable for tests. */
  dist?: string;
  protocols?: string;
  /** Where the manuals of imported protocols are kept (data/sources/). */
  manuals?: string;
  /** Where shared setups are kept (data/shares/). */
  shares?: string;
  /** Where step pictures are kept (data/pictures/). */
  pictures?: string;
  /** Where Muse Image's whole bottles are kept, by the crop they were drawn from (data/whole/). */
  wholes?: string;
  /** Web Push for timers (server/push.ts): its folder (data/push/) and, in tests, a sender that stays off the network. */
  push?: Partial<PushOptions>;
};

export const MAX_AUDIO = 10 * 1024 * 1024;
export const MAX_JSON = 100 * 1024;

const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json', '.glb': 'model/gltf-binary',
};

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
};

/**
 * The whole body, or a 413 once it passes `limit`. A body that is too big is still read to the end (and dropped), so
 * the client gets the 413 instead of a reset connection.
 */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((done, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
    });
    req.on('end', () => (size > limit ? fail(new HttpError(413, `Body too large (limit ${Math.round(limit / 1024)} KB)`)) : done(Buffer.concat(chunks))));
    req.on('error', fail);
  });
}

const mediaType = (req: IncomingMessage) => (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();

async function readJson<T>(req: IncomingMessage, schema: z.ZodType<T>, limit = MAX_JSON): Promise<T> {
  if (mediaType(req) !== 'application/json') throw new HttpError(415, 'Send JSON (content-type: application/json)');
  const raw = (await readBody(req, limit)).toString('utf8');
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'The body is not valid JSON');
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, `Invalid request: ${describeIssues(parsed.error)}`);
  return parsed.data;
}

const wavTypes = new Set(['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave']);

async function readWav(req: IncomingMessage): Promise<Uint8Array> {
  if (!wavTypes.has(mediaType(req))) throw new HttpError(415, 'Send the recording as audio/wav');
  const body = await readBody(req, MAX_AUDIO);
  // A RIFF/WAVE header with at least one sample after it; anything else is not what the transcriber takes.
  if (body.length < 46 || body.toString('ascii', 0, 4) !== 'RIFF' || body.toString('ascii', 8, 12) !== 'WAVE') {
    throw new HttpError(400, 'The body is not a WAV recording');
  }
  return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
}

export function createHandler(options: AppOptions) {
  const { provider } = options;
  const dist = options.dist ?? fileURLToPath(new URL('../dist/', import.meta.url));
  const protocols = options.protocols ?? fileURLToPath(new URL('../data/protocols/', import.meta.url));
  const health: Health = { ok: true, provider: options.providerName, metaModelApi: options.metaModelApi };
  const share = createShareHandler(options.shares ?? fileURLToPath(new URL('../data/shares/', import.meta.url)));
  const kit = createKitHandler(provider, options.wholes ?? fileURLToPath(new URL('../data/whole/', import.meta.url)));
  const manuals = options.manuals ?? fileURLToPath(new URL('../data/sources/', import.meta.url));
  const imports = createImportHandler({ provider, protocols, manuals });
  // A manual the search finds for a kit without a protocol here is read into one (server/imports.ts).
  const find = (query: string, live?: FindProtocolLive) => findAndImport(provider, query, live, { protocols, manuals });
  const plate = createPlateHandler(provider);
  const picturesDir = options.pictures ?? fileURLToPath(new URL('../data/pictures/', import.meta.url));
  const pictures = createPictureHandler({ provider, protocols, pictures: picturesDir });
  const push = createPushHandler({ dir: fileURLToPath(new URL('../data/push/', import.meta.url)), ...options.push });

  const post = (req: IncomingMessage) => {
    if (req.method !== 'POST') throw new HttpError(405, 'Use POST');
  };

  return async function handle(req: IncomingMessage, res: ServerResponse) {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    try {
      if (path === '/api/health') return json(res, 200, health);

      if (path === '/api/voice') {
        post(req);
        return json(res, 200, await provider.transcribe(await readWav(req)));
      }
      if (path === '/api/converse') {
        post(req);
        const request = await readJson(req, ConverseRequestSchema, 1024 * 1024);
        if (wantsEvents(req)) return await streamConverse(res, live => provider.converse(request, live));
        return json(res, 200, await provider.converse(request));
      }
      if (path === '/api/find-protocol') {
        post(req);
        const { query } = await readJson(req, FindProtocolRequestSchema);
        if (wantsEvents(req)) return await streamFindProtocol(res, live => find(query, live));
        return json(res, 200, await find(query));
      }

      if (path === '/api/share' || path.startsWith('/api/share/')) return await share(req, res, path);
      if (path.startsWith('/api/kit/')) return await kit(req, res, path);
      if (path === '/api/read-plate') return await plate(req, res);
      if (path.startsWith('/api/push/')) return await push(req, res, path);
      if (await imports(req, res, path)) return;

      if (path === '/api/protocols') return json(res, 200, protocolList(protocols));
      if (req.method === 'GET' && (await pictures(res, path))) return;
      const id = /^\/api\/protocols\/([a-z0-9-]+)$/.exec(path)?.[1];
      if (id && req.method === 'DELETE') {
        const p = loadProtocol(id, protocols);
        if (!p) return json(res, 404, { error: 'No such protocol' });
        if (!p.imported) return json(res, 409, { error: 'This protocol is built into Chapp and stays on this computer.' });
        deleteProtocol(id, { dir: protocols, manuals, pictures: picturesDir });
        return json(res, 200, { deleted: id });
      }
      if (id) {
        const raw = await readFile(resolve(protocols, `${id}.json`), 'utf8').catch(() => null);
        return raw ? json(res, 200, Protocol.parse(JSON.parse(raw))) : json(res, 404, { error: 'No such protocol' });
      }
      if (path.startsWith('/api/')) return json(res, 404, { error: 'Not found' });

      // The built app; unknown paths without an extension get index.html so client-side routes load.
      let file = resolve(dist, `.${path === '/' ? '/index.html' : path}`);
      if (!file.startsWith(dist.endsWith(sep) ? dist : dist + sep)) return json(res, 400, { error: 'Bad path' });
      const body = await readFile(file).catch(async () => {
        if (extname(path)) return null;
        file = resolve(dist, 'index.html');
        return readFile(file);
      });
      if (!body) return json(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(body);
    } catch (error) {
      if (error instanceof HttpError) {
        if (error.status === 405) res.setHeader('allow', 'POST');
        return json(res, error.status, { error: error.message });
      }
      if (error instanceof UpstreamError) {
        console.error(`[api] ${path}: ${error.message}`);
        return json(res, 502, { error: error.message });
      }
      json(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  };
}
