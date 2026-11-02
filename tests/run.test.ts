import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Protocol } from '../shared/protocol.ts';
import {
  benchFor,
  currentTube,
  loadUpTo,
  parsePlateExport,
  spoken,
  standardsLine,
  standardsText,
  stepFromParam,
  tickUpTo,
  timerPhase,
  tubeKey,
  tubeText,
  tubesLoaded,
  type RunPlan,
} from '../src/screens/run/model.ts';

// The run screen's numbers and words, checked against the Run-* and Gloves-* artboards for the storyboard's run.
const file = new URL('../data/protocols/pierce-bca.json', import.meta.url);
const bca = existsSync(file) ? Protocol.parse(JSON.parse(readFileSync(file, 'utf8'))) : null;
const story: RunPlan = { procedure: 'microplate', samples: 12, replicates: 2, standardReplicates: 2, standards: 'kit' };

describe.runIf(bca)('the bench, from the protocol and the plan', () => {
  const b = benchFor(bca!, story);

  it('has the design’s six steps', () => {
    expect(b.steps.map(s => s.title)).toEqual(['Standards', 'Working reagent', 'Load the plate', 'Add the reagent', 'Incubate', 'Read']);
  });

  it('sizes everything as drawn: 9 vials, 21 tubes, 42 wells, 10 mL of reagent, 25 µL in each well', () => {
    expect(b.series.vials.map(v => v.id).join('')).toBe('ABCDEFGHI');
    expect(b.plate.tubes).toHaveLength(21);
    expect(b.plate.wells).toBe(42);
    expect(b.reagent.make).toBe(10000);
    expect(b.load).toBe(25);
    expect(b.add).toEqual({ volume: 200, shake: '30 s' });
    expect(b.readout).toMatchObject({ value: 562, unit: 'nm' });
  });

  it('offers the protocol’s incubation and its documented alternative: 30 min or 2 h at 37 °C, covered', () => {
    expect(b.incubation).toMatchObject({ id: 'm-incubate', temperature: '37 °C', covered: true });
    expect(b.incubation!.options.map(o => [o.seconds, o.label, o.standard])).toEqual([
      [1800, '30 min', true],
      [7200, '2 h', false],
    ]);
  });

  it('takes its standards from the plan: five standards once, samples in triplicate (41 wells)', () => {
    const five = benchFor(bca!, { ...story, standards: 'five', standardReplicates: 1, replicates: 3 });
    expect(five.series.vials.map(v => v.id).join('')).toBe('ABCDE');
    expect(five.plate.wells).toBe(41);
    expect(five.ready).toBe(false);
  });

  it('keeps the standards step when they are already made', () => {
    const ready = benchFor(bca!, { ...story, standards: 'ready' });
    expect(ready.ready).toBe(true);
    expect(ready.steps[0]!.title).toBe('Standards');
    expect(ready.series.vials).toHaveLength(9);
  });

  it('says the vial to make next, the last one, and all done (Run-Standards)', () => {
    const vials = b.series.vials;
    const abc = { A: true, B: true, C: true };
    expect(standardsText(standardsLine(vials, abc), 'the working reagent')).toBe('3 of 9 done. Next is D: 70 µL from B and 70 µL of diluent.');
    const eight = Object.fromEntries(vials.slice(0, 8).map(v => [v.id, true]));
    expect(standardsText(standardsLine(vials, eight), 'the working reagent')).toBe('Last one, I: 160 µL of diluent, nothing else. That’s the blank.');
    const all = Object.fromEntries(vials.map(v => [v.id, true]));
    expect(standardsText(standardsLine(vials, all), 'the working reagent')).toBe('All 9 standards are ready. Next, the working reagent.');
  });

  it('loads tube by tube: tube 10 of 21 is Sample 1 into B3 and B4 (Run-Load)', () => {
    const nine = Object.fromEntries(b.plate.tubes.slice(0, 9).map(t => [tubeKey(t.index), true]));
    expect(currentTube(b.plate, nine)).toBe(9);
    expect(tubesLoaded(b.plate, nine)).toBe(9);
    expect(tubeText(b.plate, 9, b.load)).toBe('Tube 10 of 21. Sample 1 into B3 and B4, 25 µL in each.');
    expect(tubeText(b.plate, 21, b.load)).toBe('All 42 wells are loaded.');
    // Tapping tube 10 loads it; tapping tube 3 takes it and everything after it back off.
    expect(currentTube(b.plate, loadUpTo(b.plate, nine, 9, true))).toBe(10);
    expect(currentTube(b.plate, loadUpTo(b.plate, nine, 2, false))).toBe(2);
  });
});

describe('ticking vials', () => {
  const vials = 'ABCDEFGHI'.split('').map(id => ({ id }));
  it('catches up: ticking E ticks A–E', () => {
    const t = tickUpTo(vials, { A: true }, 'E', true);
    expect(Object.entries(t).filter(([, on]) => on).map(([id]) => id).join('')).toBe('ABCDE');
  });
  it('undoes in mirror: unticking C unticks C and everything after it', () => {
    const t = tickUpTo(vials, { A: true, B: true, C: true, D: true }, 'C', false);
    expect(Object.entries(t).filter(([, on]) => on).map(([id]) => id).join('')).toBe('AB');
  });
});

describe('the address', () => {
  it('counts steps from 1, like the artboards, and has the list at /run/all', () => {
    expect(stepFromParam('1', 6)).toBe(0);
    expect(stepFromParam('6', 6)).toBe(5);
    expect(stepFromParam('9', 6)).toBe(5);
    expect(stepFromParam('all', 6)).toBe('all');
    expect(stepFromParam('x', 6)).toBe(0);
  });
});

describe('the timer', () => {
  it('is to choose, running, stopped part-way, or done', () => {
    expect(timerPhase(undefined, undefined, 1000)).toBe('choose');
    expect(timerPhase(5000, undefined, 1000)).toBe('running');
    expect(timerPhase(500, undefined, 1000)).toBe('done');
    expect(timerPhase(undefined, 1477, 1000)).toBe('stopped');
  });
});

describe('how units are spoken at the bench', () => {
  it('reads units out loud in words', () => {
    expect(spoken('Next is D: 70 µL from B and 70 µL of diluent.')).toBe('Next is D: 70 microliters from B and 70 microliters of diluent.');
    expect(spoken('Timer started: 30 min at 37 °C.')).toBe('Timer started: 30 minutes at 37 degrees.');
    expect(spoken('Make 10 mL; read at 562 nm. 2 h, 1 h, 30 s.')).toBe('Make 10 milliliters; read at 562 nanometers. 2 hours, 1 hour, 30 seconds.');
  });
});

describe('a plate reader’s export', () => {
  const grid = (sep: string, decimal = '.') =>
    [
      `Plate 1${sep}562 nm`,
      ['', ...Array.from({ length: 12 }, (_, i) => String(i + 1))].join(sep),
      ...'ABCDEFGH'.split('').map((r, ri) => [r, ...Array.from({ length: 12 }, (_, c) => (0.1 + ri * 0.1 + c * 0.01).toFixed(3).replace('.', decimal))].join(sep)),
    ].join('\n');

  it('reads a CSV grid, row letter first', () => {
    const r = parsePlateExport(grid(','))!;
    expect(Object.keys(r)).toHaveLength(96);
    expect(r.A1).toBe(0.1);
    expect(r.B3).toBe(0.22);
    expect(r.H12).toBe(0.91);
  });

  it('reads tab-separated exports with decimal commas', () => {
    const r = parsePlateExport(grid('\t', ','))!;
    expect(r.C2).toBe(0.31);
  });

  it('keeps only the first grid and skips a layout of names', () => {
    const names = 'ABCDEFGH'.split('').map(r => [r, ...Array.from({ length: 12 }, () => 'STD')].join(',')).join('\n');
    const twice = `${names}\n${grid(',')}\n${grid(',').replace(/0\.1/g, '9.1')}`;
    expect(parsePlateExport(twice)!.A1).toBe(0.1);
  });

  it('finds nothing in a file without a grid', () => {
    expect(parsePlateExport('Hello\nThis is not a plate')).toBeNull();
  });
});
