import type { AIProvider } from '../../shared/ai.ts';
import { chooseProvider, type ProviderName } from './provider.ts';
import { createMockProvider } from './mock.ts';
import { createMetaProvider, type MetaOptions } from './meta.ts';

/**
 * The provider AI_PROVIDER asks for (see provider.ts), built from the environment. Throws on a bad setting. `extras`
 * reach the Meta provider only: the server passes its embedding router (index.ts); tests pass nothing.
 */
export function createProvider(env: Record<string, string | undefined> = process.env, extras: Pick<MetaOptions, 'route'> = {}): { name: ProviderName; provider: AIProvider } {
  const name = chooseProvider(env);
  const provider = name === 'meta' ? createMetaProvider({ apiKey: env.MODEL_API_KEY ?? '', ...extras }) : createMockProvider();
  return { name, provider };
}
