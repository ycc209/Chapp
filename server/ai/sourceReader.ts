import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';

export type ReadDocument = {
  url: string;
  title: string;
  format: 'html' | 'pdf' | 'text';
  pages: { page?: number; text: string }[];
  fetchedAt: string;
  truncated?: boolean;
};
type Address = { address: string; family: number };
export type SourceResponse = {
  status: number;
  headers: Headers;
  body: AsyncIterable<Uint8Array>;
  cancel?: () => void;
};
export type SourceReaderOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  maxPages?: number;
  maxChars?: number;
  /** Trusted test adapters only. Production connections use the validated, pinned DNS answers. */
  lookup?: (hostname: string) => Promise<Address[]>;
  transport?: (url: URL, options: { addresses: Address[]; signal: AbortSignal }) => Promise<SourceResponse>;
};

const blocked = new BlockList();
for (const [ip, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(ip, prefix, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [ip, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) blocked.addSubnet(ip, prefix, 'ipv6');

const publicAddress = (address: string) => {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  // Excludes loopback, local/link-local, multicast, mapped IPv4, NAT64 and transition addresses.
  return family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
};

function sourceUrl(raw: string): URL {
  const url = URL.parse(raw);
  if (!url || !['http:', 'https:'].includes(url.protocol)) throw new Error('Source URL must use HTTP or HTTPS.');
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (url.username || url.password || !hostname || (url.port && !['80', '443'].includes(url.port))
    || /(^|\.)(localhost|local|internal|lan|home|ts\.net)$/.test(hostname)
    || (!isIP(hostname) && !hostname.includes('.'))) throw new Error('Source URL is not an allowed public address.');
  if (isIP(hostname) && !publicAddress(hostname)) throw new Error('Source URL is not an allowed public address.');
  url.hash = '';
  return url;
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

async function publicAddresses(url: URL, lookup: NonNullable<SourceReaderOptions['lookup']>, signal: AbortSignal): Promise<Address[]> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const family = isIP(host);
  const addresses = family ? [{ address: host, family }] : await abortable(lookup(host), signal);
  if (!addresses.length || addresses.some(a => isIP(a.address) !== a.family || !publicAddress(a.address))) {
    throw new Error('Source hostname resolves to a non-public address.');
  }
  return addresses;
}

const nativeTransport: NonNullable<SourceReaderOptions['transport']> = (url, { addresses, signal }) => new Promise((resolve, reject) => {
  // The original hostname remains the Host/SNI name. The socket resolves only to these checked addresses.
  const lookup: RequestOptions['lookup'] = (_host, options, callback) => {
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0]!.address, addresses[0]!.family);
  };
  const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
    method: 'GET', lookup, signal, agent: false,
    headers: { accept: 'text/html, application/xhtml+xml, application/pdf, text/plain;q=0.9', 'accept-encoding': 'identity', 'user-agent': 'Mozilla/5.0 (compatible; ChappSourceReader/1.0)' },
  }, (response: IncomingMessage) => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    resolve({ status: response.statusCode ?? 0, headers, body: response, cancel: () => response.destroy() });
  });
  request.on('error', reject);
  request.end();
});

async function bytesOf(response: SourceResponse, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  const size = Number(response.headers.get('content-length'));
  if (Number.isFinite(size) && size > maxBytes) throw new Error('Source document exceeds the download size limit.');
  async function* boundedInput() {
    let compressed = 0;
    for await (const chunk of response.body) {
      signal.throwIfAborted();
      compressed += chunk.byteLength;
      if (compressed > maxBytes) throw new Error('Source document exceeds the download size limit.');
      yield chunk;
    }
  }
  const encoding = (response.headers.get('content-encoding') ?? 'identity').toLowerCase();
  const input = Readable.from(boundedInput());
  const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : null;
  if (!decoder && encoding !== 'identity') throw new Error('Source document uses an unsupported content encoding.');
  const stream = decoder ? input.pipe(decoder) : input;
  // pipe does not forward source errors to its destination.
  if (decoder) input.on('error', error => decoder.destroy(error));
  const abort = () => { input.destroy(signal.reason); decoder?.destroy(signal.reason); };
  signal.addEventListener('abort', abort, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      total += chunk.byteLength;
      if (total > maxBytes) throw new Error('Source document exceeds the decoded size limit.');
      chunks.push(chunk);
    }
    return new Uint8Array(Buffer.concat(chunks));
  } finally {
    signal.removeEventListener('abort', abort);
    input.destroy();
    decoder?.destroy();
  }
}

const cleanText = (text: string) => text.replace(/\u0000/g, '').replace(/\r\n?/g, '\n').replace(/[ \t\f\v\u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();

/** Keep paragraph, list and table boundaries rather than joining adjacent HTML cells into misleading numbers. */
function documentText(root: Node): string {
  const pieces: string[] = [];
  const stack: { node: Node; exit?: boolean }[] = [{ node: root }];
  let visited = 0;
  while (stack.length) {
    const { node, exit } = stack.pop()!;
    if (++visited > 200_000) throw new Error('Source HTML has too many elements to read safely.');
    if (node.nodeType === 3) { pieces.push(node.textContent ?? ''); continue; }
    const tag = node.nodeName.toLowerCase();
    if (exit) {
      if (tag === 'td' || tag === 'th') pieces.push(' | ');
      else if (/^(p|div|section|article|main|h[1-6]|li|ul|ol|tr|table|br|pre|blockquote|figure|figcaption)$/.test(tag)) pieces.push('\n');
      continue;
    }
    if (/^(p|div|section|article|main|h[1-6]|li|tr|table|br|pre|blockquote)$/.test(tag)) pieces.push('\n');
    if (tag === 'li') pieces.push('- ');
    stack.push({ node, exit: true });
    for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push({ node: node.childNodes[i]! });
  }
  return cleanText(pieces.join('')).replace(/ \|\s*\n/g, '\n');
}

function htmlDocument(html: string, maxChars: number) {
  const { document } = parseHTML(html);
  const title = cleanText(document.querySelector('title')?.textContent ?? '');
  for (const node of document.querySelectorAll('script, style, noscript, nav, footer, form, svg, iframe, [hidden], [aria-hidden="true"]')) node.remove();
  // Prefer explicit document content: scientific protocols may be tables that article heuristics would discard.
  const main = document.querySelector('main, [role="main"], article');
  let text: string;
  let extractedTitle = title;
  if (main) text = documentText(main);
  else {
    const article = new Readability(document.cloneNode(true) as Document, { charThreshold: 80, maxElemsToParse: 100_000 }).parse();
    extractedTitle ||= article?.title ?? '';
    text = article?.content ? documentText(parseHTML(`<html><body>${article.content}</body></html>`).document.body) : documentText(document.body);
  }
  if (text.length < 40 || (text.length < 800 && /enable javascript|access denied|just a moment|checking your browser/i.test(`${title} ${text}`))) {
    throw new Error('Source HTML has no readable document body; it may require JavaScript or block access.');
  }
  return { title: extractedTitle, pages: [{ text: text.slice(0, maxChars) }], ...(text.length > maxChars ? { truncated: true } : {}) };
}

type ParsedPdf = Pick<ReadDocument, 'title' | 'pages' | 'truncated'>;
async function pdfText(bytes: Uint8Array, maxPages: number, maxChars: number): Promise<ParsedPdf> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const assets = import.meta.resolve('pdfjs-dist/package.json');
  const loading = getDocument({ data: bytes, standardFontDataUrl: fileURLToPath(new URL('./standard_fonts/', assets)), cMapUrl: fileURLToPath(new URL('./cmaps/', assets)), cMapPacked: true, useSystemFonts: false, disableFontFace: true, useWasm: false, enableXfa: false, stopAtErrors: true, maxImageSize: 0, disableAutoFetch: true, disableStream: true });
  try {
    const pdf = await loading.promise;
    const metadata = await pdf.getMetadata().catch(() => null);
    const info = metadata?.info as { Title?: string } | undefined;
    const pages: ReadDocument['pages'] = [];
    let remaining = maxChars, truncated = pdf.numPages > maxPages;
    for (let number = 1; number <= Math.min(maxPages, pdf.numPages); number++) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      const text = cleanText(content.items.map(item => 'str' in item ? `${item.str}${item.hasEOL ? '\n' : ' '}` : '').join(''));
      pages.push({ page: number, text: text.slice(0, remaining) });
      if (text.length > remaining) truncated = true;
      remaining -= Math.min(remaining, text.length);
      page.cleanup();
      if (!remaining) { truncated ||= number < pdf.numPages; break; }
    }
    if (!pages.some(page => page.text.trim())) throw new Error('PDF has no extractable text in the inspected pages; it may be scanned or empty. OCR was not performed.');
    return { title: cleanText(info?.Title ?? ''), pages, ...(truncated ? { truncated: true } : {}) };
  } finally { await loading.destroy(); }
}

type ParseTask = { format: 'pdf'; bytes: Uint8Array; maxPages: number; maxChars: number }
  | { format: 'html'; bytes: Uint8Array; charset: string; maxChars: number };

/** Isolate both parsers: a small input can expand into a large DOM or PDF object graph. */
function parseDocument(task: ParseTask, signal: AbortSignal): Promise<ParsedPdf> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { sourceReaderParse: true, task },
      resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 8 },
    });
    let settled = false;
    const finish = () => { signal.removeEventListener('abort', abort); void worker.terminate(); };
    const abort = () => { settled = true; reject(signal.reason); finish(); };
    signal.addEventListener('abort', abort, { once: true });
    worker.once('message', (message: { result?: ParsedPdf; error?: string }) => {
      settled = true;
      if (message.result) resolve(message.result); else reject(new Error(message.error ?? 'Could not extract source text.'));
      finish();
    });
    worker.once('error', error => { settled = true; reject(error); finish(); });
    worker.once('exit', () => {
      if (!settled) { reject(new Error('Source text extraction stopped before completion.')); finish(); }
    });
    if (signal.aborted) abort();
  });
}

if (!isMainThread && workerData?.sourceReaderParse === true) {
  const task = workerData.task as ParseTask;
  Promise.resolve().then(() => task.format === 'pdf' ? pdfText(task.bytes, task.maxPages, task.maxChars)
    : htmlDocument(new TextDecoder(task.charset).decode(task.bytes), task.maxChars)).then(
    result => parentPort?.postMessage({ result }),
    error => parentPort?.postMessage({ error: error instanceof Error ? error.message : 'Could not extract source text.' }),
  ).finally(() => parentPort?.close());
}

/** Read a bounded public document. HTML/PDF scripts and external resources are never executed or fetched. */
export async function readSource(raw: string, options: SourceReaderOptions = {}): Promise<ReadDocument> {
  const { timeoutMs = 20_000, maxBytes = 8 * 1024 * 1024, maxPages = 100, maxChars = 80_000 } = options;
  for (const [name, value, max] of [['timeoutMs', timeoutMs, 120_000], ['maxBytes', maxBytes, 32 * 1024 * 1024], ['maxPages', maxPages, 200], ['maxChars', maxChars, 200_000]] as const) {
    if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`Invalid source reader ${name}.`);
  }
  const controller = new AbortController();
  const timed = setTimeout(() => controller.abort(new DOMException('Reading the source document timed out.', 'TimeoutError')), timeoutMs);
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const signal = controller.signal;
  const lookup = options.lookup ?? (host => dnsLookup(host, { all: true, verbatim: true }));
  const transport = options.transport ?? nativeTransport;
  try {
    let url = sourceUrl(raw);
    for (let hop = 0; hop <= 4; hop++) {
      signal.throwIfAborted();
      const addresses = await publicAddresses(url, lookup, signal);
      const response = await abortable(transport(url, { addresses, signal }), signal);
      try {
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          if (!location) throw new Error('Source redirect did not provide a destination.');
          url = sourceUrl(new URL(location, url).href);
          continue;
        }
        if (response.status < 200 || response.status >= 300) throw new Error(`Source document returned HTTP ${response.status}.`);
        const bytes = await abortable(bytesOf(response, maxBytes, signal), signal);
        signal.throwIfAborted();
        const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
        const start = new TextDecoder().decode(bytes.subarray(0, 1024));
        let format: ReadDocument['format'], parsed: ParsedPdf;
        if (start.startsWith('%PDF-')) {
          format = 'pdf';
          parsed = await parseDocument({ format, bytes, maxPages, maxChars }, signal);
        } else if (['text/html', 'application/xhtml+xml'].includes(type) || (!type && /^\s*<!doctype html|^\s*<html/i.test(start))) {
          format = 'html';
          const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(response.headers.get('content-type') ?? '')?.[1] ?? 'utf-8';
          parsed = await parseDocument({ format, bytes, charset, maxChars }, signal);
        } else if (['text/plain', 'text/markdown'].includes(type)) {
          format = 'text';
          const text = cleanText(new TextDecoder().decode(bytes));
          if (!text || text.includes('\ufffd') && text.split('\ufffd').length > text.length / 10) throw new Error('Source document has no usable text.');
          parsed = { title: '', pages: [{ text: text.slice(0, maxChars) }], ...(text.length > maxChars ? { truncated: true } : {}) };
        } else throw new Error('Source is not readable HTML, plain text or a text-based PDF.');
        signal.throwIfAborted();
        return { ...parsed, url: url.href, format, title: parsed.title.slice(0, 300) || `${url.hostname}${url.pathname}`, fetchedAt: new Date().toISOString() };
      } finally { response.cancel?.(); }
    }
    throw new Error('Source URL redirects too many times.');
  } finally {
    clearTimeout(timed);
    options.signal?.removeEventListener('abort', abort);
  }
}
