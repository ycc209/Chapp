import type { ServerResponse } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AIProvider } from '../shared/ai.ts';
import { Protocol } from '../shared/protocol.ts';
import { stepFacts } from '../shared/stepFacts.ts';

/**
 * GET /api/protocols/:id/pictures/:step.svg → the picture on that step's card: made once by the provider (Muse Spark
 * writes it as SVG, server/ai/picture.ts) and kept in data/pictures/v2/<protocol>/<step>.svg. Asked for again while it
 * is being made, the same making answers both. 404 when the provider draws none (the mock), the protocol or step is not
 * here, or what came back was not plain drawing: the card keeps its own simple picture.
 */

const PATH = /^\/api\/protocols\/([a-z0-9-]+)\/pictures\/([a-z0-9-]+)\.svg$/;

export function createPictureHandler({ provider, protocols, pictures, log = (line: string) => console.log(line) }: { provider: AIProvider; protocols: string; pictures: string; log?: (line: string) => void }) {
  const making = new Map<string, Promise<string | null>>();

  const make = async (id: string, stepId: string, file: string): Promise<string | null> => {
    const raw = await readFile(resolve(protocols, `${id}.json`), 'utf8').catch(() => null);
    if (!raw || !provider.drawStep) return null;
    const p = Protocol.parse(JSON.parse(raw));
    for (const proc of p.procedures) {
      const step = [...(proc.prep ?? []), ...proc.steps].find(s => s.id === stepId);
      if (!step) continue;
      try {
        const svg = await provider.drawStep(stepFacts(p, proc, step));
        await mkdir(resolve(file, '..'), { recursive: true });
        await writeFile(file, svg);
        return svg;
      } catch (error) {
        log(`[pictures] ${id}/${stepId}: ${error instanceof Error ? error.message : 'failed'}`);
        return null;
      }
    }
    return null;
  };

  /** True when it answered the request. */
  return async (res: ServerResponse, path: string): Promise<boolean> => {
    const m = PATH.exec(path);
    if (!m) return false;
    const [, id, stepId] = m as unknown as [string, string, string];
    // v2: drawn with a layout per kind of step, at medium effort (server/ai/picture.ts).
    const file = resolve(pictures, 'v2', id, `${stepId}.svg`);
    let svg = await readFile(file, 'utf8').catch(() => null);
    if (!svg) {
      const key = `${id}/${stepId}`;
      let pending = making.get(key);
      if (!pending) {
        pending = make(id, stepId, file).finally(() => making.delete(key));
        making.set(key, pending);
      }
      svg = await pending;
    }
    if (!svg) {
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'No picture' }));
      return true;
    }
    res
      .writeHead(200, {
        'content-type': 'image/svg+xml',
        'cache-control': 'public, max-age=86400',
        // Shown as an image; even opened on its own it may run nothing and load nothing.
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
        'x-content-type-options': 'nosniff',
      })
      .end(svg);
    return true;
  };
}
