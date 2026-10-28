import type { ReactNode } from 'react';
import { cn } from '../../lib/cn.ts';
import { NumberedList } from './Lists.tsx';
import { amountText, type ReagentPlan } from './model.ts';
import { BenchLine, Mark } from './Text.tsx';

export type ReagentPartsProps = {
  /** From model.ts reagentPlan(): the amount to make and each part's volume, split by the mix's ratio (A:B = 50:1). */
  plan: ReagentPlan;
  /**
   * `plan`: the two rows in Plan's Working reagent panel (Reagent A ……… 9.8 mL).
   * `run`: numbered, the amounts in bold, then `then` (Run-Mix: "Swirl until it is clear green").
   * `gloves`: two big lines (Gloves-Mix).
   */
  size?: 'plan' | 'run' | 'gloves';
  /** More numbered lines after the parts (run). */
  then?: ReactNode[];
  /** The line under it: "Add B last. Cloudy, then green." (run, gloves). */
  note?: ReactNode;
  /** Highlight the amounts: they just changed with the plan (Plan-Heard). */
  marked?: boolean;
  className?: string;
};

/**
 * What goes into the working reagent, in the mix's order: Reagent A then Reagent B, the volumes worked out for this
 * run's wells. The parts come from the protocol's mix (Reagent A : B = 50 : 1); nothing here is BCA-specific.
 */
export function ReagentParts({ plan, size = 'plan', then = [], note, marked = false, className }: ReagentPartsProps) {
  if (size === 'plan') {
    return (
      <ul aria-label={plan.name} className={cn('m-0 flex list-none flex-col gap-2 p-0 text-[16px] leading-[22px] font-semibold text-ink tabular-nums', className)}>
        {plan.parts.map(x => (
          <li key={x.component} className="flex justify-between gap-3">
            {x.name}
            <span className="font-[650]">
              <Mark on={marked} className="-mx-1 px-1">{amountText(x.volume)}</Mark>
            </span>
          </li>
        ))}
      </ul>
    );
  }
  if (size === 'run') {
    return (
      <div className={cn('flex flex-col gap-2.5', className)}>
        <NumberedList
          aria-label="How to mix it"
          items={[
            ...plan.parts.map(x => (
              <>
                <b className="font-bold">{amountText(x.volume)}</b> {x.name}
              </>
            )),
            ...then,
          ]}
        />
        {note !== undefined && <p className="m-0 px-1 text-[15px] leading-[22px] text-text">{note}</p>}
      </div>
    );
  }
  return (
    <div className={cn('flex flex-col px-1', className)}>
      {plan.parts.map(x => (
        <BenchLine key={x.component} className="font-medium">
          <b className="font-[750]">{amountText(x.volume)}</b> {x.name}
        </BenchLine>
      ))}
      {note !== undefined && <p className="m-0 mt-3 text-[17px] leading-6 font-medium text-ink">{note}</p>}
    </div>
  );
}
