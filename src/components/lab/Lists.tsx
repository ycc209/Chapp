import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { cn } from '../../lib/cn.ts';
import { Check } from './Text.tsx';

const BADGE = 'flex size-[22px] items-center justify-center rounded-full text-[12px] leading-[22px] font-bold';

/**
 * Numbered lines on yellow dots: "At a glance" (Protocol-Full), "This plan" (Run-Choose), what to do on Run-Mix,
 * Run-Add and Run-Read. Items are rich text: bold the amounts (<b className="font-bold">9.8 mL</b> Reagent A).
 */
export function NumberedList({ items, title, className, 'aria-label': label }: { items: ReactNode[]; title?: ReactNode; className?: string; 'aria-label'?: string }) {
  return (
    <section aria-label={label} className={cn('flex flex-col gap-2.5 px-1', className)}>
      {title !== undefined && <h2 className="m-0 text-[13px] leading-[18px] font-semibold text-text">{title}</h2>}
      <ol className="m-0 flex list-none flex-col gap-2.5 p-0">
        {items.map((item, i) => (
          <li key={i} className="grid grid-cols-[22px_minmax(0,1fr)] items-center gap-3 text-[17px] leading-6 font-medium text-ink">
            <span className={cn(BADGE, 'bg-mark text-ink')}>{i + 1}</span>
            <span>{item}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

export type StepItem = {
  title: string;
  /** At the right: "9 vials", "10 mL", "9 of 21 tubes" (model.ts stepDetail). */
  detail?: string;
  state: 'done' | 'now' | 'next';
  /** Where the row goes (/run/1 …), or what it does. */
  to?: string;
  onSelect?: () => void;
};

/**
 * All the steps of the run (Run-List): ticked steps on yellow checks, the step now on a yellow number in semibold,
 * the rest on outlined numbers. Each row opens its step.
 */
export function StepList({ steps, className, 'aria-label': label = 'All steps' }: { steps: StepItem[]; className?: string; 'aria-label'?: string }) {
  return (
    <section aria-label={label} className={cn('flex flex-col gap-2.5 px-1', className)}>
      <ol className="m-0 flex list-none flex-col gap-2.5 p-0 tabular-nums">
        {steps.map((s, i) => {
          const row = 'grid min-h-[34px] w-full grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-3 border-0 bg-transparent p-0 text-left font-[inherit] text-[17px] leading-6 font-medium text-ink no-underline outline-none focus-visible:outline-2 focus-visible:outline-blue';
          const body = (
            <>
              {s.state === 'done' ? (
                <span className={cn(BADGE, 'bg-mark text-ink')}>
                  <Check size={11} width={3.2} />
                </span>
              ) : (
                <span className={cn(BADGE, s.state === 'now' ? 'bg-mark text-ink' : 'bg-white text-text shadow-[inset_0_0_0_1.5px_#d9d9d5]')}>{i + 1}</span>
              )}
              <span className={s.state === 'now' ? 'font-semibold' : undefined}>{s.title}</span>
              <span className="text-[15px] leading-5 text-text">{s.detail}</span>
            </>
          );
          const current = s.state === 'now' ? ('step' as const) : undefined;
          return (
            <li key={i}>
              {s.to ? (
                <Link to={s.to} aria-current={current} className={row} onClick={s.onSelect}>{body}</Link>
              ) : s.onSelect ? (
                <button type="button" aria-current={current} className={row} onClick={s.onSelect}>{body}</button>
              ) : (
                <div aria-current={current} className={row}>{body}</div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
