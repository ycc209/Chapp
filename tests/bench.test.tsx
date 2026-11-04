import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BenchScene, benchSceneJsonSchema } from '../shared/bench.ts';
import { wellAt } from '../shared/benchArt.ts';
import { benchScenes } from '../shared/benchScenes.ts';
import { Protocol } from '../shared/protocol.ts';
import { BenchView, photoOf, settled } from '../src/components/bench/BenchView.tsx';

// The steps as bench scenes (shared/benchScenes.ts), composed from each protocol here with no model: every step of
// every procedure gets a scene the contract (shared/bench.ts) accepts, the hands-on ones have something on the bench,
// and one bench carries on from step to step.

const dir = new URL('../data/protocols/', import.meta.url);
const protocols = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json')).map(f => Protocol.parse(JSON.parse(readFileSync(new URL(f, dir), 'utf8')))) : [];
const HANDS_ON = new Set(['standards', 'mix', 'load', 'treat', 'wash']);

describe.skipIf(!protocols.length)('bench scenes', () => {
  it.each(protocols.map(p => [p.id, p] as const))('%s: every step is a scene, and draws', (_, p) => {
    for (const proc of p.procedures) {
      const scenes = benchScenes(p, proc);
      for (const step of [...(proc.prep ?? []), ...proc.steps]) {
        const scene = scenes.get(step.id);
        expect(scene, `${proc.id}/${step.id}`).toBeDefined();
        expect(() => BenchScene.parse(scene), step.id).not.toThrow();
        if (HANDS_ON.has(step.stage)) expect(scene!.items.length, `${proc.id}/${step.id}`).toBeGreaterThan(0);
        // Every action is about something on the bench.
        const ids = new Set(scene!.items.map(i => i.id));
        for (const a of scene!.actions) expect(ids.has(a.id), `${step.id}: ${a.id}`).toBe(true);
        // Drawn in a square round what it draws (frame.ts).
        const svg = renderToStaticMarkup(<BenchView scene={scene!} mode="still" />);
        expect(svg).toMatch(/^<svg[^>]*viewBox="-?[\d.]+ -?[\d.]+ ([\d.]+) \1"/);
      }
    }
  });

  it('carries BCA’s bench on: pale standards, the working reagent the colour the protocol gives it, wells that turn', () => {
    const bca = protocols.find(p => p.id === 'pierce-bca');
    if (!bca) return;
    const proc = bca.procedures.find(x => x.format === 'microplate')!;
    const scenes = benchScenes(bca, proc);
    const at = (stage: string, k = 0) => settled(scenes.get(proc.steps.filter(s => s.stage === stage)[k]!.id)!);

    // The vials stand on the bench (no rack), the stock and diluent open behind them, clear of the pipette at the last.
    const standards = at('standards');
    const vials = Object.values(standards).filter(i => i.kind === 'tube');
    expect(vials.map(v => v.label)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']);
    expect(vials.every(v => v.liquid === '#b9d3f0' && v.level! > 0)).toBe(true);
    expect(vials[0]!.source).toMatchObject({ from: 'protocol', field: expect.stringMatching(/^standardCurves\./) });
    const bottles = Object.values(standards).filter(i => i.kind === 'bottle');
    expect(bottles).toHaveLength(2);
    expect(bottles.every(b => b.open)).toBe(true);
    expect(standards.pipette!.x).toBe(vials.at(-1)!.x);
    expect(bottles.every(b => Math.abs(b.x - standards.pipette!.x) > 40)).toBe(true);

    // The parts poured into the open tube, their arrows ending apart.
    const mixing = at('mix');
    expect(mixing.mix!.liquid).toBe('#3aa76d');
    expect(mixing.mix!.open).toBe(true);
    const arrows = Object.values(mixing).filter(i => i.kind === 'arrow');
    // "50 parts" where the manual's own words count in parts; the demo copy, without them, gives the bare shares.
    const inParts = /\bparts?\b/i.test(bca.mixes.find(m => m.id === 'wr')?.cite.quote ?? '');
    expect(arrows.some(i => i.label === (inParts ? '50 parts' : '50'))).toBe(true);
    expect(Math.abs(arrows[0]!.to![1] - arrows[1]!.to![1])).toBeGreaterThanOrEqual(20);

    // Loading the standards and samples: from their vials, behind the plate; the pipette's tip ends just over a well.
    const samples = at('load', 0);
    expect(Object.values(samples).filter(i => i.kind === 'tube')).toHaveLength(9);
    expect(Object.values(samples).every(i => i.kind !== 'tube' || i.y < samples.plate!.y - 90)).toBe(true);
    const last = samples.plate!.y + wellAt(0, Math.ceil(Object.keys(samples.plate!.wells!).length / 8) - 1).y * (samples.plate!.scale ?? 1);
    expect(samples.pipette!.y).toBeGreaterThan(last - 16);

    // Loading the working reagent: its colour, in the wells the samples were loaded into, from its open tube standing
    // clear of the plate.
    const reagent = at('load', 1);
    const loaded = reagent.plate!;
    expect(Object.keys(loaded.wells!).length).toBeGreaterThan(8);
    expect(Object.values(loaded.wells!)).toContain('#3aa76d');
    expect(reagent.mix!.open).toBe(true);
    expect(reagent.mix!.x + 14).toBeLessThan(loaded.x - (184 * loaded.scale!) / 2);

    // At 37 °C into the incubator and out, the wells turned towards purple, more so the stronger the standard: vial A
    // (2000 µg/mL) in A1 and B1, the blank (vial I) in A3 and B3.
    const incubate = scenes.get(proc.steps.find(s => s.stage === 'incubate')!.id)!;
    expect(incubate.items.some(i => i.kind === 'incubator')).toBe(true);
    const wells = settled(incubate).plate!.wells!;
    const red = (h: string) => parseInt(h.slice(1, 3), 16);
    expect(red(wells.A1!)).toBeGreaterThan(red(wells.A3!));
  });

  it('keeps room temperature on the bench', () => {
    const bradford = protocols.find(p => p.id === 'pierce-bradford-plus-protein-assay');
    if (!bradford) return;
    const proc = bradford.procedures.find(x => x.format === 'microplate')!;
    const incubate = benchScenes(bradford, proc).get(proc.steps.find(s => s.stage === 'incubate')!.id)!;
    expect(incubate.items.some(i => i.kind === 'incubator')).toBe(false);
    expect(incubate.items.some(i => i.kind === 'thermometer')).toBe(true);
  });

  it('stands the user’s own bottle where the kit bottle is', () => {
    const bca = protocols.find(p => p.id === 'pierce-bca');
    if (!bca) return;
    const proc = bca.procedures.find(x => x.format === 'microplate')!;
    const mix = benchScenes(bca, proc).get(proc.steps.find(s => s.stage === 'mix')!.id)!;
    const photos = { 'reagent-a': 'data:image/jpeg;base64,AAAA' };
    const bottles = mix.items.filter(i => i.kind === 'bottle');
    expect(bottles.map(b => photoOf(b, photos))).toEqual(['data:image/jpeg;base64,AAAA', undefined]);
    // Only bottles: the working reagent's tube is the user's to make, not a photo.
    expect(mix.items.filter(i => i.kind !== 'bottle').every(i => photoOf(i, photos) === undefined)).toBe(true);
    // Before the photo is cut out (and on the server) the drawn bottle stands in.
    expect(renderToStaticMarkup(<BenchView scene={mix} mode="still" photos={photos} />)).toMatch(/^<svg/);
  });

  it('draws what a step dissolves, and the buffer that goes into it', () => {
    const atp = protocols.find(p => p.id === 'atp-assay');
    if (!atp) return;
    const proc = atp.procedures[0]!;
    const scenes = benchScenes(atp, proc);
    const bottlesOf = (title: string) => {
      const step = [...(proc.prep ?? []), ...proc.steps].find(s => s.title === title)!;
      return scenes.get(step.id)!.items.filter(i => i.kind === 'bottle').map(i => i.id);
    };
    expect(bottlesOf('Dissolve Converter Mix B')).toEqual(['bottle:assay-buffer-23', 'bottle:converter-mix-b']);
    expect(bottlesOf('Dissolve Developer Mix N')).toEqual(['bottle:assay-buffer-23', 'bottle:developer-mix-n']);
    expect(bottlesOf('Reconstitute ATP IV')).toEqual(['bottle:ddh2o', 'bottle:atp-iv']);
    // Into the vial: its level rises, the pipette ends over it, set to the volume the step says.
    const step = [...(proc.prep ?? []), ...proc.steps].find(s => s.title === 'Dissolve Converter Mix B')!;
    const done = settled(scenes.get(step.id)!);
    expect(done['bottle:converter-mix-b']!.level).toBe(0.7);
    expect(done.pipette!.x).toBe(done['bottle:converter-mix-b']!.x);
    expect(done.pipette!.text).toBe('220');
  });

  it('has a contract a model could be asked to fill', () => {
    const schema = benchSceneJsonSchema() as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).toEqual(['title', 'caption', 'items', 'actions']);
  });
});
