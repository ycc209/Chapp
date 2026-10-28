/**
 * Which AI answers the app. Both providers implement shared/ai.ts's AIProvider, so routes never know which one they
 * are talking to.
 *
 *   AI_PROVIDER=mock   fixed answers built from the BCA kit; no network, no cost
 *   AI_PROVIDER=meta   Meta's models through the Model API (needs MODEL_API_KEY)
 *   unset              meta when MODEL_API_KEY is set, otherwise mock
 */
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
