import { createServer } from 'node:http';
import { createHandler } from './app.ts';
import { createProvider } from './ai/select.ts';
import { chooseProvider } from './ai/provider.ts';
import { createRouter } from './ai/router.ts';
import { createLiveVoice } from './live.ts';
import { meter } from './ai/usage.ts';
import { seedDemo } from './ai/protocols.ts';
import { fileURLToPath } from 'node:url';

// The API and the built app. Routes live in app.ts; AI_PROVIDER (mock | meta) picks who answers (server/ai/provider.ts).
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3003);

// A clean checkout starts with the demo BCA protocol (server/demo/), so it runs with no key and no network.
if (seedDemo()) console.log('No data/protocols/ yet: started it with the demo Pierce BCA protocol (server/demo/).');

// CHAPP_DAILY_USD caps a day's spending on Meta's models (server/ai/usage.ts); today's total survives a restart.
meter.setCap(Number(process.env.CHAPP_DAILY_USD));
meter.keepIn(fileURLToPath(new URL('../data/usage.json', import.meta.url)));
if (meter.cap()) console.log(`Meta models: up to $${meter.cap().toFixed(2)} a day ($${meter.spent().toFixed(2)} used today)`);

let ai: ReturnType<typeof createProvider>;
try {
  // With Meta's models, the plainest bench commands are matched by embedding on this machine (server/ai/router.ts):
  // its model loads now, so the first "下一步" does not wait for it.
  const router = chooseProvider(process.env) === 'meta' ? createRouter() : null;
  void router?.warm();
  ai = createProvider(process.env, router ? { route: router.route } : {});
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

const handler = createHandler({ provider: ai.provider, providerName: ai.name, metaModelApi: Boolean(process.env.MODEL_API_KEY) });
const server = createServer(handler);
// Live speech (WebSocket /api/voice/live) only with Meta's models; without them the phone sends recordings instead.
const live = ai.name === 'meta' && process.env.MODEL_API_KEY ? createLiveVoice({ apiKey: process.env.MODEL_API_KEY }) : null;
server.on('upgrade', (req, socket, head) => {
  if (!live?.(req, socket, head)) socket.destroy();
});
server.listen(port, host, () => console.log(`Chapp available at http://${host}:${port} (AI: ${ai.name})`));
