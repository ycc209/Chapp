import type { ApiError, FindProtocolEvent, FoundProtocol, ProtocolIntro, Sighting, TrackedBottles, TrackEvent, TrackLive } from '../../shared/ai.ts';
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

/** Following a video, heard on the phone: everything TrackLive says, and how much of the video has gone up (0–1). */
export type TrackHeard = Omit<TrackLive, 'signal'> & { onUpload?: (sent: number) => void };

/**
 * POST /api/kit/track as server-sent events: the video sent as it is (MP4 or MOV); `live` hears how much of it has gone
 * up, when each of its frames starts, how far it is on its way to SAM, then each frame as SAM is done with
 * it; the promise ends with the bottles followed, their sightings gathered from the frames. Throws like the other calls
 * on an error, or when the stream ends without an answer. Sent with XMLHttpRequest: fetch cannot tell how much of a
 * body has gone up, and a phone's video is megabytes.
 */
export function trackBottlesLive(video: Blob, type: 'video/mp4' | 'video/quicktime', signal?: AbortSignal, live?: TrackHeard, uploaded?: string | null): Promise<TrackedBottles> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/kit/track');
    xhr.setRequestHeader('content-type', type);
    xhr.setRequestHeader('accept', 'text/event-stream');
    // Sent ahead piece by piece as it was recorded (sendAhead): named, not sent again.
    if (uploaded) {
      xhr.setRequestHeader('x-chapp-upload', uploaded);
      live?.onUpload?.(1);
    }
    xhr.upload.onprogress = e => {
      if (e.lengthComputable && e.total > 0) live?.onUpload?.(e.loaded / e.total);
    };
    // What has come so far, as a stream readEvents reads as it comes (the same reader as a fetch's body).
    const encoder = new TextEncoder();
    let given = 0;
    let body: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start: c => void (body = c) });
    // Once the answer is read (readEvents lets go of the stream), what comes after it is not wanted.
    const more = () => {
      const text = xhr.responseText;
      try {
        if (text.length > given) body.enqueue(encoder.encode(text.slice(given)));
      } catch {
        // Let go of already.
      }
      given = text.length;
    };
    const fail = (error: Error) => {
      try {
        body.error(error);
      } catch {
        // Closed already.
      }
      reject(error);
    };
    let streaming = false;
    xhr.onreadystatechange = () => {
      if (xhr.readyState !== XMLHttpRequest.HEADERS_RECEIVED) return;
      streaming = xhr.status >= 200 && xhr.status < 300 && (xhr.getResponseHeader('content-type') ?? '').includes('text/event-stream');
      if (streaming) void readTrack(stream, live).then(resolve, reject);
    };
    xhr.onprogress = () => streaming && more();
    xhr.onload = () => {
      if (streaming) {
        more();
        try {
          body.close();
        } catch {
          // Let go of already.
        }
        return;
      }
      let answer: unknown = null;
      try {
        answer = JSON.parse(xhr.responseText);
      } catch {
        // Not JSON: said below.
      }
      // A server without streaming answers in one piece.
      if (xhr.status >= 200 && xhr.status < 300 && answer) return resolve(answer as TrackedBottles);
      reject(new Error((answer as ApiError | null)?.error || `${xhr.status} ${xhr.statusText}`.trim()));
    };
    xhr.onerror = () => fail(new Error('Could not reach the server to follow the video'));
    xhr.ontimeout = () => fail(new Error('Following the video took too long'));
    signal?.addEventListener('abort', () => {
      xhr.abort();
      fail(signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'));
    });
    xhr.send(uploaded ? null : video);
  });
}

/** What the server says when an upload sent ahead is not there (a restart): the video is sent itself then. */
export const UPLOAD_GONE = /upload is gone/i;

/**
 * A video sent to the server piece by piece while it is still being recorded (a sweep: MediaRecorder hands over a
 * piece a second), so that once it stops only its last piece is left to send: POST /api/kit/track/part, in order.
 * `done` says the upload's id once every piece is there, or null when one failed (the video is then sent whole).
 */
export function sendAhead(): { send(piece: Blob): void; done(): Promise<string | null> } {
  const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `up-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  let n = 0;
  let sent: Promise<boolean> = Promise.resolve(true);
  return {
    send(piece) {
      const k = n++;
      sent = sent.then(ok =>
        ok ? fetch(`/api/kit/track/part?upload=${id}&n=${k}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: piece }).then(r => r.ok, () => false) : false,
      );
    },
    done: () => sent.then(ok => (ok && n > 0 ? id : null)),
  };
}

/** A video followed, as its events come (TrackEvent): each to `live`, the sightings gathered from the frames. */
async function readTrack(body: ReadableStream<Uint8Array>, live?: TrackHeard): Promise<TrackedBottles> {
  const seen: Sighting[] = [];
  for await (const { event, data } of readEvents(body)) {
    const e = { event, data: JSON.parse(data) } as TrackEvent;
    if (e.event === 'video') live?.onVideo?.(e.data);
    else if (e.event === 'stage') live?.onStage?.(e.data.stage);
    else if (e.event === 'frame') {
      for (const b of e.data.bottles) seen.push({ frame: e.data.frame, ...b });
      live?.onFrame?.(e.data);
    } else if (e.event === 'followed') return { ...e.data, seen };
    else if (e.event === 'error') throw new Error(e.data.error);
  }
  throw new Error('SAM stopped before it was done with the video');
}
