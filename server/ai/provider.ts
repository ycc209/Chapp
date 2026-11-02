/**
 * Which AI answers the app. Both providers implement shared/ai.ts's AIProvider, so routes never know which one they
 * are talking to.
 *
 *   AI_PROVIDER=mock   fixed answers built from the BCA kit; no network, no cost
 *   AI_PROVIDER=meta   Meta's models through the Model API (needs MODEL_API_KEY)
 *   unset              meta when MODEL_API_KEY is set, otherwise mock
 */
import { readEvents } from '../../shared/sse.ts';

export type { AIProvider } from '../../shared/ai.ts';

export type ProviderName = 'mock' | 'meta';

export function chooseProvider(env: Record<string, string | undefined> = process.env): ProviderName {
  const asked = env.AI_PROVIDER?.trim().toLowerCase();
  if (asked === 'mock' || asked === 'meta') return asked;
  if (asked) throw new Error(`AI_PROVIDER must be "mock" or "meta", not "${env.AI_PROVIDER}".`);
  return env.MODEL_API_KEY ? 'meta' : 'mock';
}

/** The model behind the provider failed or timed out. Routes answer 502 with `message`, which never holds the key. */
export class UpstreamError extends Error {
  name = 'UpstreamError';
}

type Json = Record<string, any>;

/**
 * A streamed Responses API reply (stream: true): each event to `onEvent` as it arrives, then the finished response
 * from response.completed. A failed or cut-off stream comes back as a failed response, so callers check one shape.
 */
export async function finished(body: ReadableStream<Uint8Array>, onEvent: (event: Json) => void): Promise<Json> {
  for await (const { data } of readEvents(body)) {
    if (data === '[DONE]') break;
    let event: Json;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    onEvent(event);
    if (event.type === 'response.completed') return event.response ?? {};
    if (event.type === 'response.failed' || event.type === 'response.incomplete') {
      return { ...event.response, status: 'failed', error: event.response?.error ?? { message: event.response?.incomplete_details?.reason ?? event.type } };
    }
    if (event.type === 'error') return { status: 'failed', error: { message: event.message ?? event.error?.message ?? event.code } };
  }
  return { status: 'failed', error: { message: 'the stream ended before the answer' } };
}
