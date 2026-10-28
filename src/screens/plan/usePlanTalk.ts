import { useCallback, useEffect, useRef, useState } from 'react';
import type { Protocol } from '../../../shared/protocol.ts';
import { useRun } from '../../state/run.ts';
import { useSession } from '../../state/session.ts';
import { speak } from '../../voice/speak.ts';
import { useConverse } from '../home/useConverse.ts';
import { parsePlan } from './parse.ts';
import { fitPlan, halvingTop, planFor, planLine, tidySaid, wayCounts, type PlanNumbers } from './plan.ts';
import { usePlanView } from './view.ts';

/** A plan heard and applied on the phone: what was said ("You said …") and Chapp's sentence back. */
export type Heard = { id: number; text: string; say: string; standards: boolean };

// After Chapp has read its sentence, how long it keeps smiling (as useConverse).
const SETTLE_MS = 2500;

/** Whether the user has chosen how to make the standards: picked here, or any way but the run's default. */
export const isPicked = (picked: boolean, standards: PlanNumbers['standards']) => picked || standards !== 'kit';

export const runPlan = (): PlanNumbers => {
  const { samples, replicates, standardReplicates, standards } = useRun.getState();
  return { samples, replicates, standardReplicates, standards };
};

/**
 * Talking on Run-Choose and Plan. A plan said in one breath ("five standards once, samples in triplicate") is read
 * on the phone (parse.ts), applied to the run, and answered with the plan's own sentence (Plan-Heard); anything else
 * goes to Chapp (useConverse('plan'): its phone commands first, then the server).
 */
export function usePlanTalk(protocol: Protocol | null, procedure: string, initial: Heard | null = null) {
  const { turn, send, reset } = useConverse('plan');
  const [heard, setHeard] = useState<Heard | null>(initial);
  const seq = useRef(initial?.id ?? 0);

  useEffect(
    () => () => {
      seq.current++;
    },
    [],
  );

  const hear = useCallback(
    (said: string) => {
      const text = said.trim();
      if (!text) return;
      const change = protocol ? parsePlan(text, { counts: wayCounts(protocol, procedure), top: halvingTop(protocol, procedure) }) : null;
      if (!protocol || !change) {
        setHeard(null);
        send(text);
        return;
      }
      reset();
      const before = runPlan();
      const next = fitPlan(protocol, procedure, { ...before, ...change });
      useRun.getState().setPlan(next);
      const view = usePlanView.getState();
      if (change.standards) view.setPicked(true);

      const was = planFor(protocol, procedure, before);
      const now = planFor(protocol, procedure, next);
      let say = planLine(now, { picked: isPicked(view.picked, next.standards), heard: true, still: was.reagent.make === now.reagent.make });
      // Asked for more than one plate holds: say so, with what was planned instead.
      if (next.samples < (change.samples ?? before.samples)) say = `Up to ${now.max} samples fit beside ${now.beside}. ${say}`;

      const id = ++seq.current;
      setHeard({ id, text: tidySaid(text), say, standards: change.standards !== undefined });
      const session = useSession.getState();
      session.setHeard('');
      session.setStatus('');
      session.setExpression('happy');
      void speak(say)
        .catch(() => {})
        .then(() =>
          setTimeout(() => {
            const s = useSession.getState();
            if (seq.current === id && s.expression === 'happy') s.setExpression('neutral');
          }, SETTLE_MS),
        );
    },
    [protocol, procedure, send, reset],
  );

  return { hear, heard, turn };
}
