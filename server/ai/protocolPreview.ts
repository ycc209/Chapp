import { randomUUID } from 'node:crypto';
import type { ConverseLive, ImportedProtocol, ProtocolIntro, ProtocolPreview } from '../../shared/ai.ts';
import type { Protocol } from '../../shared/protocol.ts';
import type { ToolResult } from './conversationTools.ts';
import { introFromProtocol } from './import.ts';
import { manualSources } from './protocols.ts';

export type PreviewRequest = { protocolId?: string; url?: string };
type ReadingLive = { signal: AbortSignal; onProgress: (line: string) => void; onIntro: (intro: ProtocolIntro) => void };
export type ProtocolPreviewOptions = {
  knownProtocol: (request: PreviewRequest) => Protocol | null;
  download: (url: string, signal: AbortSignal) => Promise<Uint8Array>;
  readManual: (pdf: Uint8Array, source: { url: string }, live: ReadingLive) => Promise<ImportedProtocol>;
};
type Entry = {
  preview: ProtocolPreview;
  listeners: Set<ConverseLive>;
  controller: AbortController;
  promise: Promise<ToolResult>;
  settled: boolean;
  expires: number;
};
const copy = <T>(value: T): T => structuredClone(value);

/** Prepare a library protocol for viewing. Adoption of an experiment is a separate browser action. */
export function createProtocolPreview(options: ProtocolPreviewOptions) {
  const entries = new Map<string, Entry>();
  const emit = (entry: Entry) => {
    for (const live of entry.listeners) if (!live.signal?.aborted) live.onProtocol?.(copy(entry.preview));
  };
  return async (request: PreviewRequest, live: ConverseLive = {}): Promise<ToolResult> => {
    live.signal?.throwIfAborted();
    if (Boolean(request.protocolId) === Boolean(request.url)) throw new Error('Choose one protocol ID or manual URL to preview.');
    if (request.url) {
      const url = URL.parse(request.url);
      if (!url || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || request.url.length > 8192) throw new Error('The preview requires a public manual URL.');
    }
    const key = request.protocolId ? `id:${request.protocolId}` : `url:${request.url}`;
    for (const [id, entry] of entries) if (entry.settled && entry.expires <= Date.now()) entries.delete(id);
    if (entries.size >= 64) {
      for (const [id, entry] of entries) { if (entry.settled) entries.delete(id); if (entries.size < 64) break; }
    }
    let entry = entries.get(key);
    if (!entry) {
      if ([...entries.values()].filter(item => !item.settled).length >= 4) throw new Error('Several manuals are already being prepared. Wait for one to finish.');
      const known = options.knownProtocol(request);
      const controller = new AbortController();
      entry = {
        preview: { id: randomUUID(), state: 'reading', ...(known ? { title: known.title, source: { url: request.url ?? known.source.url, title: known.source.title } } : request.url ? { source: { url: request.url } } : {}), progress: [] },
        controller, listeners: new Set(), settled: false, expires: Infinity, promise: Promise.resolve({ data: null }),
      };
      const current = entry;
      entries.set(key, current);
      current.promise = Promise.resolve().then(async () => {
        try {
          controller.signal.throwIfAborted();
          if (request.protocolId && !known) throw new Error('That protocol is not available in the local library.');
          let imported: ImportedProtocol;
          if (known) imported = { protocol: known, problems: known.imported?.problems ?? [], sources: manualSources(known) };
          else {
            const url = request.url!;
            const pdf = await options.download(url, controller.signal);
            controller.signal.throwIfAborted();
            imported = await options.readManual(pdf, { url }, {
              signal: controller.signal,
              onProgress: line => {
                if (controller.signal.aborted) return;
                current.preview.progress = [...(current.preview.progress ?? []), line.slice(0, 500)].slice(-8);
                emit(current);
                for (const subscriber of current.listeners) if (!subscriber.signal?.aborted) subscriber.onProgress?.(line);
              },
              onIntro: intro => {
                if (controller.signal.aborted) return;
                // The resolved source belongs to this request; a model-written URL cannot replace it.
                current.preview = { ...current.preview, title: intro.title, intro: { ...copy(intro), source: { ...intro.source, url } }, source: { url, title: intro.source.title || intro.title } };
                emit(current);
              },
            });
          }
          controller.signal.throwIfAborted();
          const protocol = imported.protocol;
          const intro = introFromProtocol(protocol);
          const url = request.url ?? protocol.source.url;
          intro.source.url = url;
          current.preview = { ...current.preview, state: 'ready', protocolId: protocol.id, title: protocol.title, intro,
            source: { url, title: protocol.source.title || protocol.title } };
          emit(current);
          return { data: { ok: true, preview: copy(current.preview), protocolId: protocol.id, title: protocol.title, problems: imported.problems, activated: false }, sources: imported.sources };
        } catch (error) {
          const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
          current.preview = { ...current.preview, state: 'error', error: message };
          emit(current);
          if (controller.signal.aborted) throw controller.signal.reason;
          return { data: { ok: false, preview: copy(current.preview), error: message, activated: false } };
        } finally {
          current.settled = true;
          current.expires = Date.now() + (current.preview.state === 'ready' ? 30 * 60_000 : 15_000);
          if (controller.signal.aborted && entries.get(key) === current) entries.delete(key);
        }
      });
    }
    const current = entry;
    const subscriber = { ...live };
    current.listeners.add(subscriber);
    live.onProtocol?.(copy(current.preview));
    return await new Promise<ToolResult>((resolve, reject) => {
      const release = () => {
        live.signal?.removeEventListener('abort', abort);
        current.listeners.delete(subscriber);
        if (!current.settled && !current.listeners.size) {
          if (entries.get(key) === current) entries.delete(key);
          current.controller.abort(new DOMException('Protocol preview cancelled', 'AbortError'));
        }
      };
      const abort = () => { release(); reject(live.signal?.reason); };
      live.signal?.addEventListener('abort', abort, { once: true });
      current.promise.then(result => { release(); resolve(copy(result)); }, error => { release(); reject(error); });
      if (live.signal?.aborted) abort();
    });
  };
}
