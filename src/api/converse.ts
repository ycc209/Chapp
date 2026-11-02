import type { ApiError, ConverseLive, ConverseReply, ConverseRequest } from '../../shared/ai.ts';
import { readEvents } from '../../shared/sse.ts';

/** The same conversation endpoint, with progress and answer text delivered as they arrive. */
export async function converseLive(request: ConverseRequest, live: ConverseLive = {}): Promise<ConverseReply> {
  const response = await fetch('/api/converse', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(request),
    signal: live.signal,
  });
  if (!response.ok || !response.body) {
    const error = await response.json().catch(() => null) as ApiError | null;
    throw new Error(error?.error || `${response.status} ${response.statusText}`.trim());
  }
  if (!response.headers.get('content-type')?.includes('text/event-stream')) return response.json() as Promise<ConverseReply>;
  for await (const { event, data } of readEvents(response.body)) {
    const value = JSON.parse(data);
    if (event === 'text') live.onText?.(value.delta);
    else if (event === 'progress') live.onProgress?.(value.line);
    else if (event === 'protocol') live.onProtocol?.(value);
    else if (event === 'reply') return value as ConverseReply;
    else if (event === 'error') throw new Error(value.error);
  }
  throw new Error('The conversation ended before its answer arrived');
}
