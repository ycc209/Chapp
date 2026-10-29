import { useState } from 'react';
import type { Action } from '../../../shared/ai.ts';
import type { Protocol } from '../../../shared/protocol.ts';
import { cn } from '../../lib/cn.ts';
import { PILL, WHITE_PILL } from '../../screens/plan/Shell.tsx';
import { procedureFor } from '../../screens/protocol/content.ts';
import { CheckIcon } from '../../screens/protocol/icons.tsx';
import { useBench } from '../../screens/run/bench.ts';
import { applyActions, changeStepTime } from '../../state/actions.ts';
import { nextFreeWell } from '../../state/benchEdits.ts';
import { useProtocol } from '../../state/protocol.ts';
import { useRun } from '../../state/run.ts';
import { lengthText } from '../lab/model.ts';

const CARD = 'flex flex-col gap-2 rounded-[20px] bg-card p-4 shadow-[0_0_0_1px_rgba(17,17,19,0.05),0_4px_16px_rgba(17,17,19,0.06)] animate-in fade-in duration-300';
const LINE = 'grid grid-cols-[16px_minmax(0,1fr)] gap-2 px-1 text-[13px] leading-[18px] font-medium text-text animate-in fade-in duration-300';

type Outcome = { line: string; made: boolean };

/**
 * Changes Chapp proposed that wait for the user's tap (ConverseReply.confirm): a step's new length as a card with the
 * old and new lengths (only this run, the manual unchanged), and anything else the user's words did not plainly ask
 * for as a button. Tapped, each turns into the line saying what changed; declined, into what stays.
 */
export function Confirm({ actions: asked, className }: { actions: readonly Action[]; className?: string }) {
  const { protocol } = useProtocol(useRun(s => s.protocolId));
  const [outcomes, setOutcomes] = useState<Record<number, Outcome>>({});
  // "B3 went wrong, which well now?": the button names the well it would use, and uses that one.
  const actions = asked.map(a => (a.type === 'moveWell' && !a.to && protocol ? { ...a, ...(nextFreeWell(protocol) ? { to: nextFreeWell(protocol)! } : {}) } : a));
  if (!actions.length) return null;
  const settle = (i: number, outcome: Outcome) => setOutcomes(o => ({ ...o, [i]: outcome }));
  const buttons = actions.map((a, i) => ({ a, i })).filter(({ a, i }) => a.type !== 'setStepTime' && !outcomes[i]);
  return (
    <div className={cn('mt-4 flex flex-col gap-3', className)}>
      {actions.map((a, i) =>
        outcomes[i] ? (
          <Done key={i} {...outcomes[i]!} />
        ) : a.type === 'setStepTime' ? (
          <StepTime key={i} action={a} protocol={protocol} onSettle={o => settle(i, o)} />
        ) : null,
      )}
      {buttons.length > 0 && (
        <div className="flex flex-wrap gap-2 px-1">
          {buttons.map(({ a, i }) => (
            <button
              key={i}
              type="button"
              onClick={() => {
                const [said] = applyActions([a], () => {}, protocol);
                settle(i, { line: said ?? madeLine(a, protocol), made: true });
              }}
              className={cn(PILL, WHITE_PILL, 'px-[18px]')}
            >
              {offerLabel(a, protocol)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Done({ line, made }: Outcome) {
  return (
    <p className={cn(LINE, 'm-0')}>
      <span className={cn('mt-px flex size-4 items-center justify-center rounded-full text-white', made ? 'bg-blue' : 'bg-muted')}>
        <CheckIcon size={10} width={3.4} />
      </span>
      {line}
    </p>
  );
}

/** The step's place and title in the run's procedure: "Step 4", "Incubate". */
function stepOf(protocol: Protocol | null, id: string) {
  try {
    // Numbered as Run numbers them: without the analysis that follows the run.
    const steps = protocol ? procedureFor(protocol, useRun.getState().procedure).steps.filter(s => s.stage !== 'analyze') : [];
    const n = steps.findIndex(s => s.id === id);
    const step = steps[n];
    if (!step) return null;
    const t = step.timer?.duration;
    return { n: n + 1, title: step.title, seconds: t ? t.value * { s: 1, min: 60, h: 3600 }[t.unit] : null };
  } catch {
    return null;
  }
}

const REPLICATES = ['', 'Once each', 'In duplicate', 'In triplicate', 'Four of each'];

/** What a button offers to do, in the user's terms. */
function offerLabel(a: Action, protocol: Protocol | null): string {
  switch (a.type) {
    case 'nextStep': return 'Go to the next step';
    case 'previousStep': return 'Go back one step';
    case 'setSamples': return `Plan for ${a.samples} samples`;
    case 'setReplicates': return `${REPLICATES[a.replicates] ?? `${a.replicates} replicates`}, standards too`;
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
  }
}

/** The line once it is done. */
function madeLine(a: Action, protocol: Protocol | null): string {
  switch (a.type) {
    case 'nextStep': return 'Next step';
    case 'previousStep': return 'Back one step';
    case 'setSamples': return `Samples: ${a.samples}`;
    case 'setReplicates': return `Replicates: ×${a.replicates}, standards too`;
    case 'markDone': return `${offerLabel(a, protocol)}`;
    case 'startTimer': return `Timer started · ${lengthText(a.seconds)}`;
    case 'setStepTime': {
      const step = stepOf(protocol, a.id);
      return `${step ? `Step ${step.n}` : 'That step'} · ${lengthText(a.seconds)} for this run`;
    }
    case 'redo': return `${a.id} again`;
    case 'moveWell': return `${a.from} moved`;
    case 'addWell': return `Well added: ${a.what}`;
    case 'addCondition': return `Added: ${a.name}`;
    case 'navigate':
    case 'findProtocol':
      return 'Done';
  }
}

/**
 * Chapp's proposal for a step's length: what it is now and what it would be, for this run only. A timer already
 * counting asks one more thing: whether the time gone still counts, or the step starts over.
 */
function StepTime({ action, protocol, onSettle }: { action: Extract<Action, { type: 'setStepTime' }>; protocol: Protocol | null; onSettle: (o: Outcome) => void }) {
  const step = stepOf(protocol, action.id);
  const chosen = useBench(s => s.lengths[action.id]);
  const ends = useRun(s => s.timers[action.id]);
  const paused = useBench(s => s.paused[action.id]);
  const now = chosen ?? step?.seconds ?? null;
  if (!step || now === null) return null;
  const counting = (ends !== undefined && ends > Date.now()) || paused !== undefined;
  const left = paused ?? (ends !== undefined ? Math.max(0, Math.ceil((ends - Date.now()) / 1000)) : now);
  const gone = Math.max(0, now - left);
  const change = (restart: boolean) => {
    changeStepTime(action.id, action.seconds, { from: now, restart });
    onSettle({ line: madeLine(action, protocol) + (counting ? (restart ? ', started over' : ', time gone kept') : ''), made: true });
  };
  return (
    <section aria-label="Change a step's time" className={CARD}>
      <h3 className="m-0 text-[13px] leading-[18px] font-semibold text-text">Change for this run</h3>
      <span className="text-[17px] leading-[22px] font-semibold text-ink">
        Step {step.n} · {step.title}
      </span>
      <div className="flex items-baseline gap-3 tabular-nums">
        <span className="text-[20px] leading-6 font-semibold text-muted line-through decoration-2">{lengthText(now)}</span>
        <span aria-hidden="true" className="text-[17px] text-text">→</span>
        <span className="text-[28px] leading-8 font-bold text-ink">{lengthText(action.seconds)}</span>
      </div>
      <p className="m-0 text-[14px] leading-[19px] text-text">
        The manual stays as it is.{counting ? (gone >= 60 ? ` The timer is counting: ${lengthText(gone)} gone so far.` : ' The timer has just started.') : ''}
      </p>
      <div className="mt-1 flex flex-wrap gap-2">
        {counting ? (
          <>
            <button type="button" onClick={() => change(false)} className={cn(PILL, 'bg-ink px-[18px] text-white')}>
              Change, keep the time gone
            </button>
            <button type="button" onClick={() => change(true)} className={cn(PILL, WHITE_PILL, 'px-[18px]')}>
              Change and start over
            </button>
          </>
        ) : (
          <button type="button" onClick={() => change(false)} className={cn(PILL, 'bg-ink px-[18px] text-white')}>
            Make it {lengthText(action.seconds)}
          </button>
        )}
        <button type="button" onClick={() => onSettle({ line: `Kept ${lengthText(now)}`, made: false })} className={cn(PILL, WHITE_PILL, 'px-[18px]')}>
          Keep {lengthText(now)}
        </button>
      </div>
    </section>
  );
}
