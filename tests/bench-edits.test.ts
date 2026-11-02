import { existsSync, readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { Protocol } from '../shared/protocol.ts';
import { authorize, names, type Rules } from '../server/ai/authorize.ts';
import { checkReply } from '../server/ai/meta.ts';
import { editPlate, freeWells, plateMap, runSetup, standardsFor, wellRoles, NO_EDITS } from '../src/components/lab/model.ts';
import { redoVials, tubeKey } from '../src/screens/run/model.ts';
import { addWells, moveWells, redo } from '../src/state/benchEdits.ts';
import { useRun } from '../src/state/run.ts';

// Changes said at the bench: several vials or tubes at once, one to do again, a well gone wrong, a well or a condition
// added (src/components/lab/model.ts editPlate, src/state/benchEdits.ts,
// server/ai/authorize.ts). No network.

const file = new URL('../data/protocols/pierce-bca.json', import.meta.url);
const bca = existsSync(file) ? Protocol.parse(JSON.parse(readFileSync(file, 'utf8'))) : null;
const standards = [
  { id: 'A', concentration: 2000, blank: false },
  { id: 'B', concentration: 1000, blank: false },
  { id: 'C', concentration: 0, blank: true },
];
// 3 standards × 2 and 4 samples × 2: A1–C2, then samples D1–G2 (one 2-wide block down the rows).
const plan = plateMap({ standards, standardReplicates: 2, samples: 4, sampleReplicates: 2 });

describe('editPlate', () => {
  it('leaves a well gone wrong empty and puts what it held in the well chosen', () => {
    const out = editPlate(plan, { moved: { D1: 'H1' }, added: [] });
    expect(out.bad).toEqual(['D1']);
    expect(out.cells.find(c => c.well === 'D1')).toBeUndefined();
    expect(out.cells.find(c => c.well === 'H1')).toMatchObject({ tube: 3, replicate: 1 });
    expect(out.tubes[3]!.wells).toEqual(['H1', 'D2']);
    // Read where it is now; the bad well not at all.
    expect(wellRoles(out).find(r => r.well === 'H1')).toEqual({ well: 'H1', kind: 'sample', ref: '1' });
    expect(wellRoles(out).some(r => r.well === 'D1')).toBe(false);
  });

  it('adds wells to a tube on the plate, or a new sample numbered after the last', () => {
    const out = editPlate(plan, { moved: {}, added: [{ name: 'sample 2', of: '2', wells: ['H1'] }, { name: 'heat shock', wells: ['A3', 'A4'] }] });
    expect(out.tubes[4]!.wells).toEqual(['E1', 'E2', 'H1']);
    expect(out.tubes.at(-1)).toMatchObject({ kind: 'sample', ref: '5', name: 'Sample 5', label: 'heat shock', wells: ['A3', 'A4'] });
    expect(out.wells).toBe(plan.wells + 3);
  });

  it('moves a well of the plan out of the way of a well an edit took', () => {
    // A sample added in H1 while the plan had 4 samples; the plan grows to 5, whose layout wants H1.
    const grown = plateMap({ standards, standardReplicates: 2, samples: 5, sampleReplicates: 2 });
    const out = editPlate(grown, { moved: {}, added: [{ name: 'control', wells: ['H1'] }] });
    const wells = out.cells.map(c => c.well);
    expect(new Set(wells).size).toBe(wells.length);
    expect(out.cells.find(c => c.well === 'H1')!.tube).toBe(out.tubes.length - 1);
  });

  it('finds free wells side by side, walking down the columns', () => {
    expect(freeWells(plan, 1)).toEqual(['H1']);
    expect(freeWells(plan, 2)).toEqual(['H1', 'H2']);
    expect(freeWells(editPlate(plan, { moved: { D1: 'H1' }, added: [] }), 1)).toEqual(['H2']);
    expect(editPlate(plan, NO_EDITS)).toBe(plan);
  });
});

describe.skipIf(!bca)('bench edits on the BCA run', () => {
  beforeEach(() => useRun.setState({ protocolId: 'pierce-bca', procedure: 'microplate', samples: 12, replicates: 2, standardReplicates: 2, standards: 'kit', done: {}, edits: NO_EDITS }));

  it('makes a vial again with the vials made from it (the kit’s table: D from B, E from C, F from E …)', () => {
    const vials = standardsFor(bca!, 'microplate', 'kit', 2).vials;
    expect(redoVials(vials, 'B')).toEqual(['B', 'D']);
    expect(redoVials(vials, 'C')).toEqual(['C', 'E', 'F', 'G', 'H']);
    useRun.setState({ done: Object.fromEntries(vials.map(v => [v.id, true])) });
    expect(redo(bca!, ['B'])).toBe('Make B again, and D: made from it.');
    expect(useRun.getState().done).toMatchObject({ A: true, B: false, C: true, D: false, E: true });
  });

  it('loads a tube again', () => {
    const plate = runSetup(bca!, useRun.getState()).plate;
    const three = plate.tubes.find(t => t.ref === '3')!;
    useRun.setState({ done: { [tubeKey(three.index)]: true } });
    expect(redo(bca!, ['3'])).toBe(`Load again: Sample 3 into ${three.wells.join(' and ')}, 25 µL in each.`);
    expect(useRun.getState().done[tubeKey(three.index)]).toBe(false);
  });

  it('moves a well gone wrong into the well named or the next free one, never onto a full one', () => {
    expect(moveWells(bca!, ['B3'], 'H12')).toBe('Put Sample 1 from B3 into H12 instead, 25 µL. B3 stays empty and won’t be read.');
    expect(useRun.getState().edits.moved).toEqual({ B3: 'H12' });
    expect(moveWells(bca!, ['B4'], 'A1')).toMatch(/^A1 is not free: Standard A is in it/);
    const next = moveWells(bca!, ['B4'], null);
    expect(next).toMatch(/^Put Sample 1 from B4 into [A-H]\d+ instead/);
    expect(moveWells(bca!, ['H11'], null)).toBe('H11 has nothing in it on this plate.');
  });

  it('adds a well, or a condition with the run’s replicates, where there is room', () => {
    expect(addWells(bca!, 'positive control')).toMatch(/^positive control is Sample 13: [A-H]\d+, 25 µL\.$/);
    expect(addWells(bca!, 'sample 3', { well: 'H12' })).toBe('Sample 3 also goes into H12, 25 µL.');
    expect(addWells(bca!, 'heat shock', { condition: true })).toMatch(/^heat shock is Sample 14: [A-H]\d+ and [A-H]\d+, 25 µL in each\.$/);
    const { plate } = runSetup(bca!, useRun.getState());
    expect(plate.tubes.at(-1)).toMatchObject({ ref: '14', label: 'heat shock' });
  });
});

describe('authorize: the bench’s changes', () => {
  const rules: Rules = { steps: ['m-load'], timed: [], vials: ['A', 'B', 'C', 'D'], samples: 12 };
  it('knows a vial, sample or well named alone, in a run of letters or in a range', () => {
    expect(names('B 重做', 'B')).toBe(true);
    expect(names('ABCD ok', 'C')).toBe(true);
    expect(names('A 到 D 好了', 'C')).toBe(true);
    expect(names('B3 壞了', 'B3')).toBe(true);
    expect(names('B3 壞了', 'B')).toBe(false);
    expect(names('12 samples', '1')).toBe(false);
  });

  it('redoes and moves only what the user named, and asks first otherwise', () => {
    expect(authorize({ type: 'redo', id: 'b' }, 'B 要重做', rules)).toEqual({ verdict: 'apply', action: { type: 'redo', id: 'B' } });
    expect(authorize({ type: 'redo', id: 'D' }, 'B 要重做', rules).verdict).toBe('confirm');
    expect(authorize({ type: 'redo', id: 'Z' }, 'Z 重做', rules).verdict).toBe('drop');
    expect(authorize({ type: 'moveWell', from: 'B3', to: 'H1' }, 'B3 has a bubble, put it in H1', rules)).toEqual({ verdict: 'apply', action: { type: 'moveWell', from: 'B3', to: 'H1' } });
    // A well the user did not name: the app picks one.
    expect(authorize({ type: 'moveWell', from: 'B3', to: 'H1' }, 'B3 壞了', rules).action).toEqual({ type: 'moveWell', from: 'B3' });
    expect(authorize({ type: 'moveWell', from: 'B3' }, 'is B3 ok?', rules).verdict).toBe('confirm');
    expect(authorize({ type: 'addCondition', name: 'heat shock' }, '多一個條件 heat shock', rules).verdict).toBe('apply');
    expect(authorize({ type: 'addWell', what: 'positive control', well: 'H12' }, 'add a well for a positive control', rules).action).toEqual({ type: 'addWell', what: 'positive control' });
    expect(authorize({ type: 'markDone', id: '3' }, '3 和 5 好了', rules).verdict).toBe('apply');
  });

  it.skipIf(!bca)('splits several ids into one change each', () => {
    const checked = checkReply(JSON.stringify({ say: 'Got it.', expression: 'happy', actions: [{ type: 'markDone', to: '', value: 0, id: 'A,B, C', query: '' }], a2ui: '[]', manualPages: [] }), { screen: 'run', protocolId: 'pierce-bca', step: 0, samples: 12, replicates: 2 }, 'A B C 好了');
    if (!checked.ok) throw new Error(checked.issue);
    expect(checked.reply.actions).toEqual([{ type: 'markDone', id: 'A' }, { type: 'markDone', id: 'B' }, { type: 'markDone', id: 'C' }]);
  });
});
