import { useState } from 'react';
import type { Action } from '../../../shared/ai.ts';
import type { Protocol } from '../../../shared/protocol.ts';
import { cn } from '../../lib/cn.ts';
import { useConverse } from '../../screens/home/useConverse.ts';
import { PILL, WHITE_PILL } from '../../screens/plan/Shell.tsx';
import { procedureFor } from '../../screens/protocol/content.ts';
import { useProtocol } from '../../state/protocol.ts';
import { useRun } from '../../state/run.ts';
import { lengthText } from '../lab/model.ts';
import { ReplyText, ReplySources } from './ReplyText.tsx';

/** Accepting a suggestion is another conversation turn; only tool receipts report completion. */
export function Confirm({ actions, className, onAnswer }: { actions: readonly Action[]; className?: string; onAnswer?: (text: string) => void }) {
  const { protocol } = useProtocol(useRun(s => s.protocolId));
  const { send, turn } = useConverse('confirmation');
  const [sent, setSent] = useState<number[]>([]);
  if (!actions.length) return null;
  return <div className={cn('mt-4 flex flex-col gap-3', className)}>
    <div className="flex flex-wrap gap-2 px-1">
      {actions.map((action, index) => <button key={index} type="button" disabled={sent.includes(index)} className={cn(PILL, WHITE_PILL, 'px-[18px] disabled:opacity-50')} onClick={() => {
        const text = offerLabel(action, protocol);
        setSent(old => [...old, index]);
        if (onAnswer) onAnswer(text); else void send(text);
      }}>{offerLabel(action, protocol)}</button>)}
    </div>
    {!onAnswer && turn && <div className="px-1 text-[15px] leading-6">
      <ReplyText text={turn.phase === 'error' ? 'The change could not be confirmed.' : turn.say || '…'} />
      {turn.phase === 'reply' && <ReplySources sources={turn.sources} />}
    </div>}
  </div>;
}

function stepOf(protocol: Protocol | null, id: string) {
  const steps = protocol ? procedureFor(protocol, useRun.getState().procedure).steps.filter(s => s.stage !== 'analyze') : [];
  const n = steps.findIndex(s => s.id === id);
  return n < 0 ? null : { n: n + 1 };
}

const REPLICATES = ['', 'Once each', 'In duplicate', 'In triplicate', 'Four of each'];
/** How the standards are made, as the plan's choices say it. */
export const STANDARDS_WAY = { kit: 'The kit’s own standards', halve: 'Halve from the top', five: 'Five standards', ready: 'Standards already made' } as const;

/** What a button offers to do, in the user's terms. */
function offerLabel(a: Action, protocol: Protocol | null): string {
  switch (a.type) {
    case 'nextStep': return 'Go to the next step';
    case 'previousStep': return 'Go back one step';
    case 'setSamples': return `Plan for ${a.samples} samples`;
    case 'setStandards': return STANDARDS_WAY[a.standards];
    case 'setReplicates': return `Samples: ${REPLICATES[a.replicates] ?? `${a.replicates} replicates`}; ${a.standardReplicates === undefined ? 'keep standards unchanged' : `standards ×${a.standardReplicates}`}`;
    case 'markDone': {
      const step = stepOf(protocol, a.id);
      return step ? `Step ${step.n} is done` : `${a.id} is done`;
    }
    case 'startTimer': return `Start the ${lengthText(a.seconds)} timer`;
    case 'setStepTime': return `Make it ${lengthText(a.seconds)}`;
    case 'redo': return `Do ${a.id} again`;
    case 'moveWell': return a.to ? `Move ${a.from} to ${a.to}` : `${a.from} went wrong: move it`;
    case 'addWell': return `Add a well: ${a.what}`;
    case 'addCondition': return `Add ${a.name}`;
    case 'navigate': return 'Open it';
    case 'findProtocol': return 'Find its manual';
    case 'stopTimer': return 'Stop the timer';
    case 'resumeTimer': return 'Resume the timer';
    case 'takePhoto': return 'Take a photo of the reader';
    case 'useSample': return 'Use the sample data';
    case 'answer': return a.yes ? 'Yes' : 'No';
    case 'undo': return 'Undo the last change';
    case 'openProtocol': return `Use protocol ${a.protocolId}`;
    case 'startRun': return 'Start the experiment';
  }
}
