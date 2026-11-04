import type { Action } from '../../../shared/ai.ts';
import type { Protocol } from '../../../shared/protocol.ts';
import { benchSteps, lengthText } from '../../components/lab/model.ts';
import { useProtocol } from '../../state/protocol.ts';
import { useRun } from '../../state/run.ts';
import { useConverse } from '../home/useConverse.ts';
import { procedureFor } from '../protocol/content.ts';
export { useChatLog } from '../../state/conversationLog.ts';
export type { Exchange, Find, Go } from '../../state/conversationLog.ts';

/** What the screens are called on the buttons that go to them. */
export const GO_LABELS: Record<string, string> = {
  '/': 'Home',
  '/protocol': 'Open the protocol',
  '/kit': 'Your kit',
  '/plan': 'Open the plan',
  '/results': 'See the results',
  '/share': 'Share',
  '/import': 'Scan a QR code',
  '/library': 'Library',
};

/**
 * The line that says what an action changed, read from the run after it was applied, so it shows what the screens
 * now show: "Samples: 12", "Step 3 of 6 · Load the plate", "Timer started · 30 min". Null for what is not a change
 * to the run (going somewhere, looking up a kit).
 */
export function doneLine(action: Action, protocol: Protocol | null): string | null {
  const run = useRun.getState();
  switch (action.type) {
    case 'setSamples': return `Samples: ${action.samples}`;
    case 'setStandards': return `Standards: ${{ kit: 'the kit’s own', halve: 'halved from the top', five: 'five', ready: 'already made' }[action.standards]}`;
    case 'setReplicates': return `Samples: ×${action.replicates}; ${action.standardReplicates === undefined ? 'standards unchanged' : `standards ×${action.standardReplicates}`}`;
    case 'nextStep':
    case 'previousStep': {
      let steps: { title: string }[] = [];
      try {
        steps = protocol && protocol.id === run.protocolId ? benchSteps(protocol, run.procedure) : [];
      } catch {
        // A procedure the protocol does not have: just the number.
      }
      const at = Math.min(run.step, Math.max(0, steps.length - 1));
      return steps.length ? `Step ${at + 1} of ${steps.length} · ${steps[at]!.title}` : action.type === 'nextStep' ? 'Next step' : 'Back one step';
    }
    case 'markDone': return `${action.id} is done`;
    case 'startTimer': return `Timer started · ${lengthText(action.seconds)}`;
    case 'setStepTime': {
      let n = -1;
      try {
        n = protocol ? procedureFor(protocol, run.procedure).steps.filter(s => s.stage !== 'analyze').findIndex(s => s.id === action.id) : -1;
      } catch {
        // A procedure the protocol does not have: no number.
      }
      return `${n >= 0 ? `Step ${n + 1}` : 'That step'} · ${lengthText(action.seconds)} for this run`;
    }
    case 'stopTimer': return 'Timer stopped';
    case 'resumeTimer': return 'Timer resumed';
    // The bench's changes say what to do in their own line (applyActions); the run screen's own have nothing to show here.
    case 'redo':
    case 'moveWell':
    case 'addWell':
    case 'addCondition':
    case 'navigate':
    case 'findProtocol':
    case 'takePhoto':
    case 'useSample':
    case 'answer':
    case 'undo':
    case 'openProtocol':
    case 'startRun':
      return null;
  }
}

/** Chat shares its history, streaming and execution receipts with every other screen. */
export function useChat() {
  const { protocol } = useProtocol(useRun(s => s.protocolId));
  const { send } = useConverse('chat');
  return { send, protocol };
}
