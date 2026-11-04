/**
 * Writes server/demo/pierce-bca.json: the hand-made Pierce BCA protocol (data/protocols/pierce-bca.json, which stays
 * local because it quotes the vendor's manual) without the manual's words. Every citation keeps its page; its verbatim
 * quote is dropped and the page itself named in its place ("See page 2 in the manual."). The steps, volumes,
 * concentrations, timers and Chapp's own notes stay, so a clean checkout runs the whole app on it with no key and no
 * network (server/ai/protocols.ts seedDemo). Any other text found word for word in the manual is reported, not kept.
 *
 *   node scripts/demo-protocol.ts
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Protocol } from '../shared/protocol.ts';

const root = resolve(import.meta.dirname, '..');
const source = join(root, 'data/protocols/pierce-bca.json');
const out = join(root, 'server/demo/pierce-bca.json');
const pages = join(root, 'data/sources/pierce-bca');

type Json = Record<string, unknown>;
let dropped = 0;

/** A copy with every citation's quote replaced by its page. */
function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (!value || typeof value !== 'object') return value;
  const o: Json = {};
  for (const [k, v] of Object.entries(value as Json)) o[k] = strip(v);
  if (typeof o.page === 'number' && typeof o.quote === 'string') {
    delete o.quote;
    dropped++;
    if (!o.table && !o.figure) o.figure = `page ${o.page}`;
  }
  return o;
}

const doc = strip(JSON.parse(readFileSync(source, 'utf8')));
Protocol.parse(doc);

// Anything else that is the manual's own wording (12 words or more in a row) is listed, to be rewritten by hand.
const manual = existsSync(pages)
  ? readdirSync(pages).filter(f => f.endsWith('.txt')).map(f => readFileSync(join(pages, f), 'utf8')).join('\n').replace(/\s+/g, ' ').toLowerCase()
  : '';
const verbatim: string[] = [];
(function scan(value: unknown, path: string) {
  if (typeof value === 'string') {
    const words = value.toLowerCase().replace(/\s+/g, ' ').split(' ');
    for (let i = 0; i + 12 <= words.length; i++) {
      if (manual.includes(words.slice(i, i + 12).join(' '))) {
        verbatim.push(`${path}: ${value.slice(0, 90)}`);
        break;
      }
    }
  } else if (Array.isArray(value)) value.forEach((v, i) => scan(v, `${path}[${i}]`));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value as Json)) scan(v, `${path}.${k}`);
})(doc, '');

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
console.log(`${out}: ${dropped} quotes dropped${manual ? `, ${verbatim.length} other passages found word for word in the manual` : ' (the manual\'s text is not here to check against)'}`);
for (const v of verbatim) console.log(`  ${v}`);
