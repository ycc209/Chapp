import type { ApiError, ConverseReply, ConverseRequest, FoundProtocol, Health, PlateReading, ReadPlateRequest, Transcript } from '../../shared/ai.ts';
import type { ReadLabels, ReadLabelsRequest, RecognizedKit, RecognizeKitRequest, SegmentBottlesRequest, SegmentedBottles } from '../../shared/ai.ts';
import { findProtocolLive } from './events.ts';
import { importProtocolLive } from './imports.ts';

/**
 * The app's calls to the server (routes in shared/ai.ts). Relative URLs: Vite forwards /api in development and the
 * server serves both in production. A non-2xx answer throws an Error carrying the server's message, ready to show.
 * Each call takes an optional AbortSignal, so a new utterance can cancel the one still in flight.
 */

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, init);
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body as ApiError | null)?.error || `${res.status} ${res.statusText}`.trim());
  return body as T;
}

const postJson = (body: unknown, signal?: AbortSignal): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
  signal,
});

export const api = {
  health: (signal?: AbortSignal) => call<Health>('/api/health', { signal }),
  converse: (request: ConverseRequest, signal?: AbortSignal) => call<ConverseReply>('/api/converse', postJson(request, signal)),
  findProtocol: (query: string, signal?: AbortSignal) => call<FoundProtocol>('/api/find-protocol', postJson({ query }, signal)),
  /** The same search, its progress lines handed to onProgress as Chapp says them (src/api/events.ts). */
  findProtocolLive,
  /** A kit manual (PDF) read into a protocol and kept on the server, its stages handed to onProgress (src/api/imports.ts). */
  importProtocol: importProtocolLive,
  /** Mono 16-bit PCM WAV, 16 kHz, ≤ 10 MB. */
  transcribe: (wav: Blob, signal?: AbortSignal) =>
    call<Transcript>('/api/voice', { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wav, signal }),
  /** A photo of the reader or its export file → the plate's readings (server/ai/plate.ts). */
  readPlate: (request: ReadPlateRequest, signal?: AbortSignal) => call<PlateReading>('/api/read-plate', postJson(request, signal)),
  /** Time's up on the lock screen (server/push.ts): the key to subscribe with, a timer to send at its end, or not. */
  pushKey: (signal?: AbortSignal) => call<{ publicKey: string }>('/api/push/key', { signal }),
  pushTimer: (timer: PushTimerRequest) => call<{ id: string; endsAt: number }>('/api/push/timer', postJson(timer)),
  pushCancel: (endpoint: string, id: string) => call<{ cancelled: boolean }>('/api/push/cancel', postJson({ endpoint, id })),
  /** Kit photos (server/kit.ts): Muse Spark reads the kit's box; SAM 3.1 finds the bottles; Muse Spark reads their labels. */
  recognizeKit: (request: RecognizeKitRequest, signal?: AbortSignal) => call<RecognizedKit>('/api/kit/recognize', postJson(request, signal)),
  segmentBottles: (request: SegmentBottlesRequest, signal?: AbortSignal) => call<SegmentedBottles>('/api/kit/segment', postJson(request, signal)),
  readLabels: (request: ReadLabelsRequest, signal?: AbortSignal) => call<ReadLabels>('/api/kit/labels', postJson(request, signal)),
};

/** POST /api/push/timer: the browser's push subscription (PushSubscription.toJSON()) and what to say when it ends. */
export type PushTimerRequest = { subscription: PushSubscriptionJSON; id: string; endsAt: number; title: string; body: string; url: string };
