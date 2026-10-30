import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AIProvider } from '../shared/ai.ts';
import { Protocol } from '../shared/protocol.ts';
import { stepFacts, type StepFacts } from '../shared/stepFacts.ts';
import { createMetaProvider } from '../server/ai/meta.ts';
import { cleanSvg } from '../server/ai/picture.ts';
import { createPictureHandler } from '../server/pictures.ts';
import { procedureFor } from '../src/screens/protocol/content.ts';

// Step pictures written by Muse Spark (server/ai/picture.ts, server/pictures.ts): what it is told, what of its answer
// is kept, and each picture made once. A fake fetch and a fake provider: no network.

const protocols = new URL('../data/protocols/', import.meta.url);
const bcaFile = new URL('pierce-bca.json', protocols);
const bca = existsSync(bcaFile) ? Protocol.parse(JSON.parse(readFileSync(bcaFile, 'utf8'))) : null;
const DRAWING = '<svg viewBox="0 0 200 200"><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs><rect x="10" y="10" width="20" height="40" fill="url(#g)"/><text x="20" y="70">A</text></svg>';

describe('what of a drawing is kept', () => {
  it('keeps plain drawing, with its own references', () => {
    expect(cleanSvg(`Here it is:\n\`\`\`svg\n${DRAWING}\n\`\`\``)).toBe(DRAWING.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"'));
  });

  it.each([
    ['a script', '<svg viewBox="0 0 1 1"><script>alert(1)</script></svg>'],
    ['a style sheet', '<svg viewBox="0 0 1 1"><style>@import url(x)</style></svg>'],
    ['an image', '<svg viewBox="0 0 1 1"><image href="https://x/y.png"/></svg>'],
    ['a handler', '<svg viewBox="0 0 1 1"><rect onclick="x()"/></svg>'],
    ['a link out', '<svg viewBox="0 0 1 1"><rect fill="url(https://x/#g)"/></svg>'],
    ['data', '<svg viewBox="0 0 1 1"><path d="M0 0" fill="url(data:x)"/></svg>'],
    ['an attribute given twice (not XML)', '<svg viewBox="0 0 1 1"><line stroke="#fff" stroke="none"/></svg>'],
    ['a tag left open', '<svg viewBox="0 0 1 1"><g><rect/></svg>'],
    ['a bare ampersand', '<svg viewBox="0 0 1 1"><text>A & B</text></svg>'],
    ['no drawing at all', 'I cannot draw that.'],
  ])('drops %s', (_, svg) => {
    expect(cleanSvg(svg)).toBeNull();
  });
});

describe.skipIf(!bca)('what Muse Spark is told', () => {
  it('gets the step’s facts: BCA’s vials, its mix and the green the protocol gives it', () => {
    const proc = procedureFor(bca!);
    const standards = stepFacts(bca!, proc, proc.steps.find(s => s.stage === 'standards')!);
    expect(standards.vials?.map(v => v.label)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']);
    expect(standards.vials?.[0]?.concentration).toBe('2000 µg/mL');
    const mix = stepFacts(bca!, proc, proc.steps.find(s => s.stage === 'mix')!);
    expect(mix.mix).toEqual({ name: 'Working Reagent', parts: [{ name: 'BCA Reagent A', parts: 50 }, { name: 'BCA Reagent B', parts: 1 }], colour: '#3aa76d' });
    const load = stepFacts(bca!, proc, proc.steps.find(s => s.add?.some(a => a.what === 'mix'))!);
    expect(load.adds).toEqual([{ what: 'Working Reagent (green)', volume: '200 µL', per: 'well' }]);
  });

  it('asks with the facts and keeps only the drawing', async () => {
    const calls: { body: string }[] = [];
    const fetch = (async (_url: string, init: RequestInit) => {
      calls.push({ body: String(init.body) });
      return new Response(JSON.stringify({ choices: [{ message: { content: `\`\`\`svg\n${DRAWING}\n\`\`\`` } }] }));
    }) as unknown as typeof globalThis.fetch;
    const provider = createMetaProvider({ apiKey: 'k', fetch, log: () => {} });
    const facts: StepFacts = { stage: 'mix', title: 'Mix', does: 'Mix A and B', vessel: 'plate', mix: { name: 'WR', parts: [{ name: 'A', parts: 50 }, { name: 'B', parts: 1 }], colour: '#3aa76d' } };
    expect(await provider.drawStep!(facts)).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    const body = JSON.parse(calls[0]!.body);
    expect(body).toMatchObject({ model: 'muse-spark-1.3', reasoning_effort: 'medium' });
    expect(body.messages[0].content).toMatch(/no number that is not in the facts/);
    expect(JSON.parse(body.messages[1].content)).toEqual({ ...facts, layout: expect.stringMatching(/2 reagent bottles .* tall tube holding the mix in its colour/) });
  });
});

const servers: (() => void)[] = [];
afterEach(() => servers.splice(0).forEach(c => c()));

async function serve(provider: AIProvider, pictures: string) {
  const handle = createPictureHandler({ provider, protocols: new URL(protocols).pathname, pictures, log: () => {} });
  const server = createServer(async (req, res) => {
    if (!(await handle(res, req.url ?? ''))) res.writeHead(404).end();
  });
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  servers.push(() => server.close());
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe.skipIf(!bca)('GET /api/protocols/:id/pictures/:step.svg', () => {
  it('draws a step once and keeps it; asked twice at once, draws it once', async () => {
    let drawn = 0;
    const provider = { drawStep: async () => (drawn++, new Promise<string>(ok => setTimeout(() => ok(DRAWING), 40))) } as unknown as AIProvider;
    const dir = mkdtempSync(join(tmpdir(), 'chapp-pictures-'));
    const base = await serve(provider, dir);
    const step = procedureFor(bca!).steps[1]!.id;
    const [a, b] = await Promise.all([fetch(`${base}/api/protocols/pierce-bca/pictures/${step}.svg`), fetch(`${base}/api/protocols/pierce-bca/pictures/${step}.svg`)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.headers.get('content-type')).toBe('image/svg+xml');
    expect(a.headers.get('content-security-policy')).toMatch(/default-src 'none'/);
    expect(await a.text()).toBe(DRAWING);
    expect(drawn).toBe(1);
    expect(readFileSync(join(dir, 'v2', 'pierce-bca', `${step}.svg`), 'utf8')).toBe(DRAWING);
    // Kept: the next one is read, not drawn.
    expect((await fetch(`${base}/api/protocols/pierce-bca/pictures/${step}.svg`)).status).toBe(200);
    expect(drawn).toBe(1);
  });

  it('is not there without a model, for a step that is not there, or when the drawing fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chapp-pictures-'));
    const step = procedureFor(bca!).steps[1]!.id;
    expect((await fetch(`${await serve({} as AIProvider, dir)}/api/protocols/pierce-bca/pictures/${step}.svg`)).status).toBe(404);
    const failing = { drawStep: async () => { throw new Error('no'); } } as unknown as AIProvider;
    const base = await serve(failing, dir);
    expect((await fetch(`${base}/api/protocols/pierce-bca/pictures/${step}.svg`)).status).toBe(404);
    expect((await fetch(`${base}/api/protocols/pierce-bca/pictures/not-a-step.svg`)).status).toBe(404);
  });
});
