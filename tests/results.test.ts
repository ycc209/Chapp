import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyzePlate, sampleReadings } from '../shared/fit.ts';
import { Protocol } from '../shared/protocol.ts';
import {
  PAGES,
  analyzeRun,
  concentrationList,
  concentrationSay,
  curveSay,
  parseHeard,
  planStandards,
  r2Text,
  rerunLabel,
  reruns,
  runPlate,
  sameWells,
  sampleNames,
  sayText,
  tabLabels,
  type RunPlan,
} from '../src/screens/results/analysis.ts';

// The results screen's numbers and sentences for the real BCA protocol with Chapp's example plate: the example
// readings checked against Results-Swipe.dc.html on the kit's own curve, the samples as the screen reads them off the
// straight regression line, and the phrases it understands without a call to Chapp.

const bca = Protocol.parse(JSON.parse(readFileSync(new URL('../data/protocols/pierce-bca.json', import.meta.url), 'utf8')));

/** The storyboard's run: the kit's 9 standards and 12 samples, all in duplicate. */
const story: RunPlan = { procedure: 'microplate', samples: 12, replicates: 2, standardReplicates: 2, standards: 'kit' };

function analyzed(run: RunPlan) {
  const { plan, roles } = runPlate(bca, run);
  // The built-in example, its samples placed on the straight line Results reads them with.
  const readings = sampleReadings(roles);
  return { plan, roles, readings, a: analyzeRun(bca, roles, readings)! };
}

// The artboard's own example data and arithmetic (Results-Swipe.dc.html baseVals), to compare row by row.
const DESIGN: [number | null, number | null][] = [[1240, 3], [860, 5], [1510, 2], [420, 7], [980, 4], [1130, 3], [null, null], [650, 6], [1370, 2], [740, 4], [1050, 3], [590, 8]];
const designList = () => DESIGN.map(([c, v]) => (c === null ? ['> 2,000', '—'] : [c.toLocaleString('en-US'), `${v} %`]));

describe('the storyboard run with the sample plate', () => {
  const { a, plan } = analyzed(story);

  it('lays out the plate the run loaded: 9 standards and 12 samples in duplicate, 42 wells', () => {
    expect(plan.wells).toBe(42);
    expect(plan.tubes.find(t => t.name === 'Sample 1')!.wells).toEqual(['B3', 'B4']);
  });

  it('the example readings follow the demo sheet’s BCA curve, which the kit’s four-parameter fit fits too', () => {
    const { roles, readings } = analyzed(story);
    const kit = analyzePlate(roles, readings, bca.analysis!.fit);
    expect(kit.fit.kind).toBe('4pl');
    expect(r2Text(kit.fit.r2)).toBe('0.999');
  });

  it('page µg/mL: every sample read off the straight regression line, x = (y − intercept) / slope', () => {
    if (a.fit.kind !== 'linear') throw new Error(`expected the straight line, not ${a.fit.kind}`);
    const { slope, intercept } = a.fit;
    for (const s of a.samples.filter(s => s.flag === 'ok')) expect(s.concentration!).toBeCloseTo((s.mean! - intercept) / slope, 9);
    // The design's own values and CVs (Results-Swipe baseVals), read back exactly.
    expect(concentrationList(a).map(r => [r.value, r.side])).toEqual(designList());
    expect(sayText(concentrationSay(a))).toBe('11 of 12 samples are in range. Sample 7 is above the top standard: dilute it 1:5 and run it again.');
    expect(concentrationSay(a)).toContainEqual({ b: '1:5' });
    expect(rerunLabel(a)).toBe('Rerun Sample 7');
    expect(reruns(a)).toEqual([{ ref: '7', dilution: 5 }]);
  });

  it('the curve page: the straight line fits the example plate (R² 0.994); the curve tab first', () => {
    expect(r2Text(a.fit.r2)).toBe('0.994');
    expect(sayText(curveSay(a))).toBe('The curve fits well. Sample 7 sits above the top standard, 2,000 µg/mL.');
    expect(PAGES).toEqual(['curve', 'conc']);
    expect(tabLabels()).toEqual(['Curve', 'µg/mL']);
    expect(tabLabels('nmol/well')).toEqual(['Curve', 'nmol/well']);
  });
});

describe('the analysis follows the plan', () => {
  it('five standards once, samples in triplicate: 41 wells, the same samples read back', () => {
    const run: RunPlan = { procedure: 'microplate', samples: 12, replicates: 3, standardReplicates: 1, standards: 'five' };
    expect(planStandards(bca, run).map(v => v.concentration)).toEqual([2000, 1000, 500, 250, 0]);
    const { plan, a } = analyzed(run);
    expect(plan.wells).toBe(41);
    expect(a.standards).toHaveLength(5);
    expect(a.standards.every(s => s.wells.length === 1)).toBe(true);
    expect(a.samples.every(s => s.wells.length === 3)).toBe(true);
    expect(a.range).toEqual({ min: 250, max: 2000 });
    expect(concentrationList(a).map(r => r.value)).toEqual(designList().map(([value]) => value));
    expect(sayText(concentrationSay(a))).toBe('11 of 12 samples are in range. Sample 7 is above the top standard: dilute it 1:5 and run it again.');
  });

  it('halving from 2,000: eight vials', () => {
    const run: RunPlan = { ...story, standards: 'halve' };
    expect(planStandards(bca, run).map(v => v.concentration)).toEqual([2000, 1000, 500, 250, 125, 62.5, 31.25, 0]);
    expect(analyzed(run).a.samples).toHaveLength(12);
  });

  it('notices readings laid out for another plan', () => {
    const { roles, readings } = analyzed(story);
    expect(sameWells(readings, roles)).toBe(true);
    expect(sameWells(readings, runPlate(bca, { ...story, replicates: 3 }).roles)).toBe(false);
    expect(analyzeRun(bca, roles, {})).toBeNull();
  });

  it('says it plainly when nothing is out of range, or several are', () => {
    const { a } = analyzed({ ...story, samples: 6 });
    expect(sayText(concentrationSay(a))).toBe('All 6 samples are in range.');
    expect(sayText(curveSay(a))).toBe('The curve fits well.');
    expect(rerunLabel(a)).toBeNull();
    const many = analyzed({ ...story, samples: 19 }).a;
    expect(many.samples.filter(s => s.flag === 'above').map(s => [s.ref, s.dilution])).toEqual([['7', 5], ['19', 5]]);
    expect(sayText(concentrationSay(many))).toBe('17 of 19 samples are in range. Samples 7 and 19 are above the top standard: dilute them 1:5 and run them again.');
    expect(rerunLabel(many)).toBe('Rerun 2 samples');
  });
});

describe('words and numbers', () => {
  it('formats names and R²', () => {
    expect([sampleNames(['7']), sampleNames(['7', '9']), sampleNames(['3', '7', '9'])]).toEqual(['Sample 7', 'Samples 7 and 9', 'Samples 3, 7 and 9']);
    // As drawn (0.9979 → 0.998), but a fit short of perfect never shows as 1.000.
    expect([r2Text(0.9979), r2Text(0.99849), r2Text(0.99999), r2Text(1)]).toEqual(['0.998', '0.998', '0.999', '1.000']);
  });
});

describe('what is understood on the phone', () => {
  it('hears the example plate, Share and the pages', () => {
    expect(parseHeard('Here’s a sample plate-reader export.')).toEqual({ kind: 'sample' });
    expect(parseHeard('use the sample data')).toEqual({ kind: 'sample' });
    expect(parseHeard('Share')).toEqual({ kind: 'share' });
    expect(parseHeard('share the results')).toEqual({ kind: 'share' });
    expect(parseHeard('Show me the curve')).toEqual({ kind: 'page', page: 'curve' });
    expect(parseHeard('the standard curve')).toEqual({ kind: 'page', page: 'curve' });
    expect(parseHeard('go to concentrations')).toEqual({ kind: 'page', page: 'conc' });
    expect(parseHeard('show the protein concentration')).toEqual({ kind: 'page', page: 'conc' });
  });

  it('leaves everything else to Chapp, the amounts and dilutions that had pages of their own included', () => {
    const asked = ['How much for 30 µg?', 'All at 0.25 mg/mL', 'volumes', 'same concentration'];
    for (const said of [...asked, 'Why is the curve bent?', 'Rerun sample 7', 'next', '12 samples', 'Is sample 3 OK?', 'save as PDF', '']) {
      expect(parseHeard(said), said).toBeNull();
    }
  });
});
