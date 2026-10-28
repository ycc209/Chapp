import type { Action } from '../../shared/ai.ts';
import { useRun } from './run.ts';
import { useSession } from './session.ts';

/** Applies the changes Chapp asked for (a reply's actions, or a voice command matched on the phone). */
export function applyActions(actions: Action[], navigate: (to: string) => void) {
  const run = useRun.getState();
  for (const action of actions) {
    switch (action.type) {
      case 'navigate': navigate(action.to); break;
      case 'setSamples': run.setPlan({ samples: action.samples }); break;
      // "Make it triplicates": the storyboard's 63 wells are all 21 tubes three times, standards included.
      case 'setReplicates': run.setPlan({ replicates: action.replicates, standardReplicates: action.replicates }); break;
      case 'nextStep': run.next(); break;
      case 'previousStep': run.previous(); break;
      case 'markDone': run.setDone(action.id); break;
      case 'startTimer': run.startTimer(action.id, action.seconds); break;
      // The Overview searches for the kit Chapp named, under what the user said.
      case 'findProtocol': {
        const session = useSession.getState();
        session.setExchange({ ask: session.exchange?.ask ?? action.query, say: session.exchange?.say ?? '', query: action.query });
        navigate('/protocol');
        break;
      }
    }
  }
}
