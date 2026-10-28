/**
 * Server-sent events, both ways: the server reads Muse Spark's streamed reply with readEvents, writes its own stream
 * to the phone with formatEvent, and the phone reads that with readEvents again (src/api/client.ts).
 */

export type ServerEvent = { event: string; data: string };

/** One event on the wire: `event: progress`, then the data on one line, then a blank line. */
export const formatEvent = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/**
 * Each event of a text/event-stream body, in order, as it arrives. Reads with a reader rather than `for await`, which
 * older Safari lacks. Comments and ids are skipped; an event with no data is dropped. Stopping early cancels the body.
 */
export async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<ServerEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = '';
  let data: string[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let at: number;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).replace(/\r$/, '');
        buffer = buffer.slice(at + 1);
        if (line === '') {
          if (data.length) yield { event: event || 'message', data: data.join('\n') };
          event = '';
          data = [];
        } else if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (done) break;
    }
    if (buffer.startsWith('data:')) data.push(buffer.slice(5).replace(/^ /, ''));
    if (data.length) yield { event: event || 'message', data: data.join('\n') };
  } finally {
    await reader.cancel().catch(() => {});
  }
}
