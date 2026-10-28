import type { ApiError, FindProtocolEvent, FoundProtocol, ProtocolIntro } from '../../shared/ai.ts';
import { readEvents } from '../../shared/sse.ts';

/**
 * POST /api/find-protocol as server-sent events: `onProgress` gets each thing Chapp says while it searches, as it says
 * it; `onIntro` what the kit is, when the manual found is new and still being read; the promise ends with the
 * FoundProtocol. Throws like the other calls (src/api/client.ts) on an error, or when the stream ends without an answer.
 */
export async function findProtocolLive(
  query: string,
  onProgress: (line: string) => void,
  signal?: AbortSignal,
  onIntro?: (intro: ProtocolIntro) => void,
): Promise<FoundProtocol> {
  const res = await fetch('/api/find-protocol', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ query }),
    signal,
  });
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => null)) as ApiError | null;
    throw new Error(body?.error || `${res.status} ${res.statusText}`.trim());
  }
  // A server without streaming answers in one piece.
  if (!(res.headers.get('content-type') ?? '').includes('text/event-stream')) return (await res.json()) as FoundProtocol;
  for await (const { event, data } of readEvents(res.body)) {
    const e = { event, data: JSON.parse(data) } as FindProtocolEvent;
    if (e.event === 'progress') onProgress(e.data.line);
    else if (e.event === 'intro') onIntro?.(e.data);
    else if (e.event === 'found') return e.data;
    else if (e.event === 'error') throw new Error(e.data.error);
  }
  throw new Error('The search ended without an answer');
}
