import { describe, expect, it, vi } from 'vitest';
import { gzipSync } from 'node:zlib';
import { readSource, type SourceReaderOptions, type SourceResponse } from '../server/ai/sourceReader.ts';

const publicIp = { address: '93.184.216.34', family: 4 };
const lookup = vi.fn(async () => [publicIp]);
const response = (body: string | Uint8Array, type = 'text/html', status = 200, extra: Record<string, string> = {}): SourceResponse => ({
  status, headers: new Headers({ 'content-type': type, ...extra }),
  body: (async function* () { yield typeof body === 'string' ? new TextEncoder().encode(body) : body; })(),
  cancel: vi.fn(),
});
const options = (res: SourceResponse, extra: SourceReaderOptions = {}): SourceReaderOptions => ({ lookup, transport: vi.fn(async () => res), ...extra });
const article = '<html><head><title>DNA method</title></head><body><nav>Navigation garbage</nav><main><h1>DNA extraction</h1><p>Measure the sample and compare it with the specified matched buffer blank before interpreting the results.</p><table><tr><th>Reagent</th><th>25 µL reaction</th></tr><tr><td>Master mix</td><td>12.5 µL</td></tr></table></main><script>globalThis.scriptRan = true</script><footer>Footer garbage</footer></body></html>';

/** A real two-page text PDF with an xref table; no PDF extraction is mocked. */
function pdfFixture(lines: string[]) {
  const font = 3 + lines.length * 2;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${lines.map((_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${lines.length} >>`,
  ];
  for (let i = 0; i < lines.length; i++) {
    const content = `BT /F1 12 Tf 72 720 Td (${lines[i]!.replace(/[\\()]/g, '\\$&')}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${4 + i * 2} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let text = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((body, i) => { offsets.push(Buffer.byteLength(text)); text += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(text);
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(text));
}

describe('public source reader', () => {
  it('reads HTML content and table boundaries without navigation or executing scripts', async () => {
    const transport = vi.fn<NonNullable<SourceReaderOptions['transport']>>(async () => response(article));
    const doc = await readSource('https://manual.example/protocol#section', { lookup, transport });
    expect(doc).toMatchObject({ url: 'https://manual.example/protocol', title: 'DNA method', format: 'html' });
    expect(doc.pages[0]!.text).toContain('Master mix | 12.5 µL');
    expect(doc.pages[0]!.text).not.toMatch(/garbage|scriptRan/);
    expect(doc.pages[0]!.page).toBeUndefined();
    expect(transport.mock.calls[0]![1].addresses).toEqual([publicIp]);
    expect(Date.parse(doc.fetchedAt)).not.toBeNaN();
    expect((globalThis as any).scriptRan).toBeUndefined();
  });

  it('extracts text from real PDF pages with one-based page citations', async () => {
    const doc = await readSource('https://manual.example/paper.pdf', options(response(pdfFixture(['Evidence from page one.', 'Independent evidence from page two.']), 'application/pdf')));
    expect(doc.format).toBe('pdf');
    expect(doc.pages).toEqual([{ page: 1, text: 'Evidence from page one.' }, { page: 2, text: 'Independent evidence from page two.' }]);
    expect(doc.truncated).toBeUndefined();
  });

  it('reports PDF page/text truncation instead of pretending the entire file was read', async () => {
    const bytes = pdfFixture(['Evidence from page one.', 'Evidence from page two.']);
    const byPage = await readSource('https://manual.example/p.pdf', options(response(bytes, 'application/pdf'), { maxPages: 1 }));
    expect(byPage).toMatchObject({ truncated: true, pages: [{ page: 1, text: 'Evidence from page one.' }] });
    const byLength = await readSource('https://manual.example/p.pdf', options(response(bytes, 'application/pdf'), { maxChars: 8 }));
    expect(byLength).toMatchObject({ truncated: true, pages: [{ page: 1, text: 'Evidence' }] });
  });

  it('does not claim to have read a scanned/blank or malformed PDF', async () => {
    await expect(readSource('https://manual.example/scan.pdf', options(response(pdfFixture(['']), 'application/pdf')))).rejects.toThrow('no extractable text');
    await expect(readSource('https://manual.example/broken.pdf', options(response('%PDF-1.7\nbroken', 'application/pdf')))).rejects.toThrow();
    await expect(readSource('https://manual.example/fake.pdf', options(response('not a pdf', 'application/pdf')))).rejects.toThrow('not readable');
  });

  it.each([
    'file:///etc/passwd', 'https://u:p@manual.example/', 'http://localhost/', 'http://localhost./',
    'http://127.0.0.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://10.0.0.1/',
    'http://169.254.169.254/', 'http://100.64.1.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/',
    'http://[fc00::1]/', 'http://[fe80::1]/', 'http://[2002:7f00:1::]/', 'http://service.internal/',
  ])('rejects private, disguised or non-HTTP source %s before any request', async url => {
    const transport = vi.fn();
    await expect(readSource(url, { lookup, transport })).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });

  it('rejects hostnames with a private DNS answer, including mixed public/private answers', async () => {
    for (const addresses of [[{ address: '127.0.0.1', family: 4 }], [publicIp, { address: '10.0.0.1', family: 4 }]]) {
      const transport = vi.fn();
      await expect(readSource('https://public-name.example', { transport, lookup: async () => addresses })).rejects.toThrow('non-public');
      expect(transport).not.toHaveBeenCalled();
    }
  });

  it('checks every redirect and cancels response bodies', async () => {
    const first = response('', 'text/html', 302, { location: 'http://169.254.169.254/latest' });
    const transport = vi.fn(async () => first);
    await expect(readSource('https://manual.example/start', { lookup, transport })).rejects.toThrow('public address');
    expect(transport).toHaveBeenCalledTimes(1);
    expect(first.cancel).toHaveBeenCalledOnce();
    const moved = response('', 'text/html', 302, { location: 'https://other.example/final' });
    const final = response(article);
    const resolve = vi.fn<NonNullable<SourceReaderOptions['lookup']>>(async () => [publicIp]);
    const read = await readSource('https://manual.example/start', { lookup: resolve, transport: vi.fn().mockResolvedValueOnce(moved).mockResolvedValueOnce(final) });
    expect(read.url).toBe('https://other.example/final');
    expect(resolve.mock.calls.map(call => call[0])).toEqual(['manual.example', 'other.example']);
    expect(final.cancel).toHaveBeenCalledOnce();
  });

  it('rechecks DNS on a same-host redirect instead of trusting its first public answer', async () => {
    const resolve = vi.fn<NonNullable<SourceReaderOptions['lookup']>>()
      .mockResolvedValueOnce([publicIp]).mockResolvedValueOnce([{ address: '192.168.1.1', family: 4 }]);
    const transport = vi.fn(async () => response('', 'text/html', 302, { location: '/second' }));
    await expect(readSource('https://manual.example/first', { lookup: resolve, transport })).rejects.toThrow('non-public');
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('bounds declared, streamed and decompressed document sizes', async () => {
    await expect(readSource('https://manual.example', options(response(article, 'text/html', 200, { 'content-length': '10000' }), { maxBytes: 100 }))).rejects.toThrow('size limit');
    await expect(readSource('https://manual.example', options(response(article), { maxBytes: 100 }))).rejects.toThrow('size limit');
    await expect(readSource('https://manual.example', options(response(gzipSync('a'.repeat(5000)), 'text/plain', 200, { 'content-encoding': 'gzip' }), { maxBytes: 100 }))).rejects.toThrow('decoded size limit');
  });

  it('times out DNS lookup and downloading, and respects an already aborted caller', async () => {
    await expect(readSource('https://manual.example', { timeoutMs: 20, lookup: () => new Promise(() => {}) })).rejects.toMatchObject({ name: 'TimeoutError' });
    await expect(readSource('https://manual.example', { lookup, timeoutMs: 20, transport: () => new Promise(() => {}) })).rejects.toMatchObject({ name: 'TimeoutError' });
    const controller = new AbortController();
    controller.abort();
    const transport = vi.fn();
    await expect(readSource('https://manual.example', { lookup, transport, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(transport).not.toHaveBeenCalled();
  });

  it('aborts an active body read and PDF worker rather than leaving parsing running', async () => {
    const res = response('');
    res.body = (async function* () { yield new TextEncoder().encode('<html>'); await new Promise(() => {}); })();
    await expect(readSource('https://manual.example', options(res, { timeoutMs: 20 }))).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(res.cancel).toHaveBeenCalledOnce();
    const controller = new AbortController();
    const reading = readSource('https://manual.example/p.pdf', options(response(pdfFixture(['Text on a page.']), 'application/pdf'), { signal: controller.signal }));
    setTimeout(() => controller.abort(), 10);
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('keeps HTML parsing off the event loop and terminates its worker on timeout', async () => {
    // Download is immediate; constructing this DOM synchronously would prevent the timeout from firing.
    const html = `<html><body><main>${'<p>Original scientific document text.</p>'.repeat(80_000)}</main></body></html>`;
    const started = Date.now();
    await expect(readSource('https://manual.example/large', options(response(html), { timeoutMs: 30 }))).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('rejects error/shell pages and exposes truncation of readable HTML or plain text', async () => {
    await expect(readSource('https://manual.example', options(response(article, 'text/html', 403)))).rejects.toThrow('HTTP 403');
    await expect(readSource('https://manual.example', options(response('<html><body>Please enable JavaScript to continue reading this document in your browser.</body></html>')))).rejects.toThrow('no readable');
    expect(await readSource('https://manual.example', options(response(article), { maxChars: 20 }))).toMatchObject({ truncated: true });
    expect(await readSource('https://manual.example', options(response('This source contains actual plain text.', 'text/plain'), { maxChars: 10 }))).toMatchObject({ format: 'text', truncated: true, pages: [{ text: 'This sourc' }] });
  });
});
