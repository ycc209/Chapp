import type { ApiError, ImportedProtocol, ProtocolIntro } from '../../shared/ai.ts';
import { readEvents } from '../../shared/sse.ts';

/** The largest manual the server reads (server/ai/import.ts's MAX_PDF). */
export const MAX_MANUAL_BYTES = 20 * 1024 * 1024;

/**
 * POST /api/import-protocol as server-sent events: the server reads the vendor's manual (a PDF) into a protocol and
 * keeps it. `onProgress` hears each stage as it happens ("Reading the manual", "Turning it into steps"), `onIntro`
 * what the kit is within seconds; the promise ends with the ImportedProtocol, whose protocol.id opens it. Throws an
 * Error fit to show on a refusal or a failure.
 */
export async function importProtocolLive(
  pdf: Blob,
  name: string,
  onProgress: (line: string) => void,
  signal?: AbortSignal,
  onIntro?: (intro: ProtocolIntro) => void,
): Promise<ImportedProtocol> {
  if (pdf.size > MAX_MANUAL_BYTES) throw new Error('That PDF is too large to read (20 MB at most).');
  const res = await fetch(`/api/import-protocol?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/pdf', accept: 'text/event-stream' },
    body: pdf,
    signal,
  });
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => null)) as ApiError | null;
    throw new Error(body?.error || `${res.status} ${res.statusText}`.trim());
  }
  if (!(res.headers.get('content-type') ?? '').includes('text/event-stream')) return (await res.json()) as ImportedProtocol;
  for await (const { event, data } of readEvents(res.body)) {
    const value = JSON.parse(data);
    if (event === 'progress') onProgress(value.line);
    else if (event === 'intro') onIntro?.(value as ProtocolIntro);
    else if (event === 'imported') return value as ImportedProtocol;
    else if (event === 'error') throw new Error((value as ApiError).error);
  }
  throw new Error('Reading the manual stopped before it was done');
}
