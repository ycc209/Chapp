import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FindProtocolEvent, FindProtocolLive, FoundProtocol } from '../shared/ai.ts';
import { formatEvent } from '../shared/sse.ts';
import { UpstreamError } from './ai/provider.ts';

/** The phone asked for server-sent events (accept: text/event-stream) rather than one JSON answer. */
export const wantsEvents = (req: IncomingMessage) => (req.headers.accept ?? '').includes('text/event-stream');

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
