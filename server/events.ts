import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ConverseEvent, ConverseLive, ConverseReply, FindProtocolEvent, FindProtocolLive, FoundProtocol, TrackedBottles, TrackEvent, TrackLive } from '../shared/ai.ts';
import { formatEvent } from '../shared/sse.ts';
import { UpstreamError } from './ai/provider.ts';

/** The phone asked for server-sent events (accept: text/event-stream) rather than one JSON answer. */
export const wantsEvents = (req: IncomingMessage) => (req.headers.accept ?? '').includes('text/event-stream');

export async function streamConverse(res: ServerResponse, converse: (live: ConverseLive) => Promise<ConverseReply>) {
  const stop = new AbortController();
  res.on('close', () => { if (!res.writableFinished) stop.abort(); });
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' });
  res.flushHeaders();
  const send = (event: ConverseEvent['event'], data: ConverseEvent['data']) => {
    if (!res.writableEnded && !res.destroyed) res.write(formatEvent(event, data));
  };
  try {
    const reply = await converse({ signal: stop.signal, onText: delta => send('text', { delta }), onProgress: line => send('progress', { line }), onProtocol: preview => send('protocol', preview) });
    send('reply', reply);
  } catch (error) {
    if (!stop.signal.aborted) send('error', { error: error instanceof Error ? error.message : String(error) });
  } finally {
    res.end();
  }
}

/**
 * POST /api/find-protocol as server-sent events: each progress line as `find` says it, then the FoundProtocol, or an
 * error (the status is 200 by then, so it travels as an event). Closing the page stops the search upstream. `find` is
 * the search itself: provider.findProtocol, or anything wrapping it that passes `live` on.
 */
export async function streamFindProtocol(res: ServerResponse, find: (live: FindProtocolLive) => Promise<FoundProtocol>) {
  const stop = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) stop.abort();
  });
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' });
  res.flushHeaders();
  const send = ({ event, data }: FindProtocolEvent) => {
    if (!res.writableEnded && !res.destroyed) res.write(formatEvent(event, data));
  };
  try {
    const found = await find({
      onProgress: line => send({ event: 'progress', data: { line } }),
      // A manual new to Chapp: what the kit is, while its steps are still being read (server/imports.ts).
      onIntro: intro => send({ event: 'intro', data: intro }),
      signal: stop.signal,
    });
    send({ event: 'found', data: found });
  } catch (error) {
    if (stop.signal.aborted) return;
    if (error instanceof UpstreamError) console.error(`[api] /api/find-protocol: ${error.message}`);
    send({ event: 'error', data: { error: error instanceof Error ? error.message : String(error) } });
  }
  res.end();
}

/**
 * POST /api/kit/track as server-sent events: when each of the video's frames starts, how far it is on its way to SAM,
 * each frame as SAM is done with it, then the bottles followed (their sightings already sent), or an error. Closing the
 * page stops SAM upstream, so a video no one is waiting for is not paid for to its end.
 */
export async function streamTrack(res: ServerResponse, track: (live: TrackLive) => Promise<TrackedBottles>) {
  const stop = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) stop.abort();
  });
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' });
  res.flushHeaders();
  const send = ({ event, data }: TrackEvent) => {
    if (!res.writableEnded && !res.destroyed) res.write(formatEvent(event, data));
  };
  try {
    const { seen: _, ...followed } = await track({
      onVideo: video => send({ event: 'video', data: video }),
      onStage: stage => send({ event: 'stage', data: { stage } }),
      onFrame: frame => send({ event: 'frame', data: frame }),
      signal: stop.signal,
    });
    send({ event: 'followed', data: followed });
  } catch (error) {
    if (stop.signal.aborted) return;
    if (error instanceof UpstreamError) console.error(`[api] /api/kit/track: ${error.message}`);
    send({ event: 'error', data: { error: error instanceof Error ? error.message : String(error) } });
  }
  res.end();
}
