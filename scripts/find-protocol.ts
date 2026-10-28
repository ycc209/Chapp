/**
 * Asks Muse Spark to find a kit's protocol on the web, the way Chapp's findProtocol will.
 *
 *   node --env-file-if-exists=.env scripts/find-protocol.ts "請搜尋 Abcam ab287843 3T3-L1 Differentiation Kit，給我 Differentiation Induction 的 protocol"
 *
 * Prints the answer, what it searched for and the pages it cited. Saves the full reply to data/smoke/ (git-ignored).
 */
import { mkdirSync, writeFileSync } from 'node:fs';

const base = 'https://api.meta.ai/v1';
const key = process.env.MODEL_API_KEY;
if (!key) {
  console.error('MODEL_API_KEY is not set. Put it in .env (see .env.example), then run this again.');
  process.exit(1);
}
const ask = process.argv.slice(2).join(' ').trim();
if (!ask) {
  console.error('Usage: node --env-file-if-exists=.env scripts/find-protocol.ts "<kit and the part of the protocol you need>"');
  process.exit(1);
}

const instructions = `You are Chapp, a lab companion at the bench. The user names a kit and the part of its protocol they need.
1. Search the web for the vendor's own manual or protocol book for that exact catalog number. Prefer the newest version on the vendor's site.
2. Answer only from that document. Give the requested section's steps in order, with every volume, concentration, time, temperature and medium exactly as written, plus any reagent preparation those steps depend on.
3. Name the document, its version or date, and cite its URL. If you cannot find the vendor's document, say so; never fill in steps from memory or from another kit.
Reply in the user's language, but keep reagent names, units and numbers as the manual writes them.`;

type Json = Record<string, any>;

const started = Date.now();
const res = await fetch(`${base}/responses`, {
  method: 'POST',
  headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    model: 'muse-spark-1.3',
    tools: [{ type: 'web_search' }],
    input: [{ role: 'system', content: instructions }, { role: 'user', content: ask }],
  }),
});
const raw = await res.text();
if (!res.ok) {
  console.error(`${res.status} ${raw.slice(0, 500)}`);
  process.exit(1);
}
const r: Json = JSON.parse(raw);
const seconds = ((Date.now() - started) / 1000).toFixed(1);

const items: Json[] = r.output ?? [];
const said = (o: Json): Json[] => (o.content ?? []).filter((c: Json) => c.type === 'output_text');
// Muse Spark narrates its search in "commentary" messages before the answer; Chapp can show those as live status.
const messages = items.filter(o => o.type === 'message');
const progress = messages.filter(o => o.phase === 'commentary').flatMap(said).map(c => c.text);
const parts = messages.filter(o => o.phase !== 'commentary').flatMap(said);
const text = parts.map(c => c.text).join('');
const searches = items.filter(o => o.type === 'web_search_call').map(o => o.action?.query ?? o.action?.queries?.join(' | ') ?? o.action?.type ?? '?');
const cited = [...new Set(parts.flatMap(c => c.annotations ?? []).filter((a: Json) => a.type === 'url_citation').map((a: Json) => a.url))];

const out = new URL('../data/smoke/', import.meta.url);
mkdirSync(out, { recursive: true });
const file = new URL(`find-protocol-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, out);
writeFileSync(file, JSON.stringify({ ask, seconds: Number(seconds), response: r }, null, 2));

console.log(`Muse Spark answered in ${seconds} s; ${searches.length} search(es), ${cited.length} cited page(s).`);
progress.forEach(p => console.log(`  progress: ${p}`));
searches.forEach((q, i) => console.log(`  search ${i + 1}: ${q}`));
cited.forEach(url => console.log(`  cited: ${url}`));
if (r.usage) console.log(`  usage: ${JSON.stringify(r.usage)}`);
console.log(`\n${text || '(no text in the reply)'}\n`);
console.log(`Full reply: data/smoke/${file.pathname.split('/').pop()}`);
