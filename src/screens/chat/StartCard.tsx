import { isPlannable } from '../../../shared/calc.ts';
import { NumberedList } from '../../components/lab/index.ts';
import { cn } from '../../lib/cn.ts';
import { useProtocol } from '../../state/protocol.ts';
import { useRun } from '../../state/run.ts';
import { beginRun } from '../../state/start.ts';
import { PlayIcon } from '../protocol/icons.tsx';
import { planFor } from '../plan/plan.ts';
import { thisPlan } from '../plan/RunChoose.tsx';
import { PILL, WHITE_PILL } from '../plan/Shell.tsx';
import { procedureFor, shortName } from '../protocol/content.ts';

const CARD = 'mt-4 flex flex-col gap-3 rounded-[20px] bg-card p-4 shadow-[0_0_0_1px_rgba(17,17,19,0.05),0_4px_16px_rgba(17,17,19,0.06)] animate-in fade-in duration-300';

/**
 * The start card: Chapp was asked to start while the plan was never set, so the plan as it stands comes first, under
 * the answer, with Start and a way to change it (one decision, two buttons: the Apps SDK's inline card). A change said
 * now ("12 samples") shows on it at once, since it reads the run. Once started it says so and leads back to the run.
 */
export function StartCard({ protocolId, onGo }: { protocolId: string; onGo: (to: string) => void }) {
  const run = useRun();
  const { protocol } = useProtocol(protocolId);
  const current = run.protocolId === protocolId && !run.aside;
  if (!protocol) return null;
  const proc = procedureFor(protocol, run.procedure);
  const v = current && isPlannable(protocol, proc) ? planFor(protocol, proc.id, { samples: run.samples, replicates: run.replicates, standardReplicates: run.standardReplicates, standards: run.standards }) : null;
  return (
    <section aria-label="Start the experiment" className={CARD}>
      <h3 className="m-0 text-[13px] leading-[18px] font-semibold text-text">{shortName(protocol)} · Start</h3>
      {!current ? (
        <p className="m-0 text-[15px] leading-5 text-text">Another experiment is open now.</p>
      ) : run.begun ? (
        <>
          <p className="m-0 text-[15px] leading-5 text-ink">Started.</p>
          <button type="button" onClick={() => onGo(`/run/${run.step + 1}`)} className={cn(PILL, WHITE_PILL, 'self-start px-[18px]')}>
            Back to the run
          </button>
        </>
      ) : (
        <>
          {v && <NumberedList title="This plan" aria-label="This plan" items={thisPlan(v)} className="mb-0" />}
          <div className="flex gap-2">
            <button type="button" onClick={() => onGo(beginRun(protocol))} className={cn(PILL, 'gap-[7px] bg-ink pr-[18px] pl-[15px] text-white')}>
              <PlayIcon />
              Start
            </button>
            <button type="button" onClick={() => onGo('/plan')} className={cn(PILL, WHITE_PILL, 'px-[18px]')}>
              Change the plan
            </button>
          </div>
        </>
      )}
    </section>
  );
}
