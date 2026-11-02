import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { benchScenes } from '../shared/benchScenes.ts';
import { Protocol } from '../shared/protocol.ts';

// What the step pictures write on bottles and arrows (shared/benchScenes.ts): the manual's own amounts and words,
// every part of a mix, and bottle names that tell the bottles apart.

const cite = (quote: string) => ({ page: 1, quote });
type Part = { component: string; parts: number; amount?: string };
function protocol(components: { id: string; name: string; user?: boolean }[], parts: Part[], quote: string, short = 'Reaction Mix') {
  return Protocol.parse({
    format: 'chapp.protocol/1',
    id: 'made-up',
    title: 'Made-up assay',
    summary: 'A made-up assay, for its pictures.',
    source: { title: 'Demo manual', publisher: 'Demo Bio', docId: 'D1', revision: '1', date: '', url: 'https://demo.example/m.pdf', sha256: 'a'.repeat(64), pages: 1, fetchedAt: '2026-10-31T00:00:00.000Z' },
    kit: { name: 'Demo Kit', vendor: 'Demo Bio', variants: [{ catalog: 'D1', scale: '', contents: components.filter(c => !c.user).map(c => ({ component: c.id })) }], cite: cite('Kit contents') },
    overview: { procedure: 'assay', steps: ['Make the mix'], expected: [], cite: cite('Overview') },
    components: components.map(c => ({ id: c.id, name: c.name, role: 'reagent', suppliedBy: c.user ? 'user' : 'kit', cite: cite(c.name) })),
    equipment: [],
    mixes: [{ id: 'rx', name: 'Reaction Mix', short, parts, notes: [], cite: cite(quote) }],
    standardCurves: [],
    procedures: [{ id: 'assay', name: 'Assay', format: 'cells', mix: 'rx', steps: [{ id: 'make', stage: 'mix', title: 'Make the mix', key: 'Make the reaction mix', mix: 'rx', cite: cite(quote) }], cite: cite('Assay') }],
    defaults: { procedure: 'assay' },
    notes: [],
  });
}
const scene = (p: Protocol) => benchScenes(p, p.procedures[0]!).get('make')!;
const arrows = (p: Protocol) => scene(p).items.filter(i => i.kind === 'arrow').map(i => i.label);
const bottles = (p: Protocol) => scene(p).items.filter(i => i.kind === 'bottle').map(i => i.label);
const tube = (p: Protocol) => scene(p).items.find(i => i.kind === 'conical')!.label;

const ATP = [{ id: 'buffer', name: 'Assay Buffer 23' }, { id: 'probe', name: 'OxiRed Probe' }, { id: 'converter', name: 'Converter Mix B' }, { id: 'developer', name: 'Developer Mix N' }];

describe('what a mix picture says', () => {
  it('draws every part and writes shares as numbers, with the ratio by the tube, when the manual gives no amounts', () => {
    const p = protocol(ATP, [{ component: 'buffer', parts: 44 }, { component: 'probe', parts: 2 }, { component: 'converter', parts: 2 }, { component: 'developer', parts: 2 }], 'Prepare the reaction mix for each well.');
    expect(bottles(p)).toEqual(['Assay Buffer 23', 'OxiRed Probe', 'Converter Mix B', 'Developer Mix N']);
    expect(arrows(p)).toEqual(['44', '2', '2', '2']);
    expect(tube(p)).toBe('Reaction Mix · 44 : 2 : 2 : 2');
  });

  it("writes the manual's amounts when the protocol kept them, and no ratio then", () => {
    const p = protocol(ATP, [{ component: 'buffer', parts: 44, amount: '44 µL' }, { component: 'probe', parts: 2, amount: '2 µL' }, { component: 'converter', parts: 2, amount: '2 µL' }, { component: 'developer', parts: 2, amount: '2 µL' }], 'Prepare the reaction mix for each well.');
    expect(arrows(p)).toEqual(['44 µL', '2 µL', '2 µL', '2 µL']);
    expect(tube(p)).toBe('Reaction Mix');
  });

  it('counts in parts only where the manual does', () => {
    const p = protocol([{ id: 'a', name: 'BCA Reagent A' }, { id: 'b', name: 'BCA Reagent B' }], [{ component: 'a', parts: 50 }, { component: 'b', parts: 1 }], 'Prepare WR by mixing 50 parts of BCA Reagent A with 1 part of BCA Reagent B (50:1).', 'WR');
    expect(arrows(p)).toEqual(['50 parts', '1 part']);
    expect(tube(p)).toBe('WR · 50 : 1');
  });

  it('labels bottles by what tells them apart: the words the kit shares go, a parenthetical goes, a whole short name stays', () => {
    const stains = [{ id: 'orange', name: 'CellMask Orange Plasma Membrane Stain' }, { id: 'deep-red', name: 'CellMask Deep Red Plasma Membrane Stain' }, { id: 'buffer', name: 'Physiologically relevant buffer', user: true }];
    expect(bottles(protocol(stains, [{ component: 'orange', parts: 1 }, { component: 'buffer', parts: 1000 }], 'Prepare a fresh working solution'))).toEqual(['CellMask Orange', 'relevant buffer']);
    const media = [{ id: 'cocktail', name: '1000X Differentiation Cocktail' }, { id: 'medium', name: 'DMEM/F12 (1:1) with 10% FBS', user: true }];
    expect(bottles(protocol(media, [{ component: 'cocktail', parts: 1 }, { component: 'medium', parts: 1000 }], 'Add 1 µl of Differentiation Cocktail to 1 ml of DMEM/F12 (1:1) with 10% FBS.'))).toEqual(['Cocktail', 'DMEM/F12 with 10% FBS']);
    // One stain for every colour variant: the brand and the last word, when the whole name is too long.
    const one = [{ id: 'stain', name: 'CellMask Plasma Membrane Stain (1000X)' }, { id: 'buffer', name: 'Physiologically relevant buffer', user: true }];
    expect(bottles(protocol(one, [{ component: 'stain', parts: 1, amount: '10 µL' }, { component: 'buffer', parts: 1000, amount: '10 mL' }], 'Prepare a fresh working solution'))).toEqual(['CellMask Stain', 'relevant buffer']);
  });
});

describe('what the pictures say while the protocol plays, sized to the plan', () => {
  const bca = Protocol.parse(JSON.parse(readFileSync(new URL('../data/protocols/pierce-bca.json', import.meta.url), 'utf8')));
  const microplate = bca.procedures.find(x => x.id === 'microplate')!;
  /** The wells a scene fills, by its actions. */
  const filled = (scenes: Map<string, { actions: { id: string; set?: { wells?: Record<string, string> } }[] }>, id: string) =>
    [...new Set(scenes.get(id)!.actions.flatMap(a => (a.id === 'plate' && a.set?.wells ? Object.keys(a.set.wells) : [])))].sort();

  it("writes the run's amounts on the arrows and what they make by the tube, in place of the manual's parts", () => {
    const p = protocol([{ id: 'a', name: 'BCA Reagent A' }, { id: 'b', name: 'BCA Reagent B' }], [{ component: 'a', parts: 50 }, { component: 'b', parts: 1 }], 'Prepare WR by mixing 50 parts of BCA Reagent A with 1 part of BCA Reagent B (50:1).', 'WR');
    const s = benchScenes(p, p.procedures[0]!, { mix: { parts: { a: '9.8 mL', b: '196 µL' }, make: '10 mL' } }).get('make')!;
    expect(s.items.filter(i => i.kind === 'arrow').map(i => i.label)).toEqual(['9.8 mL', '196 µL']);
    expect(s.items.find(i => i.kind === 'conical')!.label).toBe('WR · 10 mL');
  });

  it("fills the plan's wells, loading and adding the reagent, and times the incubation chosen", () => {
    const wells = ['A1', 'B1', 'C1', 'D1', 'E1', 'F1', 'G1', 'H1', 'A2', 'B2'];
    const sized = benchScenes(bca, microplate, { wells, incubation: '2 h' });
    expect(filled(sized, 'm-load')).toEqual([...wells].sort());
    expect(filled(sized, 'm-add-wr')).toEqual([...wells].sort());
    expect(sized.get('m-incubate')!.items.find(i => i.kind === 'timer')!.text).toBe('2 h');
    // Without a plan, the manual's own: its standards in duplicate and a plateful of samples, and its 30 minutes.
    const manual = benchScenes(bca, microplate);
    expect(filled(manual, 'm-load').length).toBeGreaterThan(wells.length);
    expect(manual.get('m-incubate')!.items.find(i => i.kind === 'timer')!.text).toBe('30 min');
  });

  it('writes what to do on the pictures drawn big: every amount, and every action with its numbers', () => {
    const big = benchScenes(bca, microplate, { big: true, mix: { parts: { 'reagent-a': '9.8 mL', 'reagent-b': '196 µL' }, make: '10 mL' } });
    const said = (id: string) => [...big.get(id)!.items.flatMap(i => [i.label, i.kind === 'conical' ? i.text : undefined]), ...big.get(id)!.actions.flatMap(a => [a.set?.label, a.set?.text])].filter(Boolean);
    // The parts in the order they go in, and mixing until the colour the manual says.
    expect(said('m-mix')).toEqual(expect.arrayContaining(['① 9.8 mL', '② 196 µL', 'WR · 10 mL', 'Mix until green']));
    // The volume by the pipette, and the shake on the plate.
    expect(said('m-add-wr')).toEqual(expect.arrayContaining(['200 µL', 'Shake 30 s']));
    // The temperature over the incubator, the cover on the plate going in.
    expect(said('m-incubate')).toEqual(expect.arrayContaining(['37 °C', 'Cover']));
    // Cool first, then the wavelength.
    expect(said('m-read')).toEqual(expect.arrayContaining(['Cool to RT', '562 nm']));
    // Each vial takes its own volumes: no one volume is written by the pipette.
    expect(big.get('m-standards')!.items.find(i => i.kind === 'pipette')!.label).toBeUndefined();
  });

  it('takes the working reagent from the tube it was made in, named the same, and from no reservoir the manual lacks', () => {
    const sized = { big: true, mix: { parts: { 'reagent-a': '9.8 mL', 'reagent-b': '196 µL' }, make: '10 mL' } };
    for (const [procId, made, added] of [['microplate', 'm-mix', 'm-add-wr'], ['test-tube', 't-mix', 't-add-wr']] as const) {
      const scenes = benchScenes(bca, bca.procedures.find(x => x.id === procId)!, sized);
      const tube = scenes.get(added)!.items.find(i => i.kind === 'conical');
      expect(tube?.label).toBe(scenes.get(made)!.items.find(i => i.kind === 'conical')!.label);
      expect(tube?.label).toBe('WR · 10 mL');
      expect(scenes.get(added)!.items.some(i => i.kind === 'reservoir')).toBe(false);
    }
  });
});
