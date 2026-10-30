import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BenchScene, benchSceneJsonSchema } from '../shared/bench.ts';
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
        const svg = renderToStaticMarkup(<BenchView scene={scene!} mode="still" />);
        expect(svg).toMatch(/^<svg[^>]*viewBox="0 0 240 240"/);
      }
    }
  });

  it('carries BCA’s bench on: clear standards, the working reagent the colour the protocol gives it, wells that turn', () => {
    const bca = protocols.find(p => p.id === 'pierce-bca');
    if (!bca) return;
    const proc = bca.procedures.find(x => x.format === 'microplate')!;
    const scenes = benchScenes(bca, proc);
    const at = (stage: string, k = 0) => settled(scenes.get(proc.steps.filter(s => s.stage === stage)[k]!.id)!);

    const standards = at('standards');
    const vials = Object.values(standards).filter(i => i.kind === 'tube');
    expect(vials.map(v => v.label)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']);
    expect(vials.every(v => v.liquid === '#e3eef8' && v.level! > 0)).toBe(true);
    expect(vials[0]!.source).toMatchObject({ from: 'protocol', field: expect.stringMatching(/^standardCurves\./) });

    const mix = at('mix').mix!;
    expect(mix.liquid).toBe('#3aa76d');
    expect(Object.values(at('mix')).some(i => i.kind === 'arrow' && i.label === '50 parts')).toBe(true);

    // Loading the working reagent: its colour, in the wells the samples were loaded into.
    const loaded = at('load', 1).plate!;
    expect(Object.keys(loaded.wells!).length).toBeGreaterThan(8);
    expect(Object.values(loaded.wells!)).toContain('#3aa76d');

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
