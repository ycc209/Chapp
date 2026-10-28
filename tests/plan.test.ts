import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Protocol } from '../shared/protocol.ts';
import { parsePlan, type PlanWords } from '../src/screens/plan/parse.ts';
import { fitPlan, halvingTop, planFor, planLine, repWord, sentenceOrder, startStep, tidySaid, wayCounts, type PlanNumbers } from '../src/screens/plan/plan.ts';

// The plan screen: what said aloud becomes (parse.ts), and the numbers the storyboard's scene ④ shows (plan.ts).
const BCA: PlanWords = { counts: { kit: 9, halve: 8, five: 5 }, top: 2000 };
const parse = (text: string) => parsePlan(text, BCA);

describe('a plan said in one breath', () => {
  it('reads the storyboard lines', () => {
    expect(parse('12 samples, in duplicate')).toEqual({ samples: 12, replicates: 2 });
    expect(parse('12 samples in duplicate')).toEqual({ samples: 12, replicates: 2 });
    expect(parse('Make it triplicates')).toEqual({ replicates: 3, standardReplicates: 3 });
    // And back again, as the storyboard's scene ④ ends.
    expect(parse('back to duplicates')).toEqual({ replicates: 2, standardReplicates: 2 });
    expect(parse('in duplicate again')).toEqual({ replicates: 2, standardReplicates: 2 });
    expect(parse('five standards once, samples ×3')).toEqual({ standards: 'five', standardReplicates: 1, replicates: 3 });
    expect(parse('Five standards, once. Samples in triplicate.')).toEqual({ standards: 'five', standardReplicates: 1, replicates: 3 });
  });

  it('reads the four ways to make the standards', () => {
    expect(parse("the kit's 9")).toEqual({ standards: 'kit' });
    expect(parse('Kit’s nine standards in duplicate')).toEqual({ standards: 'kit', standardReplicates: 2 });
    expect(parse('Halve from 2,000')).toEqual({ standards: 'halve' });
    expect(parse('8 standards')).toEqual({ standards: 'halve' });
    expect(parse("They're already made")).toEqual({ standards: 'ready' });
    expect(parse('5 vials')).toEqual({ standards: 'five' });
  });

  it('gives a replicate word to what it is said with', () => {
    expect(parse('in duplicate')).toEqual({ replicates: 2, standardReplicates: 2 });
    expect(parse('samples in triplicate')).toEqual({ replicates: 3 });
    expect(parse('triplicate samples')).toEqual({ replicates: 3 });
    expect(parse('standards once')).toEqual({ standardReplicates: 1 });
    expect(parse('12 samples and 9 standards, all in duplicate')).toEqual({ samples: 12, standards: 'kit', replicates: 2, standardReplicates: 2 });
    expect(parse('twenty four samples, 3 times')).toEqual({ samples: 24, replicates: 3 });
    expect(parse('samples 2x')).toEqual({ replicates: 2 });
    expect(parse('okay, 12 samples please')).toEqual({ samples: 12 });
  });

  it('leaves everything else to Chapp', () => {
    for (const text of ['next', 'A is OK', 'What if it turns cloudy when I add B?', '12 samples?', 'six standards', 'halve from 1,000', '12', 'start', 'I made 12 samples', '200 samples', '']) {
      expect(parse(text), text).toBeNull();
    }
  });
});

describe('plan wording', () => {
  it('says replicates and orders the sentence as Plan.dc.html', () => {
    expect([1, 2, 3].map(repWord)).toEqual(['once', 'in duplicate', 'in triplicate']);
    const p = (replicates: number, standardReplicates: number): PlanNumbers => ({ samples: 12, replicates, standardReplicates, standards: 'kit' });
    expect(sentenceOrder(p(2, 2), true)).toBe('same');
    expect(sentenceOrder(p(3, 1), false)).toBe('differ');
    expect(sentenceOrder(p(3, 1), true)).toBe('standardsFirst');
    expect(startStep('kit')).toBe(0);
    expect(startStep('ready')).toBe(1);
    expect(tidySaid('five standards once, samples ×3')).toBe('Five standards once, samples ×3.');
  });
});

const file = new URL('../data/protocols/pierce-bca.json', import.meta.url);
const local = existsSync(file);

describe.skipIf(!local)('the storyboard run (Pierce BCA)', () => {
  const doc = local ? Protocol.parse(JSON.parse(readFileSync(file, 'utf8'))) : (null as never);
  const plan = (p: Partial<PlanNumbers>) => planFor(doc, 'microplate', { samples: 12, replicates: 2, standardReplicates: 2, standards: 'kit', ...p });

  it('knows how many vials each way makes', () => {
    expect(wayCounts(doc, 'microplate')).toEqual(BCA.counts);
    expect(halvingTop(doc, 'microplate')).toBe(2000);
  });

  it('12 samples in duplicate: 42 wells, 10 mL, the kit’s 9 sized as Plan-Full', () => {
    const v = plan({});
    expect(v.plate.wells).toBe(42);
    expect(v.reagent.make).toBe(10000);
    expect(v.wayName).toBe('Kit’s 9');
    expect([v.series.stock, v.series.diluent, v.series.minLeft, v.series.need]).toEqual([400, 960, 120, 50]);
    expect(v.range).toBe('20 to 2,000 µg/mL');
    expect(v.firstSample).toBe('B3 · B4');
    expect(v.max).toBe(39);
    expect(planLine(v, { picked: true, heard: false, still: false })).toBe('12 samples and 9 standards, all in duplicate: 42 wells, 10 mL of working reagent.');
  });

  it('make it triplicates: 63 wells, 15 mL', () => {
    const v = plan({ replicates: 3, standardReplicates: 3 });
    expect(v.plate.wells).toBe(63);
    expect(v.reagent.make).toBe(15000);
  });

  it('five standards once, samples ×3: 41 wells, still 10 mL (Plan-Heard)', () => {
    const v = plan({ standards: 'five', standardReplicates: 1, replicates: 3 });
    expect(v.plate.wells).toBe(41);
    expect(v.wayName).toBe('5 vials');
    expect([v.series.stock, v.series.diluent, v.series.minLeft, v.series.need]).toEqual([100, 200, 50, 25]);
    expect(planLine(v, { picked: true, heard: true, still: true })).toBe('5 standards once and 12 samples in triplicate: 41 wells, still 10 mL of working reagent.');
  });

  it('halving from 2,000 makes 8 vials; already made draws the kit’s 9 with nothing to make', () => {
    expect(plan({ standards: 'halve' }).vials).toBe(8);
    const ready = plan({ standards: 'ready' });
    expect([ready.vials, ready.series.stock, ready.series.diluent, ready.wayName]).toEqual([9, 0, 0, 'Already made']);
  });

  it('brings the samples down to what fits on one plate', () => {
    expect(fitPlan(doc, 'microplate', { samples: 40, replicates: 3, standardReplicates: 3, standards: 'kit' }).samples).toBe(23);
    expect(fitPlan(doc, 'microplate', { samples: 12, replicates: 2, standardReplicates: 2, standards: 'kit' }).samples).toBe(12);
  });
});
