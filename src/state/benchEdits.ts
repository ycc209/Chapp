import type { Protocol } from '../../shared/protocol.ts';
import { toMicroliters } from '../../shared/calc.ts';
import { freeWells, microliters, runSetup, type PlatePlan } from '../components/lab/model.ts';
import { listText, redoVials, tubeKey } from '../screens/run/model.ts';
import { useRun } from './run.ts';

/**
 * Changes said at the bench that need the plate: a vial or tube to do again, a well gone wrong, a well or a condition
 * added. Each works on the run's own layout (runSetup with the edits so far), makes the change in useRun(), and
 * returns the line that says what to do now ("Put Sample 1 from B3 into H1 instead, 25 µL."), or why it could not.
 * Run's own words and Chapp's actions (src/state/actions.ts) both come here, so they do the same thing.
 */

function setup(p: Protocol) {
  const r = useRun.getState();
  return runSetup(p, { procedure: r.procedure, samples: r.samples, replicates: r.replicates, standardReplicates: r.standardReplicates, standards: r.standards, edits: r.edits });
}

const tubeOf = (plate: PlatePlan, ref: string) => plate.tubes.find(t => t.ref.toUpperCase() === ref.trim().toUpperCase());

/** ", 25 µL": what each well of a standard or sample takes, as the protocol loads them ("" when it gives none). */
function perWell(p: Protocol): string {
  const proc = p.procedures.find(x => x.id === useRun.getState().procedure);
  const add = proc?.steps.flatMap(s => s.add ?? []).find(a => a.what === 'standards-and-samples');
  const ul = add ? toMicroliters(add.volume) : null;
  return ul ? `, ${microliters(ul)} µL` : '';
}

/** Vials made again (with the vials made from them), or tubes loaded again. */
export function redo(p: Protocol, refs: string[]): string {
  const { series, plate } = setup(p);
  const run = useRun.getState();
  const vials = series.vials;
  if (refs.every(r => vials.some(v => v.id === r.toUpperCase())) && run.standards !== 'ready') {
    const said = refs.map(r => r.toUpperCase());
    const again = vials.map(v => v.id).filter(id => said.some(r => redoVials(vials, r).includes(id)));
    for (const id of again) run.setDone(id, false);
    const also = again.filter(id => !said.includes(id));
    return `Make ${listText(said)} again${also.length ? `, and ${listText(also)}: made from ${said.length === 1 ? 'it' : 'them'}` : ''}.`;
  }
  const tubes = refs.map(r => tubeOf(plate, r));
  if (tubes.some(t => !t)) return `I can’t find ${listText(refs.filter((_, i) => !tubes[i]))} on this run.`;
  for (const t of tubes) run.setDone(tubeKey(t!.index), false);
  return `Load again: ${tubes.map(t => `${t!.name} into ${listText(t!.wells)}`).join('; ')}${perWell(p)} in each.`;
}

/** The well a change would use if the user names none: the next free one on the run's plate (null when it is full). */
export const nextFreeWell = (p: Protocol): string | null => freeWells(setup(p).plate, 1)[0] ?? null;

/** Wells gone wrong: what each held goes into the well named, or the next free one; the wells stay empty. */
export function moveWells(p: Protocol, wells: string[], to: string | null): string {
  const { plate } = setup(p);
  const moves: string[] = [];
  const taken: string[] = [];
  const from = wells.map(w => w.toUpperCase());
  for (const well of from) {
    const cell = plate.cells.find(c => c.well === well);
    if (!cell) return `${well} has nothing in it on this plate.`;
    const named = from.length === 1 && to ? to.toUpperCase() : null;
    const holder = named ? plate.cells.find(c => c.well === named) : undefined;
    if (named && (holder || plate.bad.includes(named)))
      return `${named} is not free${holder ? `: ${plate.tubes[holder.tube]!.name} is in it` : ''}. Name another well, or just say ${well} is bad and I’ll pick one.`;
    const into = named ?? freeWells(plate, 1, taken)[0];
    if (!into) return 'There is no free well left on this plate.';
    taken.push(into);
    useRun.getState().moveWell(well, into);
    moves.push(`${plate.tubes[cell.tube]!.name} from ${well} into ${into}`);
  }
  return `Put ${listText(moves)} instead${perWell(p)}. ${listText(from)} ${from.length === 1 ? 'stays' : 'stay'} empty and won’t be read.`;
}

/**
 * One more well: of a tube already on the plate ("another well of sample 3", "B again") or something new with a name
 * ("a positive control"), in the well named or the next free one. A condition is a new sample with the run's
 * replicates, side by side.
 */
export function addWells(p: Protocol, what: string, { well, condition = false }: { well?: string; condition?: boolean } = {}): string {
  const { plate } = setup(p);
  const run = useRun.getState();
  const name = what.trim().replace(/[.。]$/, '') || 'Extra';
  // "sample 3", "3", "standard B", "B": more of a tube on the plate.
  const ref = /^(?:sample\s*|樣本\s*|standard\s*|標準品\s*)?([A-P]|\d{1,2})$/i.exec(name)?.[1];
  const of = !condition && ref ? tubeOf(plate, ref) : undefined;
  const count = condition ? run.replicates : 1;
  const named = well?.trim().toUpperCase();
  if (named && (plate.cells.some(c => c.well === named) || plate.bad.includes(named))) return `${named} is not free. Name another well, or let me pick one.`;
  const wells = named && count === 1 ? [named] : freeWells(plate, count);
  if (wells.length < count) return `There is no room on this plate for ${count === 1 ? 'another well' : `${count} more wells`}.`;
  run.addWells({ name, ...(of ? { of: of.ref } : {}), wells });
  if (of) return `${of.name} also goes into ${listText(wells)}${perWell(p)}.`;
  const number = plate.tubes.filter(t => t.kind === 'sample').length + 1;
  return `${name} is Sample ${number}: ${listText(wells)}${perWell(p)}${count > 1 ? ' in each' : ''}.`;
}
