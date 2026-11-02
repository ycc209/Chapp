import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import type { AIProvider, FindProtocolLive, FoundProtocol, ImportedProtocol } from '../shared/ai.ts';
import type { Protocol } from '../shared/protocol.ts';
import { formatEvent } from '../shared/sse.ts';
import { isPdf, MAX_PDF } from './ai/import.ts';
import { localProtocolId, manualFile, manualSources, protocolBySha, saveImported } from './ai/protocols.ts';
import { UpstreamError } from './ai/provider.ts';

/**
 * Kit manuals Chapp reads into protocols (server/ai/import.ts), and keeps on this computer:
 *
 *   POST /api/import-protocol            body: application/pdf (≤ 20 MB) → ImportedProtocol, saved as data/protocols/<id>.json;
 *                                        with accept: text/event-stream, `progress` { line } and `intro` ProtocolIntro
 *                                        as the reading goes, then `imported` ImportedProtocol or `error` ApiError
 *   GET  /api/protocols/:id/manual.pdf   → the PDF it was read from (data/sources/<id>/manual.pdf)
 *
 * and findAndImport(), which server/app.ts's /api/find-protocol calls: when the web search finds the vendor's manual
 * for a kit Chapp has no protocol for, it downloads the PDF, reads it and saves it, so the answer carries a protocolId.
 * Errors are { error } with 400 (not a PDF), 404, 405, 413 (too large), 415 (not application/pdf), 501 (the provider
 * cannot read manuals), 502 (the model failed). Only timings are logged, never a manual's words.
 */

export type ImportOptions = {
  provider: AIProvider;
  /** data/protocols/ and data/sources/ in the app; temporary folders in tests. */
  protocols?: string;
  manuals?: string;
  log?: (line: string) => void;
};

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
};

/** The whole body, or null once it passes the limit (still read to the end, so the client gets the 413). */
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

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/**
 * A manual → the protocol the app opens. The same file read before is that protocol again (no model call). A protocol
 * the provider made from the manual (`imported` set) is saved; one it already had (the mock's BCA document) is not.
 */
export async function readManual(
  provider: AIProvider,
  pdf: Uint8Array,
  source: { url?: string; filename?: string },
  opts: Pick<ImportOptions, 'protocols' | 'manuals'> = {},
  live?: Pick<FindProtocolLive, 'onProgress' | 'onIntro' | 'signal'>,
): Promise<ImportedProtocol> {
  live?.signal?.throwIfAborted();
  const known = protocolBySha(sha256(pdf), opts.protocols);
  if (known) return { protocol: known, problems: known.imported?.problems ?? [], sources: manualSources(known) };
  if (!provider.importProtocol) throw new UpstreamError('This server cannot read manuals');
  const imported = await provider.importProtocol(pdf, source, live);
  live?.signal?.throwIfAborted();
  if (!imported.protocol.imported) return imported;
  const protocol = saveImported(imported.protocol, pdf, { dir: opts.protocols, manuals: opts.manuals });
  return { ...imported, protocol };
}

/** The /api/import-protocol and /api/protocols/:id/manual.pdf routes. Returns false for any other path. */
export function createImportHandler(options: ImportOptions) {
  const { provider, log = (line: string) => console.log(line) } = options;
  return async function imports(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    if (path === '/api/import-protocol') {
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST');
        json(res, 405, { error: 'Use POST' });
        return true;
      }
      const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
      if (type !== 'application/pdf') return json(res, 415, { error: 'Send the manual as application/pdf' }), true;
      if (!provider.importProtocol) return json(res, 501, { error: 'This server cannot read manuals' }), true;
      const body = await readBody(req, MAX_PDF);
      if (!body) return json(res, 413, { error: `That PDF is too large (limit ${MAX_PDF / 1024 / 1024} MB)` }), true;
      const pdf = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
      if (!isPdf(pdf)) return json(res, 400, { error: 'That file is not a PDF' }), true;
      const filename = new URL(req.url ?? '/', 'http://x').searchParams.get('name') ?? undefined;
      const started = Date.now();
      const took = () => ((Date.now() - started) / 1000).toFixed(1);
      // With accept: text/event-stream, each stage as it happens (`progress` { line }), then `imported` or `error`.
      const stream = (req.headers.accept ?? '').includes('text/event-stream');
      const send = (event: string, data: unknown) => {
        if (stream && !res.writableEnded && !res.destroyed) res.write(formatEvent(event, data));
      };
      if (stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' });
        res.flushHeaders();
        send('progress', { line: READING_LINE });
      }
      try {
        const imported = await readManual(provider, pdf, filename ? { filename } : {}, options, {
          onProgress: line => line !== READING_LINE && send('progress', { line }),
          onIntro: intro => send('intro', intro),
        });
        log(`[import] ${took()} s, ${imported.problems.length} problem(s)`);
        if (stream) send('imported', imported);
        else json(res, 200, imported);
      } catch (error) {
        if (!(error instanceof UpstreamError)) {
          if (!stream) throw error;
          send('error', { error: 'Something went wrong while reading the manual' });
        } else {
          log(`[import] failed after ${took()} s`);
          if (stream) send('error', { error: error.message });
          else json(res, 502, { error: error.message });
        }
      }
      if (stream) res.end();
      return true;
    }
    const id = /^\/api\/protocols\/([a-z0-9-]+)\/manual\.pdf$/.exec(path)?.[1];
    if (id === undefined) return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('allow', 'GET');
      json(res, 405, { error: 'Use GET' });
      return true;
    }
    const file = manualFile(id, options.manuals);
    const pdf = file ? await readFile(file).catch(() => null) : null;
    if (!pdf) return json(res, 404, { error: 'No manual for this protocol' }), true;
    res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': pdf.length, 'content-disposition': `inline; filename="${id}.pdf"` });
    res.end(req.method === 'HEAD' ? undefined : pdf);
    return true;
  };
}

// ─── Find, then read ─────────────────────────────────────────────────────────────────────────────────────────────

/** Host names that are this machine or its network, which a link from the web must never make the server fetch. */
function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.ts.net')) return true;
  if (isIP(h) === 4) {
    const [a, b] = h.split('.').map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (isIP(h) === 6) return h === '::1' || h === '::' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith('::ffff:');
  return !h.includes('.');
}

export type DownloadOptions = { fetch?: typeof fetch; maxBytes?: number; timeoutMs?: number; signal?: AbortSignal };

/**
 * A manual from the web: http(s) only, never this machine or its network (redirects included), a PDF by its type and
 * its first bytes, at most `maxBytes` (20 MB) within `timeoutMs` (30 s). Throws UpstreamError saying which it was not.
 */
export async function downloadPdf(url: string, options: DownloadOptions = {}): Promise<Uint8Array> {
  const { maxBytes = MAX_PDF, timeoutMs = 30_000 } = options;
  const fetchFn = options.fetch ?? globalThis.fetch;
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  signal.throwIfAborted();
  let at = url;
  try {
    for (let hop = 0; hop <= 3; hop++) {
      const u = URL.parse(at);
      if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:')) throw new UpstreamError('The manual link is not http(s)');
      if (u.username || u.password || isPrivateHost(u.hostname)) throw new UpstreamError('The manual link points somewhere Chapp does not fetch');
      const res = await fetchFn(u.href, { redirect: 'manual', signal, headers: { accept: 'application/pdf' } });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        at = new URL(res.headers.get('location')!, u).href;
        await res.body?.cancel();
        continue;
      }
      if (!res.ok) throw new UpstreamError(`The manual could not be downloaded (${res.status})`);
      const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      if (!['application/pdf', 'application/x-pdf', 'application/octet-stream', 'binary/octet-stream'].includes(type)) throw new UpstreamError('The manual link is not a PDF');
      if (Number(res.headers.get('content-length') ?? 0) > maxBytes) throw new UpstreamError('The manual is too large');
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = res.body?.getReader();
      for (let part = await reader?.read(); part && !part.done; part = await reader!.read()) {
        size += part.value.length;
        if (size > maxBytes) {
          await reader!.cancel();
          throw new UpstreamError('The manual is too large');
        }
        chunks.push(part.value);
      }
      const pdf = new Uint8Array(Buffer.concat(chunks));
      if (!isPdf(pdf)) throw new UpstreamError('The manual link is not a PDF');
      return pdf;
    }
    throw new UpstreamError('The manual link redirects too often');
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof UpstreamError) throw error;
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new UpstreamError(timedOut ? 'Downloading the manual took too long' : 'The manual could not be downloaded');
  }
}

/** A link's file name, decoded and in lower case: "MAN0011430_Pierce_BCA_Protein_Asy_UG.pdf" → "man0011430_pierce_bca_protein_asy_ug.pdf". */
function fileName(url: string): string {
  const path = URL.parse(url)?.pathname ?? '';
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // Not percent-encoded as it should be: the raw path.
  }
  return (decoded.split('/').pop() ?? '').toLowerCase();
}

/**
 * The other links among `sources` to the same PDF file as `url`, by its file name: a vendor often serves one manual
 * from several hosts, and an old one may refuse a program (Thermo's tools.thermofisher.com answers 403) where the
 * current one serves it (documents.thermofisher.com, under its own spelling of the name).
 */
export function sameFileLinks(url: string, sources: { url: string }[]): string[] {
  const name = fileName(url);
  if (!/\.pdf$/.test(name)) return [];
  const seen = new Set([url.toLowerCase()]);
  const out: string[] = [];
  for (const { url: other } of sources) {
    if (!/^https?:\/\//.test(other) || fileName(other) !== name || seen.has(other.toLowerCase())) continue;
    seen.add(other.toLowerCase());
    out.push(other);
  }
  return out;
}

/** downloadPdf on each link in turn, the first that gives the PDF; the first link's error when none does. */
export async function downloadFirst(urls: string[], options: DownloadOptions = {}, tried: (url: string) => void = () => {}): Promise<{ pdf: Uint8Array; url: string }> {
  let first: unknown;
  for (const url of urls) {
    tried(url);
    try {
      return { pdf: await downloadPdf(url, options), url };
    } catch (error) {
      options.signal?.throwIfAborted();
      first ??= error;
    }
  }
  throw first ?? new UpstreamError('The manual could not be downloaded');
}

/** The progress line said while Chapp reads a manual it found (Overview.dc.html's "Turning it into steps" follows). */
export const READING_LINE = 'Reading the manual';

export type FindAndImportOptions = Pick<ImportOptions, 'protocols' | 'manuals' | 'log'> & { download?: DownloadOptions };

/** A manual being read: `tried` the links its download went through, `downloaded` once one of them gave the PDF. */
type Reading = { url: string; started: number; stop: AbortController; protocol: Promise<Protocol>; tried: string[]; downloaded: () => boolean };

/**
 * provider.findProtocol, then, when it found the vendor's manual for a kit with no protocol on this machine, that manual
 * read into one: downloaded, imported and saved, so the answer's protocolId opens it. The reading starts as soon as the
 * search names the manual (live.onDocument), while it still writes what it read of it; that draft intro goes to
 * `live.onIntro` until the manual's own is read, never after it. Its progress goes on as one more line ("Reading the
 * manual"), to `live.onProgress` while streaming and in `progress`. When the manual cannot be fetched or read, the
 * search's own answer stands, without a protocolId.
 */
export async function findAndImport(provider: AIProvider, query: string, live?: FindProtocolLive, opts: FindAndImportOptions = {}): Promise<FoundProtocol> {
  const { log = (line: string) => console.log(line) } = opts;
  const lines: string[] = [];
  // `read`: the manual's own intro is on screen, and the search's draft no longer goes over it.
  const state: { reading?: Reading; read: boolean } = { read: false };
  // `others`: the same file at other links the search came across, tried in turn when `url` gives no PDF.
  const read = (url: string, others: string[] = []): Reading => {
    const stop = new AbortController();
    live?.onProgress?.(READING_LINE);
    const started = Date.now();
    const tried: string[] = [];
    let downloaded = false;
    const protocol = (async () => {
      const { pdf, url: from } = await downloadFirst([url, ...others], { ...opts.download, signal: stop.signal }, link => tried.push(link));
      downloaded = true;
      if (from !== url) log(`[find-protocol] ${url} gave no PDF; read the same file from ${from}`);
      const said = (line: string) => {
        if (line === READING_LINE || stop.signal.aborted) return;
        lines.push(line);
        live?.onProgress?.(line);
      };
      const { protocol } = await readManual(provider, pdf, { url: from }, opts, {
        onProgress: said,
        onIntro: intro => {
          if (stop.signal.aborted) return;
          state.read = true;
          live?.onIntro?.(intro);
        },
        signal: stop.signal,
      });
      log(`[find-protocol] read the manual in ${((Date.now() - started) / 1000).toFixed(1)} s`);
      return protocol;
    })();
    // Awaited once the search is done; one stopped meanwhile is not.
    protocol.catch(() => {});
    return { url, started, stop, protocol, tried, downloaded: () => downloaded };
  };
  const named = (early: FoundProtocol) => {
    const url = early.document?.url;
    if (state.reading || !url || !early.found || !provider.importProtocol || live?.signal?.aborted || localProtocolId(early, opts.protocols)) return;
    state.reading = read(url, sameFileLinks(url, early.sources));
  };
  const { intro: drafted, ...found } = await provider.findProtocol(query, { ...live, onDocument: named });

  const url = found.document?.url;
  const unread = !found.found || found.protocolId || !url || !provider.importProtocol || live?.signal?.aborted;
  // Found by another name since the search ran (an earlier import of the same manual).
  const local = unread ? undefined : localProtocolId(found, opts.protocols);
  // The search settled on another document than the one it named first: that one is read instead.
  if (state.reading && (unread || local || state.reading.url !== url)) {
    state.reading.stop.abort();
    state.reading = undefined;
  }
  if (unread) return found;
  if (local) return { ...found, protocolId: local };

  let reading = state.reading ?? read(url, sameFileLinks(url, found.sources));
  if (drafted && !state.read) live?.onIntro?.(drafted);
  for (;;) {
    try {
      const protocol = await reading.protocol;
      return { ...found, progress: [...found.progress, READING_LINE, ...lines], protocolId: protocol.id };
    } catch (error) {
      if (!(error instanceof UpstreamError)) throw error;
      // An early read knew only the links found by then: the whole answer may hold the same file at one more.
      const more = reading.downloaded() || live?.signal?.aborted ? [] : sameFileLinks(url, found.sources).filter(link => !reading.tried.includes(link));
      if (more.length) {
        reading = read(more[0]!, more.slice(1));
        continue;
      }
      log(`[find-protocol] could not read the manual after ${((Date.now() - reading.started) / 1000).toFixed(1)} s: ${error.message}`);
      return found;
    }
  }
}
