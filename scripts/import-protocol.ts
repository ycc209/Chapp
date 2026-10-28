/**
 * Reads a kit manual (PDF) into a protocol with Muse Spark, the way the server's importProtocol does, and keeps every
 * raw reply as a fixture for the tests.
 *
 *   node --env-file-if-exists=.env scripts/import-protocol.ts <manual.pdf> <name> [--url <where it came from>] [--compare <protocol.json>]
 *     [--efforts intro=minimal,inventory=low,…] [--text intro,inventory,curves,notes]
 *
 * Writes data/smoke/import/<name>/<call>.json (each reply, with its time) and data/smoke/import/<name>/protocol.json.
 * With --compare it checks the result against a hand-made protocol (server/ai/import-check.ts). Prints timings and
 * the comparison only, never the manual's words. The BCA benchmark:
 *
 *   node --env-file-if-exists=.env scripts/import-protocol.ts data/sources/pierce-bca/MAN0011430_Pierce_BCA_Protein_Asy_UG.pdf \
 *     pierce-bca --url https://documents.thermofisher.com/TFS-Assets/LSG/manuals/MAN0011430_Pierce_BCA_Protein_Asy_UG.pdf \
 *     --compare data/protocols/pierce-bca.json
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { importProtocol, type CallName } from '../server/ai/import.ts';
import { compareProtocols } from '../server/ai/import-check.ts';
import { Protocol } from '../shared/protocol.ts';

const key = process.env.MODEL_API_KEY;
if (!key) {
  console.error('MODEL_API_KEY is not set. Put it in .env (see .env.example), then run this again.');
  process.exit(1);
}
const [pdfPath, name] = process.argv.slice(2);
if (!pdfPath || !name || !/^[a-z0-9-]+$/.test(name)) {
  console.error('Usage: node --env-file-if-exists=.env scripts/import-protocol.ts <manual.pdf> <name> [--url <url>] [--compare <protocol.json>]');
  process.exit(1);
}
const option = (flag: string) => {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const url = option('--url');
const compare = option('--compare');
// --efforts inventory=low,steps=minimal: how hard each call thinks (server/ai/import.ts EFFORTS otherwise).
const efforts = Object.fromEntries((option('--efforts') ?? '').split(',').filter(Boolean).map(kv => kv.split('=')));
// --text intro,inventory,curves,notes: the calls that read the manual as text (server/ai/import.ts TEXT_CALLS otherwise).
const textAt = process.argv.indexOf('--text');
const asText = textAt > 0 ? (process.argv[textAt + 1] ?? '').split(',').filter(Boolean) as CallName[] : undefined;

const out = new URL(`../data/smoke/import/${name}/`, import.meta.url);
mkdirSync(out, { recursive: true });
const pdf = new Uint8Array(readFileSync(pdfPath));

const started = Date.now();
const imported = await importProtocol(pdf, { ...(url ? { url } : {}), filename: pdfPath.split('/').pop() }, {
  apiKey: key,
  efforts,
  ...(asText ? { asText } : {}),
  onIntro: intro => console.log(`  ${((Date.now() - started) / 1000).toFixed(1)} s  intro: ${intro.title}, ${intro.overview.steps.length} lines at a glance, ${intro.procedure.steps.length} steps, ${intro.contents.length} bottles`),
  record: (call, reply, seconds) => writeFileSync(new URL(`${call}.json`, out), JSON.stringify({ seconds, reply }, null, 2)),
  onProgress: line => console.log(`  ${((Date.now() - started) / 1000).toFixed(1)} s  ${line}`),
});
const seconds = (Date.now() - started) / 1000;
writeFileSync(new URL('protocol.json', out), JSON.stringify(imported.protocol, null, 2));
const p = imported.protocol;
console.log(`Read in ${seconds.toFixed(1)} s: ${p.components.length} components, ${p.mixes.length} mixes, ${p.standardCurves.length} curves, ` +
  `${p.procedures.length} procedures (${p.procedures.map(x => `${x.id}: ${x.steps.length} steps`).join(', ')}), ${p.notes.length} notes.`);
console.log(`${imported.problems.length} problem(s)${imported.problems.length ? `:\n  - ${imported.problems.join('\n  - ')}` : '.'}`);

if (compare) {
  const gold = Protocol.parse(JSON.parse(readFileSync(compare, 'utf8')));
  const checks = compareProtocols(gold, p);
  const passed = checks.filter(c => c.ok).length;
  for (const c of checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.what}${c.ok ? '' : `: expected ${c.expected}, got ${c.got}`}`);
  console.log(`${passed} of ${checks.length} checks match.`);
  writeFileSync(new URL('compare.json', out), JSON.stringify({ seconds, passed, total: checks.length, checks }, null, 2));
}
