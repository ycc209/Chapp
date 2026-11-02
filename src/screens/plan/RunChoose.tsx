import { useRef } from 'react';
import { Link } from 'react-router';
import { amountText, NumberedList } from '../../components/lab/index.ts';
import { cn } from '../../lib/cn.ts';
import { useProtocol } from '../../state/protocol.ts';
import { useRun } from '../../state/run.ts';
import { isPlannable } from '../../../shared/calc.ts';
import { procedureFor, shortName } from '../protocol/content.ts';
import { Exchange, PILL, Shell, StartPill, WHITE_PILL, turnAnswer, useFace, useFollow } from './Shell.tsx';
import { planFor, plural, repWord, type PlanView } from './plan.ts';
import { usePlanTalk } from './usePlanTalk.ts';

/**
 * Run-Choose: swiped in from the protocol's right edge, the plan as it stands and the two ways on: Start now, or Plan
 * it first. Saying a change ("12 samples in triplicate") updates the plan in place.
 */
export function RunChoose() {
  const protocolId = useRun(s => s.protocolId) ?? 'pierce-bca';
  const procedure = useRun(s => s.procedure);
  const samples = useRun(s => s.samples);
  const replicates = useRun(s => s.replicates);
  const standardReplicates = useRun(s => s.standardReplicates);
  const standards = useRun(s => s.standards);
  const { protocol, error } = useProtocol(protocolId);
  const { hear, heard, turn } = usePlanTalk(protocol, procedure);
  const scroller = useRef<HTMLDivElement>(null);
  useFollow(scroller, heard?.id ?? (turn ? `${turn.id}:${turn.phase}` : null));
  useFace('excited');

  // A cell protocol has no standards or plate, and amounts Chapp cannot convert cannot be planned: no plan to show.
  const v = protocol && isPlannable(protocol, procedureFor(protocol, procedure)) ? planFor(protocol, procedure, { samples, replicates, standardReplicates, standards }) : null;
  return (
    <Shell
      className="animate-in duration-300 ease-out slide-in-from-right"
      subtitle={protocol ? `${shortName(protocol)} · Start or plan` : 'Start or plan'}
      scroller={scroller}
      onUtterance={hear}
      next={
        <>
          <Link to="/plan" className={cn(PILL, WHITE_PILL, 'px-[18px]')}>
            Plan
          </Link>
          <StartPill protocol={protocol} />
        </>
      }
    >
      <p aria-label="Chapp's answer" className="m-0 mb-6 shrink-0 px-1 text-[17px] leading-6 font-medium text-ink">
        Start with this plan, or change it first?
      </p>
      {error && (
        <p role="alert" className="m-0 mb-6 shrink-0 px-1 text-[17px] leading-6 font-medium text-ink">
          {error}
        </p>
      )}
      {v && <NumberedList title="This plan" aria-label="This plan" items={thisPlan(v)} className="shrink-0" />}
      {(heard || turn) && (
        <div className="mt-8 flex shrink-0 flex-col gap-5">
          {heard ? (
            <Exchange text={heard.text} answer={heard.say} />
          ) : (
            turn && <Exchange text={turn.text} answer={turnAnswer(turn)} thinking={turn.phase === 'thinking'} sources={turn.phase === 'reply' ? turn.sources : undefined} />
          )}
        </div>
      )}
    </Shell>
  );
}

/** "12 samples, in duplicate" · "Kit's 9 standards, in duplicate" · "42 wells · 10 mL working reagent". */
export function thisPlan(v: PlanView) {
  const { samples: n, replicates: nr, standardReplicates: sr, standards: way } = v.plan;
  return [
    <>
      <b className="font-bold">{plural(n, 'sample')}</b>, {repWord(nr)}
    </>,
    way === 'kit' || way === 'ready' ? (
      <>
        <b className="font-bold">Kit’s {v.kitCount}</b> standards, {way === 'ready' ? 'already made' : repWord(sr)}
      </>
    ) : (
      <>
        <b className="font-bold">{plural(v.vials, 'standard')}</b>, {repWord(sr)}
      </>
    ),
    <>
      <b className="font-bold">{plural(v.plate.wells, 'well')}</b> · <b className="font-bold">{amountText(v.reagent.make)}</b> {v.reagent.name.toLowerCase()}
    </>,
  ];
}
