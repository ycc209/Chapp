import { BenchScene, wellName, type Action, type Item, type Source } from './bench.ts';
import { ART, wellAt as wellOnPlate } from './benchArt.ts';
import type { Procedure, Protocol, Step } from './protocol.ts';
import { colourIn, colourWordIn, mixColour, prepKind } from './stepFacts.ts';

/**
 * The local composer: each step of a procedure as a bench scene (shared/bench.ts), from the protocol's own fields:
 * its vials, the parts of its mix, what goes into the plate and how much, its timer and temperature, its equipment and
 * the colours it names. One bench carries on from step to step (what a step filled is still full in the next; the
 * working reagent mixed in one is what goes into the wells in the next; the wells turn the colour the protocol says
 * while they incubate). Liquids the protocol gives no colour are drawn clear, as they are, and marked drawn.
 *
 * A model could write the same scenes (bench.ts has the contract); this needs no model and no network.
 */

const CLEAR = '#e3eef8';
const SAMPLE = '#d3e3f3';
const MEDIUM = '#f3b2bf';
const CAPS = ['#2b7de9', '#e0564f', '#f2b134', '#2f9e74', '#7a5af8', '#5b6573'];
const BENCH = 214;

type Cite = { page: number; quote?: string; table?: string; figure?: string };
const said = (field: string, cite?: Cite): Source => ({ from: 'protocol', field, ...(cite ? { page: cite.page } : {}), ...(cite?.quote ? { quote: cite.quote.slice(0, 400) } : {}) });
const drawn = (why: string): Source => ({ from: 'drawn', why });

/**
 * The run's own numbers, where the plan sized them (src/screens/run/model.ts), for the pictures while the protocol
 * plays: the scenes write these instead of the manual's.
 */
export type Sized = {
  /** The mix: what goes in from each bottle, by component id ("9.8 mL"), and what it makes ("10 mL"). */
  mix?: { parts: Record<string, string>; make: string };
  /** The wells the plan fills, column by column. */
  wells?: string[];
  /** The incubation the user chose ("2 h"). */
  incubation?: string;
  /** Drawn big (the run's pictures): the words readable from arm's length, so the layout spreads them. */
  big?: boolean;
};

/** What is on the bench between steps. */
type Bench = { tubes: string[]; mix: { colour: string; level: number; label?: string } | null; wells: Record<string, string>; samples: { colour: string; level: number } | null; flask: { colour: string; level: number } };

/** Where a plate's well is on the bench, for a plate standing at (x, y): the drawn plate's well (benchArt.ts) moved there. */
function wellAt(px: number, py: number, row: number, col: number) {
  const w = wellOnPlate(row, col);
  return { x: px + w.x, y: py + w.y };
}

/** The pipette whose range takes this volume: its plunger colour and what its window shows. */
function pipetteFor(volume?: { value: number; unit: string }) {
  const ul = !volume ? 200 : volume.unit === 'mL' ? volume.value * 1000 : volume.value;
  return { cap: ul <= 20 ? '#9aa6b4' : ul <= 200 ? '#f2c230' : '#2b7de9', text: volume ? String(volume.value) : '200' };
}

/** The colour the protocol says the wells (or the sample) turn: its expected note, else its summary. */
function resultColour(p: Protocol, proc: Procedure): { colour: string; source: Source } | null {
  const notes = proc.steps.flatMap(s => (s.notes ?? []).filter(n => n.kind === 'expected' && colourIn(n.text)).map(n => ({ s, n })));
  const last = notes.at(-1);
  if (last) {
    const all = last.n.text.match(/purple|violet|blue|green|yellow|orange|red|pink|brown|紫|藍|綠|黃/gi) ?? [];
    return { colour: colourIn(all.at(-1) ?? last.n.text)!, source: said(`steps.${last.s.id}.notes`, last.n.cite) };
  }
  const turn = /\bturns?\s+(?:\w+\s+){0,2}?(purple|violet|blue|green|yellow|orange|red|pink|brown)/i.exec(p.summary);
  return turn ? { colour: colourIn(turn[1]!)!, source: said('summary') } : null;
}

/**
 * A name as a label: without its parenthetical, the vendor and a "1000X" in front, and without `drop` at its end (what
 * the kit's other bottles end with too). Whole when it fits a label (22 characters), else its last words.
 */
const shortName = (name: string, drop = '') => {
  let plain = name.replace(/\s*\(.*?\)\s*/g, ' ').replace(/^(?:pierce|thermo|invitrogen|abcam)\s+/i, '').replace(/^\d+(?:\.\d+)?\s*[xX×]\s+/, '').trim();
  if (drop && plain.length > drop.length && plain.toLowerCase().endsWith(drop.toLowerCase())) plain = plain.slice(0, -drop.length).trim();
  if (plain.length <= 22) return plain;
  const words = plain.split(/\s+/);
  // A brand name in front (CellMask, OxiRed: a capital inside the word) with the last word: "CellMask Stain".
  if (words.length > 2 && /^[A-Z][a-z]+[A-Z]\w*$/.test(words[0]!) && `${words[0]} ${words.at(-1)}`.length <= 22) return `${words[0]} ${words.at(-1)}`;
  let out = words.at(-1)!;
  for (let i = words.length - 2; i >= 0 && `${words[i]} ${out}`.length <= 22 && words.length - i <= 3; i--) out = `${words[i]} ${out}`;
  return out.slice(0, 22);
};

/** Words two or more of the kit's bottles end with ("Plasma Membrane Stain" on four CellMask stains): the rest tells them apart. */
function sharedEnding(names: string[]): string {
  const ends = new Map<string, number>();
  for (const name of names) {
    const words = name.replace(/\s*\(.*?\)\s*/g, ' ').trim().split(/\s+/);
    for (let n = 2; n <= Math.min(4, words.length - 1); n++) {
      const end = words.slice(-n).join(' ');
      ends.set(end, (ends.get(end) ?? 0) + 1);
    }
  }
  let best = '';
  for (const [end, count] of ends) if (count >= 2 && end.length > best.length) best = end;
  return best;
}

const mixHex = (a: string, b: string, k: number) => {
  const c = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  return `#${[0, 1, 2].map(i => Math.round(c(a, i) + (c(b, i) - c(a, i)) * k).toString(16).padStart(2, '0')).join('')}`;
};

// ---------------------------------------------------------------------------------------------------------------

class Scene {
  items: Item[] = [];
  actions: Action[] = [];
  t = 0;
  add(item: Item) {
    this.items.push(item);
    return item.id;
  }
  at(id: string, set: Action['set'], ms = 400, after = 0) {
    this.t += after;
    this.actions.push({ at: Math.round(this.t), ms, id, ...(set ? { set } : {}) });
  }
  drop(id: string, x: number, y1: number, y2: number, colour: string, after = 0) {
    this.t += after;
    this.actions.push({ at: Math.round(this.t), ms: 380, id, drop: { x, y1, y2, colour } });
  }
}

function pipette(sc: Scene, p: Protocol, x: number, y: number, volume?: { value: number; unit: string }, labelled = true) {
  const kind = pipetteFor(volume);
  const named = p.equipment.find(e => /pipette/.test(e.icon));
  return sc.add({
    id: 'pipette',
    kind: 'pipette',
    x,
    y,
    rotate: -8,
    scale: 0.78,
    cap: kind.cap,
    text: kind.text,
    // Its volume beside it, where the words are drawn big (not where every vial takes its own).
    ...(volume && labelled ? { label: `${volume.value} ${volume.unit}` } : {}),
    represents: `Pipette${volume ? ` set to ${volume.value} ${volume.unit}` : ''}`,
    source: named ? said(`equipment.${named.id}`, named.cite) : drawn('Liquid moves by pipette, though the protocol names none.'),
    drawn: { look: 'A single-channel pipette; its plunger colour is the usual one for this range.' },
  });
}

/** The pipette goes over (x, top) and lets a drop fall to y. */
function dispense(sc: Scene, x: number, top: number, y: number, colour: string, gap = 520) {
  sc.at('pipette', { x, y: top }, 300, gap);
  sc.drop('pipette', x - 1.2, top + 2, y, colour, 280);
}

function equipmentItem(p: Protocol, kind: Item['kind'], icon: RegExp, x: number, y: number, scale: number, extra: Partial<Item> = {}): Item {
  const e = p.equipment.find(q => icon.test(`${q.icon} ${q.name}`.toLowerCase()));
  return {
    id: kind,
    kind,
    x,
    y,
    scale,
    represents: e ? `${e.name}${e.setting ? ` (${e.setting})` : ''}` : kind,
    source: e ? said(`equipment.${e.id}`, e.cite) : drawn(`The step needs one, though the protocol does not name it.`),
    drawn: { look: `Drawn as a typical ${kind}.` },
    ...extra,
  };
}

/** The five sample tubes in their rack, as the bench left them. */
function sampleTubes(sc: Scene, bench: Bench, cx: number, s: number) {
  sc.add({ id: 'rack', kind: 'rack', x: cx, y: BENCH, scale: s, width: 120, represents: 'Tube rack', source: drawn('Somewhere for the tubes to stand.') });
  for (let i = 0; i < 5; i++)
    sc.add({ id: `tube:${i + 1}`, kind: 'tube', x: cx + (i - 2) * 20 * s, y: BENCH - 6 * s, scale: s, level: bench.samples?.level ?? 0, liquid: bench.samples?.colour ?? CLEAR, label: String(i + 1), represents: `Tube ${i + 1}`, source: drawn('Five tubes stand for the standards and samples.'), drawn: { colour: 'Clear unless the protocol gives a colour.' } });
}

/** Moves an item (a rack, with its tubes) from `home`, where it was put, to `to`, and hides it inside or shows it again. */
function moveWith(sc: Scene, id: string, to: { x: number; y: number; scale: number }, home: { x: number; y: number; scale: number }, hidden?: boolean) {
  sc.at(id, { ...to, ...(hidden === false ? { hidden } : {}) }, 900, 500);
  if (id === 'rack')
    for (const it of sc.items.filter(i => i.kind === 'tube'))
      sc.actions.push({ at: sc.t, ms: 900, id: it.id, set: { x: to.x + ((it.x - home.x) / home.scale) * to.scale, y: to.y + ((it.y - home.y) / home.scale) * to.scale, scale: ((it.scale ?? 1) / home.scale) * to.scale, ...(hidden === false ? { hidden } : {}) } });
  if (hidden) {
    sc.t += 900;
    for (const it of [id, ...(id === 'rack' ? sc.items.filter(i => i.kind === 'tube').map(i => i.id) : [])]) sc.actions.push({ at: sc.t, ms: 300, id: it, set: { hidden: true } });
  }
}

// ---------------------------------------------------------------------------------------------------------------

function compose(p: Protocol, proc: Procedure, step: Step, bench: Bench, sized: Sized): BenchScene {
  const sc = new Scene();
  const big = !!sized.big;
  const src = said(`steps.${step.id}`, step.cite);
  const mixC = mixColour(p, proc);
  const mixSource = mixC ? said('summary') : drawn('The protocol does not give its colour: drawn clear.');
  const words = `${step.title} ${step.key}`.toLowerCase();
  const curve = p.standardCurves.find(c => c.id === (step.standardCurve ?? proc.standardCurve));
  const used = Math.min(96, (curve?.points.length ?? 8) * 2 + 24);
  const wellNames = sized.wells?.length ? sized.wells : Array.from({ length: used }, (_, i) => wellName(i % 8, Math.floor(i / 8)));
  const vessel = proc.format === 'cells' ? 'flask' : proc.format === 'microplate' ? 'plate' : 'rack';
  // A bottle the step's words name: by its whole name or its label, or by its first word when that word is its own
  // ("ddH2O", "Insulin") rather than any kit's ("Assay Buffer 23" is not in "for desired assays").
  const generic = /^(?:assay|reagent|buffer|mix|solution|standard|working|reaction|stain|medium|probe|wash|sample|kit|control|lysis|dilution|stop|dye)$/;
  const named = p.components.filter(c => {
    const first = c.name.split(/[\s,(]/)[0]!.toLowerCase();
    return words.includes(c.name.toLowerCase()) || words.includes(shortName(c.name).toLowerCase()) || (!generic.test(first) && words.includes(first));
  });
  const ending = sharedEnding(p.components.filter(c => c.suppliedBy === 'kit').map(c => c.name));

  const bottle = (c: Protocol['components'][number], i: number, x: number, scale = 0.86): Item => {
    const note = c.notes?.map(n => colourIn(n.text)).find(Boolean);
    return {
      id: `bottle:${c.id}`,
      kind: 'bottle',
      x,
      y: BENCH - 6,
      scale,
      label: shortName(c.name, ending),
      cap: CAPS[i % CAPS.length],
      level: 0.72,
      liquid: note ?? CLEAR,
      represents: `${c.name}${c.concentration ? `, ${c.concentration.value} ${c.concentration.unit}` : ''}`,
      source: said(`components.${c.id}`, c.cite),
      drawn: { ...(note ? {} : { colour: 'The protocol does not give its colour: drawn clear.' }), look: 'A reagent bottle; the cap colour only tells them apart.' },
    };
  };

  const plateItem = (wells: Record<string, string>, extra: Partial<Item> = {}): Item => {
    const kit = p.equipment.find(e => /plate/.test(e.icon));
    return {
      id: 'plate',
      kind: 'plate',
      x: 120,
      y: BENCH,
      wells,
      represents: kit?.name ?? '96-well plate',
      source: kit ? said(`equipment.${kit.id}`, kit.cite) : said(`procedures.${proc.id}.format`, proc.cite),
      drawn: { layout: 'Standards in duplicate down the first columns, then the samples, as the plan lays them out.' },
      ...extra,
    };
  };

  const flask = (x: number, y: number, scale: number): Item => ({
    id: 'flask',
    kind: 'flask',
    x,
    y,
    scale,
    level: bench.flask.level,
    liquid: bench.flask.colour,
    represents: 'Culture flask with the cells',
    source: said(`procedures.${proc.id}.format`, proc.cite),
    drawn: { look: 'A culture flask; medium drawn pink, as phenol red makes most media, and buffer clear.' },
  });

  // What a step takes its reagent up from, standing on the bench at x: the mix in the tube its own step made it in (named
  // as that step named it, as full as it left it), else the component's bottle. Nothing the protocol does not have (no
  // reservoir to pour it into). Where the pipette's tip goes into it, or null when the protocol names neither.
  const takeFrom = (add: NonNullable<Step['add']>[number] | undefined, x: number, scale: number): { id: string; x: number; y: number } | null => {
    if (add?.what === 'mix') {
      const m = p.mixes.find(q => q.id === add.ref) ?? p.mixes.find(q => q.id === (step.mix ?? proc.mix));
      const label = bench.mix?.label ?? (m ? m.short || shortName(m.name) : undefined);
      sc.add({ id: 'mix', kind: 'conical', x, y: BENCH - 4, scale, label, cap: '#2b7de9', level: bench.mix?.level ?? 0.6, liquid: bench.mix?.colour ?? mixC ?? CLEAR, represents: m ? `${m.name}, in the tube it was made in` : 'The mix', source: m ? said(`mixes.${m.id}`, m.cite) : src, drawn: { vessel: 'The 15 mL conical tube its step made it in.' } });
      return { id: 'mix', x, y: BENCH - 4 - ART.conical.h * scale + 12 };
    }
    const c = add?.ref ? p.components.find(q => q.id === add.ref) : named[0];
    if (!c) return null;
    const id = sc.add(bottle(c, 0, x, scale));
    return { id, x, y: BENCH - 6 - ART.bottle.h * scale - 6 };
  };
  /** The pipette goes to take it up; the mix's tube goes down a little each time. */
  const take = (from: { id: string; x: number; y: number }, after: number) => {
    sc.at('pipette', { x: from.x, y: from.y }, 280, after);
    if (from.id === 'mix' && bench.mix) {
      bench.mix = { ...bench.mix, level: Math.max(0.15, bench.mix.level - 0.05) };
      sc.at('mix', { level: bench.mix.level }, 260, 0);
    }
  };

  // A step that spins (a centrifuge, "× g"), whatever its stage: the centrifuge, its force on the display.
  const spinWords = `${step.title} ${step.key}`;
  const spins =
    ['incubate', 'wash', 'prepare'].includes(step.stage) &&
    (/centrifug|\bspin\b|\d\s*[x×]\s*g\b/i.test(spinWords) || (step.equipment ?? []).some(id => /centrifug/i.test(`${p.equipment.find(e => e.id === id)?.icon} ${p.equipment.find(e => e.id === id)?.name}`)));
  if (spins) {
    const g = /([\d,]+)\s*[x×]\s*g\b/i.exec(spinWords)?.[1]?.replace(/,/g, '');
    const t = step.timer;
    sc.add(equipmentItem(p, 'centrifuge', /centrifug/, 132, BENCH, 1.45, { progress: 0, text: g ? `${g}×g` : 'spin' }));
    if (t) sc.add({ id: 'timer', kind: 'timer', x: 40, y: 82, text: `${t.duration.value} ${t.duration.unit}`, progress: 0, represents: `Spin for ${t.duration.value} ${t.duration.unit}`, source: said(`steps.${step.id}.timer`, step.cite) });
    if (t?.temperature) sc.add({ id: 'thermometer', kind: 'thermometer', x: 30, y: 196, text: `${t.temperature.value} °C`, represents: `${t.temperature.value} °C`, source: said(`steps.${step.id}.timer`, step.cite) });
    sc.at('centrifuge', { progress: 0.5 }, 300, 500);
    if (t) sc.at('timer', { progress: 1 }, 2200, 0);
    sc.at('centrifuge', { progress: 1 }, 300, 2300);
    return finish(sc, step, src);
  }

  switch (step.stage) {
    case 'standards': {
      const shown = curve ?? p.standardCurves[0];
      const pts = (shown?.points ?? []).slice(0, 10);
      if (!shown) {
        sc.add({ id: 'rack', kind: 'rack', x: 120, y: BENCH, width: 140, represents: 'Tube rack', source: drawn('Somewhere for the vials to stand.') });
        for (let i = 0; i < 6; i++) sc.add({ id: `tube:${i + 1}`, kind: 'tube', x: 70 + i * 20, y: BENCH - 6, label: String(i + 1), level: 0, liquid: CLEAR, represents: `Standard ${i + 1}`, source: drawn('The protocol gives no dilution table here: six vials stand for its standards.') });
        pipette(sc, p, 70, 150);
        for (let i = 0; i < 6; i++) {
          sc.at(`tube:${i + 1}`, { open: true }, 250, i ? 260 : 450);
          dispense(sc, 70 + i * 20, 150, BENCH - 30, CLEAR, 0);
          sc.at(`tube:${i + 1}`, { level: 0.55 }, 450, 120);
          sc.at(`tube:${i + 1}`, { open: false }, 250, 380);
        }
        break;
      }
      // The stock the standards are made from and their diluent stand behind the rack: the user's own photo of the
      // stock, when they took one, is what they see on the bench.
      const stock = p.components.find(c => c.id === shown.stock);
      const diluent = p.components.find(c => c.id === shown.diluent);
      if (stock) sc.add({ ...bottle(stock, 0, 34, 0.6), y: BENCH - 60 });
      if (diluent && diluent.id !== stock?.id) sc.add({ ...bottle(diluent, 1, 206, 0.6), y: BENCH - 60 });
      const n = Math.max(1, pts.length);
      const step_ = Math.min(21, 200 / n);
      const x0 = 120 - ((n - 1) * step_) / 2;
      sc.add({ id: 'rack', kind: 'rack', x: 120, y: BENCH, width: n * step_ + 18, represents: 'Tube rack', source: drawn('Somewhere for the vials to stand.') });
      pts.forEach((pt, i) =>
        sc.add({
          id: `tube:${pt.id}`,
          kind: 'tube',
          x: x0 + i * step_,
          y: BENCH - 6,
          label: pt.id,
          level: bench.tubes.includes(pt.id) ? 0.55 : 0,
          liquid: CLEAR,
          represents: `Vial ${pt.id}: ${pt.concentration.value} ${pt.concentration.unit}${pt.blank ? ' (blank)' : ''} — ${pt.from ? `${pt.take.value} ${pt.take.unit} of ${pt.from === 'stock' ? 'the stock' : pt.from} + ` : ''}${pt.diluent.value} ${pt.diluent.unit} diluent`,
          source: said(`standardCurves.${shown.id}.points.${pt.id}`, shown.cite),
          drawn: { colour: 'Protein standards are colourless: drawn clear.' },
        }),
      );
      pipette(sc, p, x0, 150, pts.find(pt => pt.diluent.value > 0)?.diluent, false);
      pts.forEach((pt, i) => {
        const id = `tube:${pt.id}`;
        const x = x0 + i * step_;
        sc.at(id, { open: true }, 250, i ? 260 : 450);
        dispense(sc, x, 150, BENCH - 30, CLEAR, 0);
        sc.at(id, { level: 0.55 }, 450, 120);
        sc.at(id, { open: false }, 250, 380);
      });
      bench.tubes = pts.map(pt => pt.id);
      break;
    }
    case 'mix': {
      const m = p.mixes.find(x => x.id === (step.mix ?? proc.mix));
      if (!m) {
        const shown = (named.length ? named : p.components.filter(c => c.suppliedBy === 'kit')).slice(0, 2);
        const xs = shown.length === 1 ? [70] : [44, 104];
        shown.forEach((c, i) => sc.add(bottle(c, i, xs[i]!)));
        sc.add({ id: 'mix', kind: 'conical', x: 196, y: BENCH - 4, scale: 0.98, cap: '#2b7de9', level: 0, liquid: CLEAR, represents: step.title, source: src, drawn: { vessel: 'A 15 mL conical tube; the protocol does not name the vessel.', colour: 'Drawn clear.' } });
        pipette(sc, p, xs[0]!, 126);
        shown.forEach((_, i) => {
          dispense(sc, xs[i]!, 126, BENCH - 50, CLEAR, 500);
          sc.at('pipette', { x: 196, y: 112 }, 400, 300);
          sc.drop('pipette', 194.8, 114, BENCH - 40, CLEAR, 400);
          sc.at('mix', { level: (0.6 * (i + 1)) / Math.max(1, shown.length) }, 600, 200);
        });
        break;
      }
      // Every part, up to four bottles side by side (smaller when there are four). Drawn big, two bottles stand
      // bigger, and the arrows end one under the other so their big amounts read apart.
      const parts = m.parts.slice(0, 4);
      const xs = parts.length === 4 ? [28, 70, 112, 154] : parts.length === 3 ? [36, 86, 136] : big ? [46, 114] : [44, 104];
      const bottleScale = parts.length === 4 ? 0.74 : parts.length === 2 && big ? 1 : 0.86;
      parts.forEach((part, i) => {
        const c = p.components.find(x => x.id === part.component);
        if (c) sc.add(bottle(c, i, xs[i]!, bottleScale));
      });
      const tubeX = big ? 206 : 202;
      // What goes in, on each arrow: the amount the manual prints when the protocol kept it ("44 µL"), else the share
      // as a number; "part" only where the manual itself counts in parts (BCA's "50 parts of A with 1 part of B").
      // The ratio stands by the tube's name when the arrows carry bare numbers. While the protocol plays, the arrows
      // carry the run's own amounts and the tube says how much they make.
      const inParts = /\bparts?\b/i.test(m.cite?.quote ?? '');
      const share = (part: (typeof m.parts)[number]) => sized.mix?.parts[part.component] ?? (part.amount || (inParts ? `${part.parts} part${part.parts === 1 ? '' : 's'}` : String(part.parts)));
      // Drawn big, the arrows also say the order the parts go in (①, ②: BCA's B goes in last).
      const ORDER = ['①', '②', '③', '④'];
      const onArrow = (part: (typeof m.parts)[number], i: number) => (big && parts.length > 1 ? `${ORDER[i]} ${share(part)}` : share(part));
      const short = m.short || shortName(m.name);
      const withRatio = `${short} · ${m.parts.map(x => x.parts).join(' : ')}`;
      const label = sized.mix ? `${short} · ${sized.mix.make}` : !m.parts.every(x => x.amount) && withRatio.length <= 40 ? withRatio : short;
      sc.add({ id: 'mix', kind: 'conical', x: tubeX, y: BENCH - 4, scale: big ? 1.05 : 0.98, label, cap: '#2b7de9', level: bench.mix?.level ?? 0, liquid: bench.mix?.colour ?? CLEAR, represents: `${m.name}: ${m.parts.map(x => `${share(x)} ${p.components.find(c => c.id === x.component)?.name ?? x.component}`).join(' + ')}`, source: said(`mixes.${m.id}`, m.cite), drawn: { vessel: 'A 15 mL conical tube; the protocol names the mix, not its tube.' } });
      const top = BENCH - 4 - 89 * bottleScale;
      parts.forEach((part, i) =>
        sc.add({ id: `arrow:${i}`, kind: 'arrow', x: xs[i]! + 4, y: big ? top : BENCH - 92, to: [tubeX - 16, big ? BENCH - 126 + i * 38 : BENCH - 112 + i * 8], label: onArrow(part, i), hidden: true, represents: `${share(part)} ${p.components.find(c => c.id === part.component)?.name ?? part.component}`, source: said(`mixes.${m.id}.parts`, m.cite) }),
      );
      parts.forEach((_, i) => {
        sc.at(`arrow:${i}`, { hidden: false }, 400, i ? 700 : 500);
        sc.at('mix', { level: 0.3 + (0.3 * (i + 1)) / parts.length, liquid: CLEAR }, 700, 300);
      });
      // Drawn big, what to do once it is all in, as it turns: mix, until the colour the manual says it turns.
      const turns = m.notes.map(n => colourWordIn(n.text)).find(Boolean);
      sc.at('mix', { liquid: mixC ?? CLEAR, ...(big ? { text: turns ? `Mix until ${turns}` : 'Mix' } : {}) }, 1400, 700);
      bench.mix = { colour: mixC ?? CLEAR, level: 0.6, label };
      break;
    }
    case 'load':
    case 'treat': {
      const add = step.add?.[0];
      if (vessel === 'plate') {
        const intoWells = add?.what === 'standards-and-samples' || !add;
        const colour = add?.what === 'mix' ? (bench.mix?.colour ?? mixC ?? CLEAR) : SAMPLE;
        sc.add(plateItem(bench.wells));
        // Left of the plate's corner, on the bench: what it is taken up from.
        const from = intoWells ? null : takeFrom(add, 28, 0.78);
        const first = wellAt(120, BENCH, 0, 0);
        pipette(sc, p, first.x, first.y - 34, add?.volume);
        const cols = Math.ceil(wellNames.length / 8);
        for (let col = 0; col < cols; col++) {
          const names = wellNames.slice(col * 8, col * 8 + 8);
          const top = wellAt(120, BENCH, 0, col);
          if (from && col % 2 === 0) take(from, col ? 300 : 500);
          dispense(sc, top.x, top.y - 34, top.y - 2, colour, intoWells ? 240 : 320);
          sc.at('plate', { wells: Object.fromEntries(names.map(n => [n, colour])) }, 420, 160);
        }
        if (step.timer && /shak/.test((step.equipment ?? []).join(' ') + words)) {
          // Drawn big, the shake is written on the plate ("Shake 30 s"), the pipette out of its way.
          if (big) {
            sc.at('pipette', from ? { x: from.x, y: from.y - 10 } : { x: 46, y: 120 }, 400, 300);
            sc.at('plate', { label: `${step.timer.label} ${step.timer.duration.value} ${step.timer.duration.unit}` }, 300, 100);
          }
          for (let i = 0; i < 6; i++) sc.at('plate', { x: 120 + (i % 2 ? -2 : 2) }, 90, i ? 100 : 400);
        }
        if (step.timer) sc.at('plate', { x: 120 }, 120, 100);
        for (const n of wellNames) bench.wells[n] = colour;
      } else {
        const c = (add?.ref ? p.components.find(x => x.id === add.ref) : named[0]) ?? null;
        const intoTubes = add?.what === 'standards-and-samples';
        const colour = add?.what === 'mix' ? (bench.mix?.colour ?? mixC ?? CLEAR) : intoTubes ? SAMPLE : c?.notes?.map(n => colourIn(n.text)).find(Boolean) ?? CLEAR;
        const from = intoTubes ? null : takeFrom(add, 52, 0.9);
        if (vessel === 'flask') sc.add(flask(152, BENCH - 4, 1.05));
        else sampleTubes(sc, bench, 150, 1);
        const target = vessel === 'flask' ? { x: 150, top: BENCH - 80, y: BENCH - 30 } : { x: 110, top: BENCH - 84, y: BENCH - 30 };
        pipette(sc, p, target.x, target.top, add?.volume);
        if (vessel === 'rack') {
          const level = Math.min(0.8, (bench.samples?.level ?? 0) + (add?.what === 'mix' ? 0.45 : 0.25));
          const now = bench.samples ? (colour === CLEAR ? bench.samples.colour : mixHex(bench.samples.colour, colour, 0.8)) : colour;
          for (let i = 0; i < 5; i++) {
            if (from) take(from, i ? 200 : 400);
            sc.at(`tube:${i + 1}`, { open: true }, 250, from ? 0 : i ? 200 : 400);
            dispense(sc, 110 + i * 20, BENCH - 84, BENCH - 30, colour, from ? 200 : 0);
            sc.at(`tube:${i + 1}`, { level, liquid: now }, 450, 150);
            sc.at(`tube:${i + 1}`, { open: false }, 250, 300);
          }
          bench.samples = { colour: now, level };
        } else {
          if (from) take(from, 500);
          for (let i = 0; i < 3; i++) dispense(sc, target.x + i * 6, target.top, target.y, colour, i ? 300 : from ? 300 : 500);
          const level = Math.min(0.5, bench.flask.level + 0.06);
          const now = colour === CLEAR ? bench.flask.colour : mixHex(bench.flask.colour, colour, 0.5);
          sc.at('flask', { level, liquid: now }, 700, 200);
          bench.flask = { colour: now, level };
        }
      }
      break;
    }
    case 'wash': {
      if (vessel === 'plate') sc.add(plateItem(bench.wells, { x: 120 }));
      else if (vessel === 'flask') sc.add(flask(120, BENCH - 4, 1));
      else sampleTubes(sc, bench, 120, 1);
      sc.add({ id: 'waste', kind: 'beaker', x: 210, y: 92, scale: 0.75, level: 0.15, liquid: '#d5dee8', represents: 'Waste', source: drawn('Somewhere for what is washed away.') });
      sc.add({ id: 'buffer', kind: 'washbottle', x: 30, y: 100, scale: 0.85, level: 0.75, liquid: CLEAR, represents: named[0]?.name ?? 'Wash buffer', source: named[0] ? said(`components.${named[0].id}`, named[0].cite) : drawn('The wash buffer, in a wash bottle.') });
      sc.add({ id: 'out', kind: 'arrow', x: 150, y: 128, to: [196, 64], label: 'out', hidden: true, represents: 'Liquid taken out', source: src });
      sc.add({ id: 'in', kind: 'arrow', x: 44, y: 18, to: [92, 132], label: 'wash', hidden: true, represents: 'Wash buffer in', source: src });
      sc.at('out', { hidden: false }, 400, 400);
      if (vessel === 'plate') sc.at('plate', { wells: Object.fromEntries(Object.keys(bench.wells).map(n => [n, '#f1f5f9'])) }, 700, 200);
      if (vessel === 'rack') for (let i = 0; i < 5; i++) sc.at(`tube:${i + 1}`, { level: 0.06 }, 700, 0);
      if (vessel === 'flask') sc.at('flask', { level: 0.04 }, 700, 0);
      sc.at('waste', { level: 0.35 }, 700, 0);
      sc.at('in', { hidden: false }, 400, 700);
      if (vessel === 'plate') sc.at('plate', { wells: Object.fromEntries(Object.keys(bench.wells).map(n => [n, CLEAR])) }, 700, 200);
      if (vessel === 'rack') for (let i = 0; i < 5; i++) sc.at(`tube:${i + 1}`, { level: 0.4, liquid: CLEAR }, 700, i ? 0 : 200);
      if (vessel === 'flask') sc.at('flask', { level: 0.3, liquid: CLEAR }, 700, 200);
      for (const n of Object.keys(bench.wells)) bench.wells[n] = CLEAR;
      if (bench.samples) bench.samples = { colour: CLEAR, level: 0.4 };
      if (vessel === 'flask') bench.flask = { colour: CLEAR, level: 0.3 };
      break;
    }
    case 'incubate': {
      const t = step.timer;
      const result = resultColour(p, proc);
      const deg = t?.temperature?.value;
      const temp = deg !== undefined ? `${deg} °C` : undefined;
      // Warm (an incubator says 37 °C); room temperature or cold stays on the bench, with the thermometer saying so.
      const warm = deg !== undefined && deg >= 30;
      const length = sized.incubation ?? (t ? `${t.duration.value} ${t.duration.unit}` : '');
      const timer = t ? sc.add({ id: 'timer', kind: 'timer', x: warm ? 48 : 196, y: warm ? 72 : 82, scale: big ? 1.5 : 1, text: length, progress: 0, represents: `Timer: ${length}${temp ? ` at ${temp}` : ''}${t.covered ? ', covered' : ''}`, source: said(`steps.${step.id}.timer`, step.cite) }) : null;
      if (warm) sc.add(equipmentItem(p, 'incubator', /incubat|oven|bath/, 162, BENCH, 0.92, { text: `${deg!.toFixed(1)} °C`, label: temp }));
      else sc.add({ id: 'thermometer', kind: 'thermometer', x: 30, y: 196, scale: big ? 1.3 : 1, text: temp ?? 'RT', represents: temp ?? 'Room temperature', source: t?.temperature ? said(`steps.${step.id}.timer`, step.cite) : drawn('The protocol gives no temperature: room temperature.') });
      const home = vessel === 'plate' ? { x: warm ? 66 : 120, y: BENCH, scale: warm ? 0.5 : 0.9 } : vessel === 'flask' ? { x: warm ? 56 : 120, y: BENCH - 4, scale: warm ? 0.7 : 1.1 } : { x: warm ? 60 : 120, y: BENCH, scale: warm ? 0.6 : 1 };
      let what: string;
      if (vessel === 'plate') what = sc.add(plateItem(bench.wells, { ...home, ...(big && t?.covered ? { label: 'Cover' } : {}) }));
      else if (vessel === 'flask') what = sc.add(flask(home.x, home.y, home.scale));
      else {
        what = 'rack';
        sampleTubes(sc, bench, home.x, home.scale);
      }
      const inside = vessel === 'plate' ? { x: 162, y: BENCH - 66, scale: 0.38 } : vessel === 'flask' ? { x: 162, y: BENCH - 66, scale: 0.55 } : { x: 162, y: BENCH - 66, scale: 0.4 };
      if (warm) {
        sc.at('incubator', { open: true }, 500, 400);
        moveWith(sc, what, inside, home, true);
        sc.at('incubator', { open: false }, 500, 0);
      }
      if (timer) sc.at(timer, { progress: 1 }, 2600, 300);
      if (result) {
        if (vessel === 'plate') {
          const pts = curve?.points ?? [];
          const top = Math.max(...pts.map(x => x.concentration.value), 1);
          const turned = Object.fromEntries(
            Object.keys(bench.wells).map((n, i) => {
              const k = Math.floor(i / 2);
              const strength = k < pts.length ? pts[k]!.concentration.value / top : 0.3 + (0.5 * ((n.charCodeAt(0) * 7 + i * 13) % 10)) / 10;
              return [n, mixHex(bench.mix?.colour ?? CLEAR, result.colour, Math.min(1, 0.12 + 0.88 * strength))];
            }),
          );
          sc.at(what, { wells: turned }, 2400, 0);
          Object.assign(bench.wells, turned);
        } else if (vessel === 'rack' && bench.samples) {
          for (let i = 0; i < 5; i++) sc.at(`tube:${i + 1}`, { liquid: mixHex(bench.samples.colour, result.colour, 0.3 + i * 0.15) }, 2400, 0);
          bench.samples = { ...bench.samples, colour: mixHex(bench.samples.colour, result.colour, 0.6) };
        }
      }
      sc.t += 2400;
      if (warm) {
        sc.at('incubator', { open: true }, 500, 100);
        moveWith(sc, what, home, home, false);
        sc.at('incubator', { open: false }, 500, 900);
      }
      break;
    }
    case 'read': {
      const wl = p.analysis?.readout;
      // Drawn big: cooling to room temperature first (the step's words), a thermometer saying so; what it reads at,
      // over the reader as it reads.
      const cool = big && /\bcool|room temperature/i.test(`${step.title} ${step.key}`);
      sc.add(equipmentItem(p, 'reader', /reader|spectro|cytomet/, 108, BENCH, 1.15));
      if (cool) sc.add({ id: 'thermometer', kind: 'thermometer', x: 22, y: 120, scale: 1.1, label: 'Cool to RT', represents: 'Room temperature', source: src });
      sc.add(plateItem(bench.wells, { x: cool ? 76 : 64, y: 96, scale: 0.42 }));
      sc.at('reader', { open: true }, 600, 400);
      sc.at('plate', { x: 180, y: BENCH - 22, scale: 0.3 }, 900, 600);
      sc.at('reader', { open: false }, 700, 900);
      sc.at('plate', { x: 128, hidden: true }, 700, 0);
      if (wl) sc.at('reader', { text: `${wl.value} nm`, ...(big ? { label: `${wl.value} nm` } : {}) }, 300, 700);
      break;
    }
    case 'analyze': {
      if (!curve) break;
      const pts = curve.points;
      const top = Math.max(...pts.map(x => x.concentration.value), 1);
      const points = pts.map(x => [x.concentration.value / top, 0.05 + 0.9 * ((x.concentration.value / top) / (x.concentration.value / top + 0.45)) * 1.45] as [number, number]);
      sc.add({ id: 'chart', kind: 'chart', x: 120, y: 182, scale: 1.3, points: points.map(([x, y]) => [x, Math.min(1, y)] as [number, number]), progress: 0, label: `Concentration${pts[0] ? ` (${pts[0].concentration.unit})` : ''}`, text: p.analysis?.readout ? `A${p.analysis.readout.value}` : 'Absorbance', represents: 'The standard curve', source: said(`standardCurves.${curve.id}`, curve.cite), drawn: { shape: 'The protocol gives the concentrations; the absorbances are drawn to show the shape, not measured.' } });
      sc.at('chart', { progress: 1 }, 1600, 500);
      break;
    }
    case 'observe': {
      sc.add(equipmentItem(p, 'microscope', /microscope/, 70, BENCH, 1.3));
      sc.add({ id: 'dish', kind: 'dish', x: 160, y: BENCH - 20, scale: 0.75, liquid: MEDIUM, text: '30', represents: 'The cells, as they look', source: step.notes?.find(n => n.kind === 'expected') ? said(`steps.${step.id}.notes`, step.notes.find(n => n.kind === 'expected')!.cite) : src });
      break;
    }
    case 'prepare': {
      const kind = prepKind(step);
      if (kind === 'spin') {
        sc.add(equipmentItem(p, 'centrifuge', /centrifug/, 120, BENCH, 1.45, { progress: 0, text: 'spin' }));
        sc.at('centrifuge', { progress: 0.5 }, 300, 500);
        sc.at('centrifuge', { progress: 1, text: 'done' }, 300, 2000);
        break;
      }
      if (kind === 'grow' || (/\bcells?\b/.test(words) && kind !== 'dissolve' && kind !== 'dilute')) {
        sc.add(flask(120, BENCH - 6, 1.5));
        break;
      }
      // Dissolving or diluting: what is dissolved is the one the title names ("Dissolve Converter Mix B"), what goes
      // in another the step names ("in 220 µL Assay Buffer 23"), drawn first, the pipette going from it to the other.
      const dissolving = kind === 'dissolve' || kind === 'dilute';
      const title = step.title.toLowerCase();
      const inTitle = (c: Protocol['components'][number]) =>
        Math.min(Infinity, ...[c.name, c.name.split(/[\s,(]/)[0]!, shortName(c.name)].map(n => title.indexOf(n.toLowerCase())).filter(i => i >= 0));
      const target = dissolving ? [...named].sort((a, b) => (inTitle(a) === inTitle(b) ? 0 : inTitle(a) < inTitle(b) ? -1 : 1))[0] : undefined;
      const solvent = target ? named.find(c => c !== target && inTitle(c) === Infinity) : undefined;
      const kit = p.components.filter(c => c.suppliedBy === 'kit');
      const shown = target ? (solvent ? [solvent, target] : [target]) : (named.length ? named : kit).slice(0, dissolving ? 1 : 3);
      const xs = shown.length === 1 ? [96] : shown.length === 2 ? [70, 132] : [50, 104, 158];
      shown.forEach((c, i) => sc.add(bottle(c, i, xs[i]!, shown.length === 1 ? 1.05 : 0.86)));
      if (kind === 'warm') {
        const t = /(\d+)\s*°?\s*c/i.exec(step.key)?.[1];
        sc.add({ id: 'thermometer', kind: 'thermometer', x: 206, y: 196, text: t ? `${t} °C` : 'RT', represents: t ? `${t} °C` : 'Room temperature', source: src });
        if (step.timer) sc.add({ id: 'timer', kind: 'timer', x: 204, y: 92, text: `${step.timer.duration.value} ${step.timer.duration.unit}`, progress: 0, represents: 'How long', source: said(`steps.${step.id}.timer`, step.cite) });
        if (step.timer) sc.at('timer', { progress: 1 }, 2200, 500);
      } else if (dissolving && shown.length) {
        const into = shown.length - 1;
        const id = `bottle:${shown[into]!.id}`;
        sc.items.find(i => i.id === id)!.level = 0.15;
        const said = /(\d+(?:\.\d+)?)\s*(µL|uL|mL)/i.exec(step.key);
        const volume = said ? { value: Number(said[1]), unit: /^m/i.test(said[2]!) ? 'mL' : 'µL' } : undefined;
        pipette(sc, p, xs[0]!, 120, volume);
        if (into > 0) {
          // Drawn up from the buffer, then over to what it dissolves.
          sc.at('pipette', { y: 128 }, 300, 500);
          sc.at(`bottle:${shown[0]!.id}`, { level: 0.64 }, 400, 0);
          sc.at('pipette', { y: 120 }, 300, 200);
          sc.at('pipette', { x: xs[into]! }, 500, 100);
        }
        for (let i = 0; i < 3; i++) dispense(sc, xs[into]!, 120, BENCH - 40, CLEAR, i ? 300 : 500);
        sc.at(id, { level: 0.7 }, 900, 200);
      }
      break;
    }
  }
  return finish(sc, step, src);
}

/** The scene, its words fitted to the contract's limits and its actions in time order, checked. */
function finish(sc: Scene, step: Step, src: Source): BenchScene {
  const cut = (t: string | undefined, n: number) => (t && t.length > n ? `${t.slice(0, n - 1)}…` : t);
  const items = sc.items.map(it => ({ ...it, label: cut(it.label, 40), text: cut(it.text, 24), represents: cut(it.represents, 200)!, ...(it.drawn ? { drawn: Object.fromEntries(Object.entries(it.drawn).map(([k, v]) => [k, cut(v, 200)!])) } : {}) }));
  return BenchScene.parse({ title: cut(step.title, 120), caption: { text: cut(step.key, 300), source: src }, items, actions: sc.actions.sort((a, b) => a.at - b.at) });
}

/**
 * Every step of the procedure (its prep first) as a bench scene, by step id, one bench carrying on from each to the
 * next; with the run's numbers (`sized`) where the plan set them.
 */
export function benchScenes(p: Protocol, proc: Procedure, sized: Sized = {}): Map<string, BenchScene> {
  const bench: Bench = { tubes: [], mix: null, wells: {}, samples: null, flask: { colour: MEDIUM, level: 0.3 } };
  return new Map([...(proc.prep ?? []), ...proc.steps].map(step => [step.id, compose(p, proc, step, bench, sized)]));
}
