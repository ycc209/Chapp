import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { ratioOf } from '../../shared/calc.ts';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAssay, Protocol, type ProtocolSummary } from '../../shared/protocol.ts';
import { formatVolume, isPlannable, unitsProblem } from '../../shared/calc.ts';
import { runSetup } from '../../src/components/lab/model.ts';
import type { ConverseContext, Expression, FoundProtocol, Source } from '../../shared/ai.ts';
import { slug, withId } from './import.ts';

/**
 * The protocols the AI side knows about. The BCA document is built from the vendor's manual and stays local
 * (data/ is git-ignored), so the few facts the mock needs also live here as constants: a clean checkout still runs.
 */

/** Where protocol documents live: hand-made ones and those read from a manual (server/ai/import.ts) alike. */
export const PROTOCOLS_DIR = fileURLToPath(new URL('../../data/protocols/', import.meta.url));
/** Where the manuals Chapp read itself are kept: data/sources/<id>/manual.pdf. */
export const MANUALS_DIR = fileURLToPath(new URL('../../data/sources/', import.meta.url));
const cache = new Map<string, Protocol | null>();

/** The protocol document with this id, or null when it is not on this machine (or does not validate). */
export function loadProtocol(id: string, dir = PROTOCOLS_DIR): Protocol | null {
  if (!/^[a-z0-9-]+$/.test(id)) return null;
  const file = join(dir, `${id}.json`);
  const key = `${dir}\0${id}`;
  // A document not here yet may be imported later, so only what was found is remembered.
  if (!cache.has(key)) {
    if (!existsSync(file)) return null;
    let parsed: ReturnType<typeof Protocol.safeParse> | null = null;
    try {
      parsed = Protocol.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    } catch {
      // Not JSON: not a protocol.
    }
    cache.set(key, parsed?.success ? parsed.data : null);
  }
  return cache.get(key) ?? null;
}

/** Every protocol document on this machine, hand-made or imported (none on a clean checkout, where data/ is missing). */
export function knownProtocols(dir = PROTOCOLS_DIR): Protocol[] {
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.json'));
  } catch {
    // No data/ on a clean checkout.
  }
  return files.map(f => loadProtocol(f.slice(0, -5), dir)).filter((p): p is Protocol => p !== null);
}

/** Every protocol on this machine as Library lists it (GET /api/protocols), the one read or changed last first. */
export function protocolList(dir = PROTOCOLS_DIR): ProtocolSummary[] {
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.json'));
  } catch {
    // No data/ on a clean checkout.
  }
  const list: ProtocolSummary[] = [];
  for (const f of files) {
    const id = f.slice(0, -5);
    const p = loadProtocol(id, dir);
    if (!p) continue;
    const procedure = p.procedures.find(x => x.id === p.defaults.procedure) ?? p.procedures[0]!;
    list.push({ id, title: p.title, kit: p.kit.name, catalogs: p.kit.variants.map(v => v.catalog), procedure: procedure.name, steps: procedure.steps.length, updated: statSync(join(dir, f)).mtimeMs });
  }
  return list.sort((a, b) => b.updated - a.updated);
}

/** The protocol read from exactly this file (same SHA-256), so the same manual is never read twice. */
export const protocolBySha = (sha256: string, dir = PROTOCOLS_DIR) => knownProtocols(dir).find(p => p.source.sha256 === sha256);

/**
 * Keeps a protocol Chapp read from a manual (server/ai/import.ts) as <dir>/<id>.json, served by /api/protocols/:id
 * like the hand-made ones, with the PDF itself in <manuals>/<id>/manual.pdf. It never replaces a hand-made document or
 * another manual's: those keep their id and this one takes the next free one ("…-ab287843", "…-2"); a new reading of
 * the same file replaces the old. Returns the protocol under the id it was saved as.
 */
export function saveImported(protocol: Protocol, pdf: Uint8Array, opts: { dir?: string; manuals?: string } = {}): Protocol {
  const dir = opts.dir ?? PROTOCOLS_DIR;
  const manuals = opts.manuals ?? MANUALS_DIR;
  const free = (id: string) => {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || id.length > 80) return false;
    if (!existsSync(join(dir, `${id}.json`))) return true;
    const old = loadProtocol(id, dir);
    return Boolean(old?.imported && old.source.sha256 === protocol.source.sha256);
  };
  const catalog = slug(protocol.kit.variants[0]?.catalog ?? '');
  const ids = [protocol.id, ...(catalog && !protocol.id.endsWith(catalog) ? [`${protocol.id}-${catalog}`] : []), ...Array.from({ length: 50 }, (_, i) => `${protocol.id}-${i + 2}`)];
  const id = ids.find(free);
  if (!id) throw new Error(`No free id for "${protocol.id}"`);
  const saved = withId(protocol, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), `${JSON.stringify(saved, null, 2)}\n`);
  mkdirSync(join(manuals, id), { recursive: true });
  writeFileSync(join(manuals, id, 'manual.pdf'), pdf);
  cache.set(`${dir}\0${id}`, saved);
  return saved;
}

/** The PDF Chapp keeps for an imported protocol (data/sources/<id>/manual.pdf), or null. */
export function manualFile(id: string, manuals = MANUALS_DIR): string | null {
  if (!/^[a-z0-9-]+$/.test(id)) return null;
  const file = join(manuals, id, 'manual.pdf');
  return existsSync(file) ? file : null;
}

/**
 * The protocol on this machine that a found manual is, so the app opens that one rather than the run's last: the same
 * document (its id, "MAN0011430", in the link or the title, or the same file), else the same kit by catalog number.
 */
export function localProtocolId(found: Pick<FoundProtocol, 'document' | 'kit'>, dir = PROTOCOLS_DIR): string | undefined {
  const docs = knownProtocols(dir);
  const file = (url: string) => (URL.parse(url)?.pathname.split('/').pop() ?? '').toLowerCase();
  const doc = found.document;
  const same = doc
    ? docs.find(p => (p.source.docId !== '' && `${doc.url} ${doc.title}`.toLowerCase().includes(p.source.docId.toLowerCase())) || (file(doc.url) !== '' && file(doc.url) === file(p.source.url)))
    : undefined;
  if (same) return same.id;
  const catalog = found.kit?.catalog.trim().toUpperCase();
  return catalog ? docs.find(p => p.kit.variants.some(v => v.catalog.toUpperCase() === catalog))?.id : undefined;
}

/** What Chapp says about the BCA kit without its JSON: the same values as data/protocols/pierce-bca.json. */
export const BCA = {
  id: 'pierce-bca',
  name: 'Pierce BCA Protein Assay Kit',
  vendor: 'Thermo Scientific',
  catalogs: ['23225', '23227', 'A65453'],
  source: {
    title: 'Pierce BCA Protein Assay Kit User Guide',
    publisher: 'Thermo Fisher Scientific',
    docId: 'MAN0011430',
    revision: 'D',
    date: '2026-06-18',
    url: 'https://documents.thermofisher.com/TFS-Assets/LSG/manuals/MAN0011430_Pierce_BCA_Protein_Asy_UG.pdf',
  },
  overview: [
    'Mix Reagents A and B 50:1 to create Working Reagent',
    '25 µL sample or standards + 200 µL of Working Reagent',
    'Incubate for 30 mins. at 37°C',
    'Read at 562 nm',
  ],
};

/** The BCA facts from the local document when it is there, else the constants above. */
export function bcaFacts() {
  const doc = loadProtocol(BCA.id);
  if (!doc) return BCA;
  const { title, publisher, docId, revision, date, url } = doc.source;
  return {
    id: doc.id,
    name: doc.kit.name,
    vendor: doc.kit.vendor,
    catalogs: doc.kit.variants.map(v => v.catalog),
    source: { title, publisher, docId, revision, date, url },
    overview: doc.overview.steps,
  };
}

/** The manual a protocol was read from, as a Source (one per cited page when pages are given). */
export function manualSources(protocol: Protocol, pages: number[] = []): Source[] {
  const { url, title } = protocol.source;
  // An uploaded manual has no address on the web to point at.
  if (!/^https?:\/\//.test(url)) return [];
  const valid = [...new Set(pages)].filter(p => Number.isInteger(p) && p >= 1 && p <= protocol.source.pages);
  return valid.length ? valid.map(page => ({ url, title, page })) : [{ url, title }];
}

/**
 * The run's own numbers: the only run-specific figures Chapp may say. They are the app's (runSetup, what Plan and Run
 * show: the standards made as planned, the kit's table run like the samples unless `plan` says otherwise, and the
 * working reagent to make), so Chapp never says another amount than the screen. Null when they cannot be worked out
 * or do not fit one plate.
 */
export function runNumbers(
  protocol: Protocol,
  procedureId: string,
  samples: number,
  replicates: number,
  plan: Pick<ConverseContext, 'standards' | 'standardReplicates'> = {},
) {
  try {
    const { plate, reagent, series } = runSetup(protocol, {
      procedure: procedureId,
      samples,
      replicates,
      standardReplicates: plan.standardReplicates || replicates,
      standards: plan.standards ?? 'kit',
    });
    if (!plate.fits) return null;
    const name = (id: string) => protocol.components.find(c => c.id === id)?.name ?? id;
    return {
      vials: series.vials.length,
      wells: plate.wells,
      workingReagent: formatVolume(reagent.make),
      parts: reagent.parts.map(p => `${name(p.component)} ${formatVolume(p.volume)}`),
      standardsStock: formatVolume(series.stock),
      standardsDiluent: formatVolume(series.diluent),
    };
  } catch {
    return null;
  }
}

/** How the run's standards are made (RunState.standards), in the words Plan-Ask uses. */
export const WAYS = { kit: "the kit's dilution table", halve: 'halving from the top', five: 'five standards', ready: 'already made' } as const;

/**
 * The protocol's key facts in a few compact lines for a model's prompt: the procedure's steps by index (the app's
 * `step`), volumes, standards, notes with their pages, and this run's computed numbers.
 */
export function protocolBrief(protocol: Protocol, context: ConverseContext): string {
  const procedure =
    protocol.procedures.find(p => p.id === context.procedure) ?? protocol.procedures.find(p => p.id === protocol.defaults.procedure) ?? protocol.procedures[0];
  const s = protocol.source;
  const v = (x: { value: number; unit: string }) => `${x.value} ${x.unit}`;
  const lines = [
    `Protocol "${protocol.id}": ${protocol.title}. Source: ${s.title}, ${s.publisher} ${s.docId} rev. ${s.revision} (${s.date}), ${s.pages} pages.`,
    `Kit: ${protocol.kit.name} (${protocol.kit.vendor}), catalog ${protocol.kit.variants.map(x => x.catalog).join(' / ')}.`,
    isAssay(procedure)
      ? `${procedure.name} procedure: ${v(procedure.sample)} sample or standard + ${v(procedure.mixPerSample)} working reagent per well (${ratioOf(procedure)}); range ${procedure.range.min}–${procedure.range.max} ${procedure.range.unit}.`
      : `${procedure.name} procedure (${procedure.format}): no standards, plate or reagent amounts to plan.`,
    ...((procedure.prep ?? []).length
      ? [
          'Reagent prep, done before the experiment and not one of its steps (id, title, what to do, page):',
          ...procedure.prep!.map(step => `- ${step.id}, ${step.title}: ${step.key} (p.${step.cite.page})`),
        ]
      : []),
    'Steps (index: id, title, what to do, page):',
    ...procedure.steps.map((step, i) => {
      const timer = step.timer ? `; timer ${step.timer.label} ${v(step.timer.duration)}${step.timer.temperature ? ` at ${step.timer.temperature.value} °C` : ''}` : '';
      return `${i}: ${step.id}, ${step.title}: ${step.key}${timer} (p.${step.cite.page})`;
    }),
  ];
  const name = (id: string) => protocol.components.find(c => c.id === id)?.name ?? id;
  for (const mix of protocol.mixes) {
    lines.push(`${mix.name}: ${mix.parts.map(p => `${p.parts} part${p.parts > 1 ? 's' : ''} ${name(p.component)}`).join(' + ')} (p.${mix.cite.page}).`);
  }
  const curve = protocol.standardCurves.find(c => c.id === procedure.standardCurve);
  if (curve) lines.push(`Standards ${curve.points.map(p => `${p.id} ${p.concentration.value}`).join(', ')} ${curve.points[0].concentration.unit} (I is the blank; p.${curve.cite.page}).`);
  if (protocol.analysis) lines.push(`Read at ${protocol.analysis.readout.value} nm.`);
  const notes = [
    ...[...(procedure.prep ?? []), ...procedure.steps].flatMap(step => (step.notes ?? []).map(n => ({ ...n, at: step.id }))),
    ...protocol.mixes.flatMap(m => m.notes.map(n => ({ ...n, at: m.id }))),
    ...protocol.components.flatMap(c => (c.notes ?? []).map(n => ({ ...n, at: c.id }))),
    ...(protocol.analysis?.notes ?? []).map(n => ({ ...n, at: 'analysis' })),
    ...protocol.notes.map(n => ({ ...n, at: 'general' })),
  ];
  // What the user should see is a result to look for, not a step.
  lines.push('Notes:', ...notes.map(n => `- ${n.at}${n.kind === 'expected' ? ' (what the user should see)' : ''}, p.${n.cite.page}: ${n.text}`));
  if (protocol.overview.expected?.length) lines.push(`Expected result (not a step): ${protocol.overview.expected.join('; ')} (p.${protocol.overview.cite.page}).`);

  if (context.screen === 'run-prep') lines.push('The user is on reagent prep, getting the reagents ready before step 1.');
  if (context.step !== undefined) {
    // The run screen's steps are the procedure's without the analysis, so the index is the same; its title is shorter.
    const step = procedure.steps[context.step];
    const title = context.stepTitle && step && context.stepTitle !== step.title ? `"${context.stepTitle}" (${step.id}, ${step.title})` : step && `${step.id}, ${step.title}`;
    lines.push(step ? `The user is on step ${context.step}: ${title}.` : `The user is past the last step.`);
  }
  if (isAssay(procedure) && !isPlannable(protocol, procedure)) {
    lines.push(`Chapp cannot work out this run's amounts (${unitsProblem(protocol, procedure)}): say only the manual's numbers as printed, never a computed amount.`);
  } else if (context.samples && context.replicates && isAssay(procedure)) {
    const sr = context.standardReplicates || context.replicates;
    const run = runNumbers(protocol, procedure.id, context.samples, context.replicates, context);
    const made = context.standards === 'ready' ? 'the standards are already made' : `standards use ${run?.standardsStock} BSA stock and ${run?.standardsDiluent} diluent`;
    lines.push(
      run
        ? `This run (computed by the app): ${context.samples} samples × ${context.replicates} replicates and ${run.vials} standards (${WAYS[context.standards ?? 'kit']}) × ${sr} = ${run.wells} wells; working reagent ${run.workingReagent} (${run.parts.join(' + ')}); ${made}. For this run's amounts, say these, not the manual's full-table volumes.`
        : `This run: ${context.samples} samples × ${context.replicates} replicates does not fit one 96-well plate.`,
    );
    // The card the user changed by hand under the last answer: what "is that enough?" is about now.
    const shown = context.shown;
    const card = shown && runNumbers(protocol, procedure.id, shown.samples, shown.replicates, { ...context, standardReplicates: shown.replicates });
    if (shown)
      lines.push(
        card
          ? `The card the user changed by hand (computed by the app): ${shown.samples} samples × ${shown.replicates} = ${card.wells} wells; working reagent ${card.workingReagent} (${card.parts.join(' + ')}). The user's next question is about this card: answer for it, and give its samples and replicates to the card you draw.`
          : `The card the user changed by hand: ${shown.samples} samples × ${shown.replicates} does not fit one 96-well plate.`,
      );
  }
  return lines.join('\n');
}

// ─── Answers from the manual ─────────────────────────────────────────────────────────────────────────────────────

// Words that say nothing about the bench: the question's frame ("what if", "should I") and small words.
const STOP = new Set(
  ('a an the i it its if what whats when why how where which who whom is are was were be been being do does did done can could ' +
    'should would will shall may might must to of in on at for with from by and or but so then than that this these those my me ' +
    'we us you your our they them their there here about as into up out not no yes ok okay chapp please just get got go goes ' +
    'going happen happens happened mean means some any all also still now run help kit use').split(' '),
);

/** A few words the manual says differently: "how long" is in minutes, hours or days; cloudy is turbid. */
const ALSO: Record<string, string[]> = {
  long: ['second', 'minute', 'min', 'hour', 'day'],
  cloudy: ['turbidity'],
  turbid: ['cloudy', 'turbidity'],
  wavelength: ['nm'],
  colour: ['color'],
};

/** "added" → "add", "turns" → "turn", "mixes" → "mix": enough stemming to match a question to the manual's words. */
function stem(word: string) {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 4 && /(?:s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

const stems = (text: string) => new Set((text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(w => !STOP.has(w)).map(stem));

/** What the manual says about a question, with where it says it. */
export type ManualAnswer = { say: string; source: Source; expression: Expression };

/**
 * The note or step of the protocol a question is about, found by the words they share (the note's own words and the
 * manual's quote): "What if it turns cloudy when I add B?" → the working reagent's "It turns cloudy when B goes in,
 * then clears to green as you mix. That is normal.", page 2. Notes come before steps; a tie goes to the first. Null
 * when nothing shares at least `least` words with the question (2). Deterministic: the same question, the same answer.
 */
export function answerFromManual(protocol: Protocol, question: string, opts: { procedureId?: string; least?: number } = {}): ManualAnswer | null {
  const asked = stems(question);
  if (asked.size === 0) return null;
  const least = opts.least ?? 2;
  const procedure = protocol.procedures.find(p => p.id === opts.procedureId) ?? protocol.procedures.find(p => p.id === protocol.defaults.procedure) ?? protocol.procedures[0];
  const { url, title } = protocol.source;
  // Each note with what it is about, so "how long does the working reagent keep?" finds the working reagent's note.
  const all = [...(procedure.prep ?? []), ...procedure.steps];
  const notes = [
    ...all.flatMap(step => (step.notes ?? []).map(n => ({ n, about: step.title }))),
    ...protocol.mixes.flatMap(m => m.notes.map(n => ({ n, about: m.name }))),
    ...protocol.components.flatMap(c => (c.notes ?? []).map(n => ({ n, about: c.name }))),
    ...(protocol.analysis?.notes ?? []).map(n => ({ n, about: '' })),
    ...protocol.notes.map(n => ({ n, about: '' })),
  ];
  const FACE: Record<string, Expression> = { expected: 'happy', caution: 'thinking' };
  const candidates = [
    ...notes.map(({ n, about }) => ({ words: `${about} ${n.text} ${n.cite.quote ?? ''}`, say: n.text, cite: n.cite, expression: FACE[n.kind] ?? 'neutral' })),
    ...all.map(step => ({
      words: `${step.title} ${step.key} ${step.cite.quote ?? ''}`,
      say: step.cite.quote && step.cite.quote.length <= 140 ? step.cite.quote : `${step.title}: ${step.key}.`,
      cite: step.cite,
      expression: 'neutral' as Expression,
    })),
  ];
  let best: { score: number; at: (typeof candidates)[number] } | null = null;
  for (const c of candidates) {
    const has = stems(c.words);
    const score = [...asked].filter(w => has.has(w) || ALSO[w]?.some(x => has.has(x))).length;
    if (score >= least && (!best || score > best.score)) best = { score, at: c };
  }
  if (!best) return null;
  const { say, cite, expression } = best.at;
  const source: Source = { url, title, page: cite.page };
  if (cite.quote) source.quote = cite.quote;
  return { say, source, expression };
}
