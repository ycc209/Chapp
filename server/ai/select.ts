import type { AIProvider } from '../../shared/ai.ts';
import { chooseProvider, type ProviderName } from './provider.ts';
import { createMockProvider } from './mock.ts';
import { createMetaProvider } from './meta.ts';

/** The provider AI_PROVIDER asks for (see provider.ts), built from the environment. Throws on a bad setting. */
export function createProvider(env: Record<string, string | undefined> = process.env): { name: ProviderName; provider: AIProvider } {
  const name = chooseProvider(env);
  const provider = name === 'meta' ? createMetaProvider({ apiKey: env.MODEL_API_KEY ?? '' }) : createMockProvider();
  return { name, provider };
}
