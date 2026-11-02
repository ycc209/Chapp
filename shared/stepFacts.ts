import type { Procedure, Protocol, Step } from './protocol.ts';

/**
 * What a step's picture shows, from the protocol alone: what the step handles (its vials, the parts of its mix, what
 * goes into the plate, the dish of cells), its numbers and the colours the protocol gives. The card's own simple
 * picture (src/screens/protocol/StepPicture.tsx) is drawn from it; so is the one Muse Spark writes (server/ai/picture.ts),
 * which gets these facts and nothing it could invent from.
 */

const COLOURS: [RegExp, string][] = [
  [/purple|violet|紫/i, '#7b3fbf'],
  [/blue|藍|蓝/i, '#2f6fd6'],
  [/green|綠|绿/i, '#3aa76d'],
  [/yellow|黃|黄/i, '#e3bd1b'],
  [/orange|橙|橘/i, '#ef8a24'],
  [/\bred\b|紅|红/i, '#d23b3b'],
  [/pink|粉紅/i, '#e86aa6'],
  [/brown|棕|褐/i, '#8a5a2b'],
];
const COLOUR_WORDS = new RegExp(COLOURS.map(([re]) => re.source).join('|'), 'i');

/** The first colour a sentence names, as a hex colour; null when it names none. */
export function colourIn(text: string): string | null {
  const m = COLOUR_WORDS.exec(text);
  return m ? COLOURS.find(([re]) => re.test(m[0]))![1] : null;
}

/** The first colour word a sentence uses ("green"), as it says it; null when it names none. */
export function colourWordIn(text: string): string | null {
  return COLOUR_WORDS.exec(text)?.[0].toLowerCase() ?? null;
}

/** The procedure's mix colour as the protocol says it: in its notes, or in the summary just before its name. */
export function mixColour(p: Protocol, proc: Procedure): string | null {
  const m = proc.mix ? p.mixes.find(x => x.id === proc.mix) : undefined;
  if (!m) return null;
  for (const n of m.notes) {
    const c = colourIn(n.text);
    if (c) return c;
  }
  const near = new RegExp(`(${COLOUR_WORDS.source})\\s+(?:\\S+\\s+){0,2}?(?:${esc(m.name)}|${esc(m.short || m.name)}|reagent)`, 'i').exec(p.summary);
  return near ? colourIn(near[0]) : null;
}
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export type PrepKind = 'warm' | 'spin' | 'dilute' | 'dissolve' | 'grow';
const PREP: [RegExp, PrepKind][] = [
  [/room temperature|warm|equilibrat|thaw|室溫|回溫|解凍/i, 'warm'],
  [/centrifug|spin|離心/i, 'spin'],
  [/dilut|稀釋/i, 'dilute'],
  [/reconstitut|dissolv|resuspend|溶解|回溶/i, 'dissolve'],
  [/grow|culture|seed|confluen|plate the cells|培養/i, 'grow'],
];
/** What a preparing step does, by its title first (its key may mention other things), then its words. */
export const prepKind = (step: Pick<Step, 'title' | 'key'>): PrepKind | null =>
  PREP.find(([re]) => re.test(step.title))?.[1] ?? PREP.find(([re]) => re.test(step.key))?.[1] ?? null;

export type StepFacts = {
  stage: Step['stage'];
  title: string;
  /** What to do, in Chapp's words. */
  does: string;
  /** Where it happens: a 96-well plate, tubes, or a dish of cells. */
  vessel: 'plate' | 'tubes' | 'dish';
  /** The dilution table's vials, in order: label, concentration, blank. */
  vials?: { label: string; concentration: string; blank: boolean }[];
  /** The mix made here: its name, each part (name and share), and its colour if the protocol says one. */
  mix?: { name: string; parts: { name: string; parts: number }[]; colour: string | null };
  /** What goes in, and how much. */
  adds?: { what: string; volume: string; per: string }[];
  /** For a preparing step: what it does. */
  prep?: PrepKind | null;
  /** The bottles it names. */
  bottles?: string[];
  equipment?: string[];
  timer?: string;
  /** What the user should see, as the protocol says it. */
  expected?: string[];
};

const qty = (v: { value: number; unit: string }) => `${v.value} ${v.unit}`;

export function stepFacts(p: Protocol, proc: Procedure, step: Step): StepFacts {
  const vessel = proc.format === 'microplate' ? 'plate' : proc.format === 'cells' ? 'dish' : 'tubes';
  const facts: StepFacts = { stage: step.stage, title: step.title, does: step.key, vessel };
  const curve = p.standardCurves.find(c => c.id === (step.standardCurve ?? (step.stage === 'standards' ? proc.standardCurve : undefined)));
  if (curve) facts.vials = curve.points.map(pt => ({ label: pt.id, concentration: qty(pt.concentration), blank: Boolean(pt.blank) }));
  const m = p.mixes.find(x => x.id === (step.mix ?? (step.stage === 'mix' ? proc.mix : undefined)));
  if (m) facts.mix = { name: m.name, parts: m.parts.map(part => ({ name: p.components.find(c => c.id === part.component)?.name ?? part.component, parts: part.parts })), colour: mixColour(p, proc) };
  if (step.add?.length) {
    const mixName = proc.mix ? p.mixes.find(x => x.id === proc.mix)?.name : undefined;
    facts.adds = step.add.map(a => ({
      what: a.what === 'standards-and-samples' ? 'standards and samples' : a.what === 'mix' ? `${mixName ?? 'the mix'}${mixColour(p, proc) ? ` (${colourName(mixColour(p, proc)!)})` : ''}` : (p.components.find(c => c.id === a.ref)?.name ?? a.ref ?? ''),
      volume: qty(a.volume),
      per: a.per,
    }));
  }
  if (step.stage === 'prepare') facts.prep = prepKind(step);
  const words = `${step.title} ${step.key}`.toLowerCase();
  const named = p.components.filter(c => words.includes(c.name.toLowerCase()) || words.includes(c.name.split(/[\s,(]/)[0]!.toLowerCase())).map(c => c.name);
  if (named.length) facts.bottles = named.slice(0, 4);
  const eq = (step.equipment ?? []).map(id => p.equipment.find(e => e.id === id)?.name).filter((n): n is string => Boolean(n));
  if (eq.length) facts.equipment = eq;
  if (step.timer) facts.timer = `${qty(step.timer.duration)}${step.timer.temperature ? ` at ${step.timer.temperature.value} °C` : ''}`;
  const expected = (step.notes ?? []).filter(n => n.kind === 'expected').map(n => n.text);
  if (expected.length) facts.expected = expected;
  return facts;
}

const NAMES: Record<string, string> = { '#7b3fbf': 'purple', '#2f6fd6': 'blue', '#3aa76d': 'green', '#e3bd1b': 'yellow', '#ef8a24': 'orange', '#d23b3b': 'red', '#e86aa6': 'pink', '#8a5a2b': 'brown' };
export const colourName = (hex: string) => NAMES[hex] ?? hex;
