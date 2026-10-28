// Serves the repository for v1/lookdev.html (the retired V1 mascot); POST /save/<name> writes a render into public/chapp/.
// The V4 stills come from lookdev.html through Vite instead: node scripts/chapp-model/stills.ts.
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const out = resolve(root, 'public/chapp');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.glb': 'model/gltf-binary', '.webp': 'image/webp', '.png': 'image/png' };
const port = Number(process.argv[2] || 5181);

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const save = path.match(/^\/save\/([\w.-]+)$/);
  if (req.method === 'POST' && save) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    await writeFile(resolve(out, save[1]), Buffer.concat(chunks));
    return res.end('ok');
  }
  const file = resolve(root, '.' + path);
  if (!file.startsWith(root.endsWith(sep) ? root : root + sep)) return res.writeHead(400).end();
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' }).end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(port, '127.0.0.1', () => console.log(`Chapp look-dev on http://127.0.0.1:${port}/scripts/chapp-model/lookdev.html`));
