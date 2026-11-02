import { describe, expect, it, vi } from 'vitest';
import { createProtocolPreview, type ProtocolPreviewOptions } from '../server/ai/protocolPreview.ts';
import { assemble, importProtocol, introFromProtocol, type ImportOptions } from '../server/ai/import.ts';
import { downloadPdf, readManual } from '../server/imports.ts';
import type { AIProvider, ImportedProtocol, ProtocolPreview } from '../shared/ai.ts';
import { parts } from './import-fixture.ts';

const url = 'https://manufacturer.example/manual.pdf?revision=2';
const protocol = assemble(parts(), { sha256: 'b'.repeat(64), pages: 2, fetchedAt: '2026-10-30T00:00:00.000Z', seconds: 1, url }).protocol;
const imported: ImportedProtocol = { protocol, problems: ['One detail needs review'], sources: [{ url, title: protocol.source.title }] };
const pdf = new TextEncoder().encode('%PDF-1.4\nexample');
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const deps = (changes: Partial<ProtocolPreviewOptions> = {}): ProtocolPreviewOptions => ({ knownProtocol: () => null, download: vi.fn(async () => pdf), readManual: vi.fn(async () => imported), ...changes });

describe('protocol previews', () => {
  it('previews a known protocol immediately without downloading or starting model work', async () => {
    const options = deps({ knownProtocol: request => request.protocolId === protocol.id ? protocol : null });
    const events: ProtocolPreview[] = [];
    const preview = createProtocolPreview(options);
    const task = preview({ protocolId: protocol.id }, { onProtocol: p => events.push(p) });
    expect(events[0]).toMatchObject({ state: 'reading', title: protocol.title, source: { url } });
    const result = await task;
    expect(result.data).toMatchObject({ ok: true, protocolId: protocol.id, activated: false, preview: { state: 'ready', intro: introFromProtocol(protocol) } });
    expect(events.map(p => p.state)).toEqual(['reading', 'ready']);
    expect(new Set(events.map(p => p.id)).size).toBe(1);
    expect(options.download).not.toHaveBeenCalled();
    expect(options.readManual).not.toHaveBeenCalled();
  });

  it('streams the intro before the deep read completes, preserving the selected source URL', async () => {
    const gate = deferred<ImportedProtocol>();
    const started = deferred<void>();
    const events: ProtocolPreview[] = [];
    const preview = createProtocolPreview(deps({ readManual: async (_pdf, source, live) => {
      expect(source).toEqual({ url });
      live.onProgress('Turning it into steps');
      const intro = introFromProtocol(protocol);
      intro.source.url = 'https://model-rewritten.example/wrong.pdf';
      live.onIntro(intro);
      started.resolve();
      return gate.promise;
    } }));
    const task = preview({ url }, { onProtocol: p => events.push(p) });
    await started.promise;
    expect(events.at(-1)).toMatchObject({ state: 'reading', intro: { title: protocol.title, source: { url } }, source: { url }, progress: ['Turning it into steps'] });
    expect(events.at(-1)?.protocolId).toBeUndefined();
    gate.resolve(imported);
    await expect(task).resolves.toMatchObject({ data: { protocolId: protocol.id, preview: { state: 'ready', intro: { source: { url } } } }, sources: imported.sources });
  });

  it('retains a usable intro when the later read fails and never invents a protocol ID', async () => {
    const events: ProtocolPreview[] = [];
    const preview = createProtocolPreview(deps({ readManual: async (_pdf, _source, live) => {
      live.onIntro(introFromProtocol(protocol));
      throw new Error('The inventory could not be read');
    } }));
    const result = await preview({ url }, { onProtocol: p => events.push(p) });
    expect(result.data).toMatchObject({ ok: false, activated: false, preview: { state: 'error', error: 'The inventory could not be read', intro: { title: protocol.title }, source: { url } } });
    expect(result.data).not.toHaveProperty('protocolId');
    expect(events.at(-1)?.protocolId).toBeUndefined();
  });

  it('shares an in-flight read and reuses its completed preview without duplicate download or model cost', async () => {
    const gate = deferred<ImportedProtocol>();
    const options = deps({ readManual: vi.fn(() => gate.promise) });
    const preview = createProtocolPreview(options);
    const first: ProtocolPreview[] = [], second: ProtocolPreview[] = [];
    const a = preview({ url }, { onProtocol: p => first.push(p) });
    const b = preview({ url }, { onProtocol: p => second.push(p) });
    await vi.waitFor(() => expect(options.readManual).toHaveBeenCalledOnce());
    gate.resolve(imported);
    const [one, two] = await Promise.all([a, b]);
    expect(one).toEqual(two);
    expect(first.at(-1)).toEqual(second.at(-1));
    const cached = await preview({ url });
    expect(cached).toEqual(one);
    expect(options.download).toHaveBeenCalledOnce();
    expect(options.readManual).toHaveBeenCalledOnce();
  });

  it('does not cancel a shared read while another caller still needs it', async () => {
    const gate = deferred<ImportedProtocol>();
    let signal!: AbortSignal;
    const options = deps({ readManual: async (_pdf, _source, live) => { signal = live.signal; return gate.promise; } });
    const preview = createProtocolPreview(options);
    const controller = new AbortController();
    const a = preview({ url }, { signal: controller.signal });
    const b = preview({ url });
    await vi.waitFor(() => expect(signal).toBeDefined());
    const cancelled = expect(a).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await cancelled;
    expect(signal.aborted).toBe(false);
    gate.resolve(imported);
    await expect(b).resolves.toMatchObject({ data: { ok: true } });
  });

  it('aborts underlying work when every caller cancels and permits a fresh request afterward', async () => {
    let signal!: AbortSignal;
    const options = deps({ readManual: vi.fn(async (_pdf, _source, live) => {
      signal = live.signal;
      return await new Promise<ImportedProtocol>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }) });
    const preview = createProtocolPreview(options);
    const controller = new AbortController();
    const task = preview({ url }, { signal: controller.signal });
    await vi.waitFor(() => expect(signal).toBeDefined());
    const cancelled = expect(task).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await cancelled;
    expect(signal.aborted).toBe(true);
    options.readManual = vi.fn(async () => imported);
    await expect(preview({ url })).resolves.toMatchObject({ data: { ok: true } });
    expect(options.download).toHaveBeenCalledTimes(2);
  });

  it('rejects missing or ambiguous selections and reports unavailable local protocols', async () => {
    const options = deps();
    const preview = createProtocolPreview(options);
    await expect(preview({})).rejects.toThrow('Choose one');
    await expect(preview({ protocolId: protocol.id, url })).rejects.toThrow('Choose one');
    await expect(preview({ url: 'file:///etc/passwd' })).rejects.toThrow('manual URL');
    await expect(preview({ protocolId: 'unknown-kit' })).resolves.toMatchObject({ data: { ok: false, preview: { state: 'error' } } });
    expect(options.download).not.toHaveBeenCalled();
  });
});

describe('manual cancellation propagation', () => {
  it('cancels an active PDF download with the caller signal', async () => {
    const controller = new AbortController();
    const started = deferred<void>();
    const fetch: typeof globalThis.fetch = vi.fn(async (_input, init) => {
      started.resolve();
      return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }));
    });
    const task = downloadPdf(url, { fetch, signal: controller.signal });
    await started.promise;
    const cancelled = expect(task).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await cancelled;
  });

  it('passes cancellation through readManual and does not save an aborted result', async () => {
    const controller = new AbortController();
    const provider = { importProtocol: vi.fn(async (_pdf, _source, live) => {
      expect(live.signal).toBe(controller.signal);
      controller.abort();
      return imported;
    }) } as unknown as AIProvider;
    await expect(readManual(provider, pdf, { url }, { protocols: '/tmp/chapp-preview-nonexistent-library' }, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(provider.importProtocol).toHaveBeenCalledOnce();
  });

  it('stops active parallel model calls after caller cancellation without retry or further stages', async () => {
    const controller = new AbortController();
    const signals: AbortSignal[] = [];
    const fetch: typeof globalThis.fetch = vi.fn(async (_input, init) => {
      signals.push(init!.signal!);
      return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }));
    });
    const options: ImportOptions = { apiKey: 'offline-test-only', fetch, signal: controller.signal, log: () => {}, record: () => {}, asText: ['intro', 'inventory', 'steps', 'curves', 'notes'], textOf: () => 'Original manual text.' };
    const task = importProtocol(pdf, { url }, options);
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    const cancelled = expect(task).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await cancelled;
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
