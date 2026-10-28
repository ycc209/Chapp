import { createServer } from 'node:http';
import { createHandler } from './app.ts';
import { createProvider } from './ai/select.ts';

// The API and the built app. Routes live in app.ts; AI_PROVIDER (mock | meta) picks who answers (server/ai/provider.ts).
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3003);

let ai: ReturnType<typeof createProvider>;
try {
  ai = createProvider(process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

const handler = createHandler({ provider: ai.provider, providerName: ai.name, metaModelApi: Boolean(process.env.MODEL_API_KEY) });
createServer(handler).listen(port, host, () => console.log(`Chapp available at http://${host}:${port} (AI: ${ai.name})`));
