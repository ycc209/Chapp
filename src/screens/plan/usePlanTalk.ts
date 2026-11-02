import { useCallback, useState } from 'react';
import type { Protocol } from '../../../shared/protocol.ts';
import { useRun } from '../../state/run.ts';
import { useConverse } from '../home/useConverse.ts';
import type { PlanNumbers } from './plan.ts';

export type Heard = { id: number; text: string; say: string; standards: boolean };

export const isPicked = (picked: boolean, standards: PlanNumbers['standards']) => picked || standards !== 'kit';

export const runPlan = (): PlanNumbers => {
  const { samples, replicates, standardReplicates, standards } = useRun.getState();
  return { samples, replicates, standardReplicates, standards };
};

/** Spoken plans go through Chapp; the form remains available for direct edits. */
export function usePlanTalk(_protocol: Protocol | null, _procedure: string, initial: Heard | null = null) {
  const { turn, send } = useConverse('plan');
  const [heard, setHeard] = useState<Heard | null>(initial);
  const hear = useCallback((text: string) => { setHeard(null); return send(text); }, [send]);
  return { hear, heard, turn };
}
