import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sampleReadings } from '../shared/fit.ts';
import { Protocol } from '../shared/protocol.ts';
import {
  amountText,
  analyzeRun,
  common,
  commonSay,
  concentrationList,
  concentrationSay,
  countWord,
  curveSay,
  mgText,
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
  tooHighSay,
  volumeSay,
  type RunPlan,
} from '../src/screens/results/analysis.ts';
import { massRows } from '../src/components/lab/model.ts';

// The results screen's numbers and sentences for the real BCA protocol with Chapp's example plate, checked against
// what Results-Swipe(-Volume, -Same, -Curve).dc.html show, and the phrases it understands without a call to Chapp.

const bca = Protocol.parse(JSON.parse(readFileSync(new URL('../data/protocols/pierce-bca.json', import.meta.url), 'utf8')));

/** The storyboard's run: the kit's 9 standards and 12 samples, all in duplicate. */
const story: RunPlan = { procedure: 'microplate', samples: 12, replicates: 2, standardReplicates: 2, standards: 'kit' };

function analyzed(run: RunPlan) {
  const { plan, roles } = runPlate(bca, run);
  const readings = sampleReadings(roles, bca.analysis!.fit);
  return { plan, roles, readings, a: analyzeRun(bca, roles, readings)! };
}

// The artboard's own example data and arithmetic (Results-Swipe.dc.html baseVals), to compare row by row.
const DESIGN: [number | null, number | null][] = [[1240, 3], [860, 5], [1510, 2], [420, 7], [980, 4], [1130, 3], [null, null], [650, 6], [1370, 2], [740, 4], [1050, 3], [590, 8]];
const r1 = (x: number) => (Math.round(x * 10) / 10).toFixed(1);

describe('the storyboard run with the sample plate', () => {
  const { a, plan } = analyzed(story);

  it('lays out the plate the run loaded: 9 standards and 12 samples in duplicate, 42 wells', () => {
    expect(plan.wells).toBe(42);
    expect(plan.tubes.find(t => t.name === 'Sample 1')!.wells).toEqual(['B3', 'B4']);
  });

  it('page 1: µg/mL and CV as Results-Swipe shows them, and what to do about Sample 7', () => {
    expect(concentrationList(a).map(r => [r.value, r.side])).toEqual(
      DESIGN.map(([c, v]) => (c === null ? ['> 2,000', '—'] : [c.toLocaleString('en-US'), `${v} %`])),
    );
    expect(sayText(concentrationSay(a))).toBe('11 of 12 samples are in range. Sample 7 is above the top standard: dilute it 1:5 and run it again.');
    expect(concentrationSay(a)).toContainEqual({ b: '1:5' });
    expect(rerunLabel(a)).toBe('Rerun Sample 7');
    expect(reruns(a)).toEqual([{ ref: '7', dilution: 5 }]);
  });

  it('page 2: µL for 20 µg, row for row as the design works them out', () => {
    const m = massRows(a, 20);
    // Worked out from the concentrations the readings give, which read back to the design's own to 4 decimals of
    // absorbance, so every row is the design's arithmetic exactly (19.0 for "1,050").
    expect(m.rows.map(r => r.value)).toEqual(['16.1', '23.3', '13.2', '47.6', '20.4', '17.7', 'rerun', '30.8', '14.6', '27.0', '19.0', '33.9']);
    m.rows.forEach((r, i) => {
      const c = DESIGN[i]![0];
      if (c !== null) expect(r.value).toBe(r1((20 / c) * 1000));
    });
    expect(sayText(volumeSay(a, 20))).toBe('For 20 µg, Sample 4 needs the most: 47.6 µL. Plan lanes of at least 50 µL.');
  });

  it('page 2 follows another amount: 30 µg', () => {
    expect(sayText(volumeSay(a, 30))).toBe('For 30 µg, Sample 4 needs the most: 71.4 µL. Plan lanes of at least 100 µL.');
    expect(massRows(a, 30).rows[0]!.value).toBe('24.2');
  });

  it('page 3: everything at 0.4 mg/mL, take and buffer per 100 µL', () => {
    const c = common(a)!;
    expect([c.target, c.ceiling, c.lowest, c.count]).toEqual([400, 400, '4', 11]);
    c.rows.forEach((r, i) => {
      const v = DESIGN[i]![0];
      if (v === null) return expect([r.value, r.side, r.note]).toEqual(['rerun', '', true]);
      expect([r.value, r.side]).toEqual([r1((400 / v) * 100), r1(100 - (400 / v) * 100)]);
      expect(Number(r.value) + Number(r.side)).toBeCloseTo(100, 6);
    });
    expect(c.rows.slice(0, 4).map(r => `${r.value} · ${r.side}`)).toEqual(['32.3 · 67.7', '46.5 · 53.5', '26.5 · 73.5', '95.2 · 4.8']);
    expect(c.rows.filter(r => r.mark).map(r => r.n)).toEqual(['4']);
    expect(sayText(commonSay(c))).toBe('0.4 mg/mL is the highest all eleven can reach; Sample 4 is only 420 µg/mL. For 100 µL of each: take, then buffer.');
  });

  it('page 3 at a lower concentration asked for, and one that is too high', () => {
    const c = common(a, 250)!;
    expect(c.target).toBe(250);
    expect(c.rows[0]).toMatchObject({ value: '20.2', side: '79.8' });
    expect(sayText(commonSay(c))).toBe('All eleven at 0.25 mg/mL. For 100 µL of each: take, then buffer.');
    expect(common(a, 600)!.target).toBe(400);
    expect(sayText(tooHighSay(common(a)!, 600))).toBe('0.6 mg/mL is too high: Sample 4 is only 420 µg/mL. 0.4 mg/mL is the highest all eleven can reach.');
  });

  it('page 4: the curve fits well, R² 0.998, and the tabs read as drawn', () => {
    expect(a.fit.kind).toBe('4pl');
    expect(r2Text(a.fit.r2)).toBe('0.998');
    expect(sayText(curveSay(a))).toBe('The curve fits well: R² 0.998. Sample 7 sits above the top standard, 2,000 µg/mL.');
    expect(tabLabels(20, common(a))).toEqual(['µg/mL', '20 µg', '0.4 mg/mL', 'Curve']);
    expect(tabLabels(2.5, common(a, 250))).toEqual(['µg/mL', '2.5 µg', '0.25 mg/mL', 'Curve']);
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
    expect(concentrationList(a).map(r => r.value)).toEqual(DESIGN.map(([c]) => (c === null ? '> 2,000' : c.toLocaleString('en-US'))));
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
    expect(sayText(curveSay(a))).toBe('The curve fits well: R² 0.998.');
    expect(rerunLabel(a)).toBeNull();
    const many = analyzed({ ...story, samples: 19 }).a;
    expect(many.samples.filter(s => s.flag === 'above').map(s => [s.ref, s.dilution])).toEqual([['7', 5], ['19', 5]]);
    expect(sayText(concentrationSay(many))).toBe('17 of 19 samples are in range. Samples 7 and 19 are above the top standard: dilute them 1:5 and run them again.');
    expect(rerunLabel(many)).toBe('Rerun 2 samples');
  });
});

describe('words and numbers', () => {
  it('formats amounts, concentrations, counts and names', () => {
    expect([amountText(20), amountText(2.5), amountText(12.345)]).toEqual(['20', '2.5', '12.35']);
    expect([mgText(400), mgText(250), mgText(1000)]).toEqual(['0.4', '0.25', '1']);
    expect([countWord(11), countWord(12), countWord(30)]).toEqual(['eleven', 'twelve', '30']);
    expect([sampleNames(['7']), sampleNames(['7', '9']), sampleNames(['3', '7', '9'])]).toEqual(['Sample 7', 'Samples 7 and 9', 'Samples 3, 7 and 9']);
    // As drawn (0.9979 → 0.998), but a fit short of perfect never shows as 1.000.
    expect([r2Text(0.9979), r2Text(0.99849), r2Text(0.99999), r2Text(1)]).toEqual(['0.998', '0.998', '0.999', '1.000']);
  });
});

describe('what is understood on the phone', () => {
  it('hears another amount', () => {
    expect(parseHeard('How much for 30 µg?')).toEqual({ kind: 'amount', micrograms: 30 });
    expect(parseHeard('how much for 30 μg')).toEqual({ kind: 'amount', micrograms: 30 });
    expect(parseHeard('What about 15 micrograms?')).toEqual({ kind: 'amount', micrograms: 15 });
    expect(parseHeard('and for 2.5ug')).toEqual({ kind: 'amount', micrograms: 2.5 });
    expect(parseHeard('twenty five micrograms')).toEqual({ kind: 'amount', micrograms: 25 });
    expect(parseHeard('how much for thirty mcg')).toEqual({ kind: 'amount', micrograms: 30 });
    expect(parseHeard('10 µg')).toEqual({ kind: 'amount', micrograms: 10 });
  });

  it('hears a concentration for all, never as an amount', () => {
    expect(parseHeard('All at 0.25 mg/mL')).toEqual({ kind: 'common', microgramsPerMl: 250 });
    expect(parseHeard('0.3 mg per ml please')).toEqual({ kind: 'common', microgramsPerMl: 300 });
    expect(parseHeard('bring them to 250 µg/mL')).toEqual({ kind: 'common', microgramsPerMl: 250 });
    expect(parseHeard('200 micrograms per milliliter')).toEqual({ kind: 'common', microgramsPerMl: 200 });
  });

  it('hears the example plate, Share and the pages', () => {
    expect(parseHeard('Here’s a sample plate-reader export.')).toEqual({ kind: 'sample' });
    expect(parseHeard('use the sample data')).toEqual({ kind: 'sample' });
    expect(parseHeard('Share')).toEqual({ kind: 'share' });
    expect(parseHeard('share the results')).toEqual({ kind: 'share' });
    expect(parseHeard('Show me the curve')).toEqual({ kind: 'page', page: 'curve' });
    expect(parseHeard('the standard curve')).toEqual({ kind: 'page', page: 'curve' });
    expect(parseHeard('go to concentrations')).toEqual({ kind: 'page', page: 'conc' });
    expect(parseHeard('volumes')).toEqual({ kind: 'page', page: 'volume' });
  });

  it('leaves everything else to Chapp', () => {
    for (const said of ['Why is the curve bent?', 'Rerun sample 7', 'next', '12 samples', 'Is sample 3 OK?', 'save as PDF', '']) {
      expect(parseHeard(said), said).toBeNull();
    }
  });
});
