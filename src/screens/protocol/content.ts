import type { Component, Concentration, Note, Procedure, Protocol, Step } from '../../../shared/protocol.ts';

/**
 * What the protocol screen says, worded from the protocol document (chapp.protocol/1). Pure functions, so the words
 * can be checked without a browser; nothing here adds a number or a fact the document does not hold.
 */

/**
 * What the Overview's top (the answer and At a glance) needs: a whole protocol, or what Chapp read of a new manual
 * first (shared/ai.ts ProtocolIntro) while its steps are still being read.
 */
export type Preview = Pick<Protocol, 'title' | 'summary'> & {
  source: Pick<Protocol['source'], 'title' | 'publisher' | 'docId' | 'revision' | 'url'>;
  overview: Pick<Protocol['overview'], 'steps' | 'expected' | 'cite'>;
};

/** "Pierce BCA Protein Assay" → "Pierce BCA": the name Chapp uses in its status line and answers. */
export function shortName(p: Pick<Protocol, 'title'>): string {
  return p.title.replace(/\s+(?:protein\s+)?assay(?:\s+kit)?$/i, '').trim() || p.title;
}

/** "Albumin Standard (BSA)" → { name: "Albumin Standard", aside: "BSA" }; names without brackets stay whole. */
export function splitName(name: string): { name: string; aside: string | null } {
  const m = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(name);
  return m ? { name: m[1], aside: m[2] } : { name, aside: null };
}

export function formatConcentration(c: Concentration): string {
  return `${c.value.toLocaleString('en-US')} ${c.unit}`;
}

export function formatTemperature(t: { value: number; max?: number; unit: string }): string {
  return t.max === undefined ? `${t.value} ${t.unit}` : `${t.value}–${t.max} ${t.unit}`;
}

/** The procedure the run uses: the one asked for, else the document's default. */
export function procedureFor(p: Protocol, id?: string | null): Procedure {
  return p.procedures.find(x => x.id === id) ?? p.procedures.find(x => x.id === p.defaults.procedure) ?? p.procedures[0];
}

/** Every bottle the run needs: the kit's own, then what the user brings (the diluent). */
export function bottles(p: Protocol): Component[] {
  return [...p.components.filter(c => c.suppliedBy === 'kit'), ...p.components.filter(c => c.suppliedBy === 'user')];
}

/**
 * Chapp's first answer about the kit: "**Pierce BCA** is a colorimetric total-protein assay." plus the summary's next
 * sentence. A summary written as "Kind: what happens. More." reads as that sentence; any other is shown as written.
 */
export function answer(p: Pick<Protocol, 'title' | 'summary'>): { lead: string; text: string } {
  const lead = shortName(p);
  const m = /^([^:.]+):\s*(.+)$/s.exec(p.summary);
  if (!m) return { lead, text: `. ${p.summary}` };
  const kind = m[1].trim();
  const [first] = sentences(m[2]);
  const article = /^[aeiou]/i.test(kind) ? 'an' : 'a';
  return { lead, text: ` is ${article} ${lowerFirst(kind)}.${first ? ` ${upperFirst(first)}` : ''}` };
}

/** The Principle section: the rest of the summary, then the document's notes on how the reading becomes a number. */
export function principle(p: Protocol): { aside: string; paragraphs: string[] } {
  const m = /^[^:.]+:\s*(.+)$/s.exec(p.summary);
  const rest = m ? sentences(m[1]).slice(1) : [];
  const how = (p.analysis?.notes ?? []).filter(n => n.kind === 'info').map(n => n.text);
  const r = p.analysis?.readout;
  return { aside: r ? `${r.value} ${r.unit}` : '', paragraphs: [...rest.map(upperFirst), ...how] };
}

/** "In the kit": the kit's bottles, how to store them, and what else the run needs. */
export function kitContents(p: Protocol, procedureId?: string | null) {
  const kit = p.components.filter(c => c.suppliedBy === 'kit');
  const items = kit.map(c => {
    const { name, aside } = splitName(c.name);
    const detail = [aside, c.concentration && formatConcentration(c.concentration)].filter(Boolean).join(' · ');
    return { id: c.id, name, detail: detail || null };
  });
  const storage = new Set(kit.map(c => (c.storage ? formatTemperature(c.storage) : '')));
  const store = storage.size === 1 && !storage.has('') ? `Store them at ${[...storage][0]}.` : '';
  return { items, store, need: (photographed: boolean) => alsoNeed(p, procedureId, photographed) };
}

/**
 * "You also need a diluent (same buffer as your samples), a 96-well plate, a plate shaker, a 37 °C incubator and a
 * plate reader." The user's own bottles drop out once they are photographed (they are in the list above then), and
 * the pipette goes without saying at a bench, as in the design.
 */
export function alsoNeed(p: Protocol, procedureId: string | null | undefined, photographed: boolean): string {
  const proc = procedureFor(p, procedureId);
  const ids = [...new Set([...(proc.prep ?? []), ...proc.steps].flatMap(s => s.equipment ?? []))];
  const gear = ids
    .map(id => p.equipment.find(e => e.id === id))
    .filter(e => e !== undefined && e.icon !== 'pipette')
    .map(e => {
      const setting = e!.setting && /°C$/.test(e!.setting) ? `${e!.setting} ` : '';
      return withArticle(setting + lowerFirst(e!.name));
    });
  const own = photographed ? [] : p.components.filter(c => c.suppliedBy === 'user').map(c => withArticle(lowerFirst(c.name)));
  // "96-well" stays on one line (a non-breaking hyphen), as in the design.
  const all = [...own, ...gear].map(x => x.replace(/(\d)-/g, '$1\u2011'));
  if (!all.length) return '';
  return `You also need ${all.length === 1 ? all[0] : `${all.slice(0, -1).join(', ')} and ${all[all.length - 1]}`}.`;
}

/** The second line under a photographed bottle: "Kit · store at 15–30 °C", "Kit · BSA, 2 mg/mL", "Yours · same buffer…". */
export function bottleDetail(c: Component): string {
  const { aside } = splitName(c.name);
  if (c.suppliedBy === 'user') return `Yours${aside ? ` · ${aside}` : ''}`;
  if (c.concentration) return `Kit · ${[aside, formatConcentration(c.concentration)].filter(Boolean).join(', ')}`;
  if (c.storage) return `Kit · store at ${formatTemperature(c.storage)}`;
  return 'Kit';
}

/** The steps as read at the bench, one line each, with where each is written in the source. */
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * A step's numbers in a few words, from what the step does, never from the model's prose: "9 standards", "50 : 1",
 * "25 µL per well", "37 °C · 30 min · Covered", "562 nm". At most three.
 */
export function stepFacts(p: Protocol, s: Step): string[] {
  const facts: string[] = [];
  const curve = s.standardCurve && p.standardCurves.find(c => c.id === s.standardCurve);
  if (curve) facts.push(`${curve.points.length} standards`);
  const mix = s.mix && p.mixes.find(m => m.id === s.mix);
  if (mix) facts.push(mix.parts.map(x => x.parts).join(' : '));
  for (const a of s.add ?? []) facts.push(`${a.volume.value} ${a.volume.unit} per ${a.per}`);
  if (s.timer) {
    const t = s.timer.temperature;
    if (t) facts.push(t.max === undefined ? `${t.value} °C` : `${t.value}–${t.max} °C`);
    facts.push(`${s.timer.label === 'Incubate' ? '' : `${s.timer.label} `}${s.timer.duration.value} ${s.timer.duration.unit}`);
    if (s.timer.covered) facts.push('covered');
  }
  // A reading's wavelength, from the instrument the step uses ("562 nm").
  for (const id of s.equipment ?? []) {
    const setting = p.equipment.find(e => e.id === id)?.setting;
    if (setting && /\bnm\b/.test(setting) && !facts.includes(setting)) facts.push(setting);
  }
  return facts.slice(0, 3).map(capital);
}

export function stepLines(p: Protocol, procedureId?: string | null) {
  return procedureFor(p, procedureId).steps.map(s => ({
    id: s.id,
    title: s.title,
    text: s.key,
    page: s.cite.page,
    stage: s.stage,
    facts: stepFacts(p, s),
    // The manual's own words for the step, or where they are when it is a table or a figure.
    original: s.cite.quote ?? `See ${s.cite.table ?? s.cite.figure} in the manual.`,
    // What the user should see when it works: shown with the step, apart from what to do.
    expected: (s.notes ?? []).filter(n => n.kind === 'expected').map(n => n.text),
  }));
}

/** Where Start goes: reagent prep first when the procedure has some and the run has not begun, else step 1. */
export const startPath = (p: Protocol, procedureId: string | null | undefined, started: boolean) =>
  !started && (procedureFor(p, procedureId).prep ?? []).length > 0 ? '/run/prep' : '/run/1';

/** Reagent prep: what to get ready before the experiment, in the step cards' words and numbers. */
export function prepLines(p: Protocol, procedureId?: string | null) {
  return (procedureFor(p, procedureId).prep ?? []).map(s => ({ id: s.id, title: s.title, text: s.key, page: s.cite.page, facts: stepFacts(p, s) }));
}

const NOTE_ORDER: Record<Note['kind'], number> = { caution: 0, tip: 1, expected: 2, info: 3 };

/** Precautions: the document's assay-wide notes and its advice on fitting the curve, cautions first. */
export function precautions(p: Protocol): { text: string; page: number }[] {
  const notes = [...p.notes, ...(p.analysis?.notes ?? []).filter(n => n.kind !== 'info')];
  return notes
    .map((n, i) => ({ n, i }))
    .sort((a, b) => NOTE_ORDER[a.n.kind] - NOTE_ORDER[b.n.kind] || a.i - b.i)
    .map(({ n }) => ({ text: n.text, page: n.cite.page }));
}

/** "Thermo Fisher Scientific · p. 1", or with no page "Thermo Fisher Scientific · MAN0011430 rev. D". */
export function sourceLine(p: Pick<Preview, 'source'>, page?: number): string {
  const s = p.source;
  return page ? `${s.publisher} · p. ${page}` : `${s.publisher} · ${s.docId} rev. ${s.revision}`;
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => (/[.!?]$/.test(s) ? s : `${s}.`));
}

function lowerFirst(s: string) {
  // Keep acronyms and names: "BSA", "PBS", "96-well".
  return /^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s;
}

function upperFirst(s: string) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function withArticle(phrase: string) {
  // "an incubator", but "a 96-well plate", "a 37 °C incubator".
  return `${/^[aeiou]/i.test(phrase) ? 'an' : 'a'} ${phrase}`;
}
