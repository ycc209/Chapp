import type { Action } from '../../shared/ai.ts';
import type { Protocol } from '../../shared/protocol.ts';
import { runSetup } from '../components/lab/model.ts';
import { useBench } from '../screens/run/bench.ts';
import { tubeKey } from '../screens/run/model.ts';
import { addWells, moveWells, redo } from './benchEdits.ts';
import { useRun } from './run.ts';
import { useSession } from './session.ts';

/**
 * Applies the changes Chapp asked for (a reply's actions, or a voice command matched on the phone). Changes to the
 * plate need the run's protocol (where a well goes); each returns the line that says what to do now, which the screen
 * shows ("Put Sample 1 from B3 into H1 instead, 25 µL.").
 */
export function applyActions(actions: Action[], navigate: (to: string) => void, protocol?: Protocol | null): string[] {
  const run = useRun.getState();
  const lines: string[] = [];
  for (const action of actions) {
    switch (action.type) {
      case 'navigate': navigate(action.to); break;
      case 'setSamples': run.setPlan({ samples: action.samples }); break;
      // "Make it triplicates": the storyboard's 63 wells are all 21 tubes three times, standards included.
      case 'setReplicates': run.setPlan({ replicates: action.replicates, standardReplicates: action.replicates }); break;
      case 'nextStep': run.next(); break;
      case 'previousStep': run.previous(); break;
      // A vial or a step by its id; a sample's tube ("3") loaded, on the plate as the run lays it out.
      case 'markDone': {
        if (/^\d{1,2}$/.test(action.id) && protocol) {
          const r = useRun.getState();
          const tube = runSetup(protocol, { ...r, edits: r.edits }).plate.tubes.find(t => t.ref === action.id);
          if (tube) run.setDone(tubeKey(tube.index));
        } else run.setDone(action.id);
        break;
      }
      case 'redo': if (protocol) lines.push(redo(protocol, [action.id])); break;
      case 'moveWell': if (protocol) lines.push(moveWells(protocol, [action.from], action.to ?? null)); break;
      case 'addWell': if (protocol) lines.push(addWells(protocol, action.what, { well: action.well })); break;
      case 'addCondition': if (protocol) lines.push(addWells(protocol, action.name, { condition: true })); break;
      case 'startTimer': run.startTimer(action.id, action.seconds); break;
      case 'setStepTime': changeStepTime(action.id, action.seconds); break;
      // The Overview searches for the kit Chapp named, under what the user said.
      case 'findProtocol': {
        const session = useSession.getState();
        session.setExchange({ ask: session.exchange?.ask ?? action.query, say: session.exchange?.say ?? '', query: action.query });
        navigate('/protocol');
        break;
      }
    }
  }
  return lines;
}

/**
 * This run's length for a timed step (the user confirmed Chapp's proposal): what Run's timer counts from now on. A
 * timer already running or stopped part-way is moved with it: with `from` (the length it was started with), the time
 * already gone still counts unless `restart`; started over, it counts the whole new length from now.
 */
export function changeStepTime(id: string, seconds: number, { from, restart = false }: { from?: number; restart?: boolean } = {}) {
  const bench = useBench.getState();
  const run = useRun.getState();
  bench.setLength(id, seconds);
  const ends = run.timers[id];
  const paused = bench.paused[id];
  if (ends === undefined && paused === undefined) return;
  const now = Date.now();
  const left = paused ?? Math.max(0, Math.ceil((ends! - now) / 1000));
  const gone = from !== undefined ? Math.max(0, from - left) : 0;
  const after = restart ? seconds : Math.max(1, seconds - gone);
  if (paused !== undefined) bench.pause(id, after);
  else if (ends! > now) run.startTimer(id, after);
}
