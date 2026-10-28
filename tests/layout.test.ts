import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { sampleReadings } from '../shared/fit.ts';
import { Protocol } from '../shared/protocol.ts';
import { runSetup, wellRoles, type RunPlan, type StandardsWay } from '../src/components/lab/model.ts';
import { planFor } from '../src/screens/plan/plan.ts';
import { runPlate } from '../src/screens/results/analysis.ts';
import { benchFor } from '../src/screens/run/model.ts';
import { TravelList } from '../src/screens/share/parts.tsx';
import { buildShare, sharedRunPlan, sharePlate, standardR2, travels } from '../src/screens/share/setup.ts';

// One plan, one plate: Plan draws it, Run loads it, Results reads it back and Share counts it, all through runSetup
// (src/components/lab/model.ts). Every way of making the standards must give the four screens the same wells.

const bca = Protocol.parse(JSON.parse(readFileSync(new URL('../data/protocols/pierce-bca.json', import.meta.url), 'utf8')));

const story: RunPlan = { procedure: 'microplate', samples: 12, replicates: 2, standardReplicates: 2, standards: 'kit' };

/** What each screen's own helper says each well holds. */
function screens(plan: RunPlan) {
  const { procedure, ...numbers } = plan;
  const run = { ...plan, protocolId: 'pierce-bca', photos: {}, readings: {} };
  const shared = buildShare('noresults', run, bca).plan!;
  return {
    plan: wellRoles(planFor(bca, procedure, numbers).plate),
    run: wellRoles(benchFor(bca, plan).plate),
    results: runPlate(bca, plan).roles,
    share: sharePlate(bca, sharedRunPlan(procedure, shared))!.roles,
  };
}

describe('the four screens lay out the same plate', () => {
  const WAYS: [StandardsWay, number, number][] = [
    // way, vials, wells for 12 samples with everything in duplicate
    ['kit', 9, 42],
    ['halve', 8, 40],
    ['five', 5, 34],
    ['ready', 9, 42],
  ];

  it.each(WAYS)('%s: %i vials, %i wells, the same on Plan, Run, Results and Share', (standards, vials, wells) => {
    const plan = { ...story, standards };
    const s = screens(plan);
    expect(s.plan).toHaveLength(wells);
    expect(s.run).toEqual(s.plan);
    expect(s.results).toEqual(s.plan);
    expect(s.share).toEqual(s.plan);
    expect(planFor(bca, 'microplate', { ...plan }).vials).toBe(vials);
    expect(travels({ procedure: 'microplate', plan: buildShare('noresults', { ...plan, protocolId: 'pierce-bca', photos: {}, readings: {} }, bca).plan }, bca).plan!.standards).toBe(vials);
  });

  it.each(['kit', 'halve', 'five', 'ready'] as const)('%s with five standards once and samples ×3: the same wells too', standards => {
    const s = screens({ ...story, standards, standardReplicates: 1, replicates: 3 });
    expect(s.run).toEqual(s.plan);
    expect(s.results).toEqual(s.plan);
    expect(s.share).toEqual(s.plan);
  });

  it('agrees on the working reagent: Plan, Run and Share make 10 mL for the storyboard plate', () => {
    const { procedure, ...numbers } = story;
    expect(planFor(bca, procedure, numbers).reagent.make).toBe(10000);
    expect(benchFor(bca, story).reagent).toEqual(runSetup(bca, story).reagent);
    expect(travels({ procedure, plan: { samples: 12, replicates: 2 } }, bca).plan!.reagentMl).toBe(10);
  });
});

describe('Share reads the sample plate as Results does', () => {
  it('says "12 samples, R² 0.998"', () => {
    const readings = sampleReadings(runSetup(bca, story).roles, bca.analysis!.fit);
    const run = { ...story, protocolId: 'pierce-bca', photos: {}, readings };
    const t = travels(buildShare('all', run, bca, { r2: standardR2(bca, run), sampleData: true }), bca);
    const text = renderToStaticMarkup(createElement(TravelList, { travels: t })).replace(/<[^>]+>/g, '');
    expect(text).toContain('The plan: 9 standards ×2, 12 samples ×2');
    expect(text).toContain('The results: 12 samples, R² 0.998');
  });
});
