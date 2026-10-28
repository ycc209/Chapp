import { Link } from 'react-router';
import { cn } from '../../lib/cn.ts';
import { stepLabel } from './model.ts';
import { Check } from './Text.tsx';

export type StepPillProps = {
  /** The step on screen, from 0 (useRun().step). */
  index: number;
  total: number;
  /** "Standards", "Load the plate" (model.ts benchSteps()). */
  title: string;
  /** Opens the list of all steps (/run/list or wherever Run-List lives). Without it, the pill is plain (gloves on). */
  to?: string;
  className?: string;
};

/**
 * The pill under Chapp on the run screens: "Chapp / Step 1 of 6 · Standards ⌄", a link to all the steps
 * (Run-Standards … Run-Read; plain, without the chevron, with gloves on). It is ChappHeader's name pill with a step
 * line: under the avatar it takes the header's -mt-4.
 */
export function StepPill({ index, total, title, to, className }: StepPillProps) {
  const pill = cn(
    'relative flex flex-col items-center rounded-[14px] bg-white/78 px-3 pt-1 pb-[5px] no-underline shadow-[0_0_0_1px_rgba(17,17,19,0.05),0_1px_8px_rgba(17,17,19,0.05)] backdrop-blur-[14px]',
    to && 'pointer-events-auto outline-none focus-visible:ring-2 focus-visible:ring-blue',
    className,
  );
  const body = (
    <>
      <b className="text-[15px] leading-5 font-semibold text-ink">Chapp</b>
      <span className="flex items-center gap-1 text-[13px] leading-[18px] font-medium text-text">
        <span className={cn('truncate', to ? 'max-w-[206px]' : 'max-w-[220px]')}>{stepLabel(index, total, title)}</span>
        {to && (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m6 9 6 6 6-6" />
          </svg>
        )}
      </span>
    </>
  );
  return to ? (
    <Link to={to} aria-label="All steps" className={pill}>
      {body}
    </Link>
  ) : (
    <span role="status" className={pill}>
      {body}
    </span>
  );
}

export type AmountCardProps = {
  /** "Albumin Standard". */
  name: string;
  /** "Stock · 2 mg/mL", "Diluent · you named it". */
  detail: string;
  /** "400 µL". */
  amount: string;
  /** The user's photo of the bottle (a data or object URL); a dark "Your photo" square until there is one. */
  photo?: string;
  /** The blue check on the photo: this bottle was matched in the kit. */
  matched?: boolean;
  className?: string;
};

/** A bottle and how much of it this step uses (Standards-2: "Albumin Standard · Stock · 2 mg/mL · 400 µL"). */
export function AmountCard({ name, detail, amount, photo, matched = true, className }: AmountCardProps) {
  return (
    <div className={cn('grid grid-cols-[72px_minmax(0,1fr)_auto] items-center gap-3.5 rounded-[20px] bg-white py-3 pr-[18px] pl-3 shadow-soft tabular-nums', className)}>
      <span className="relative flex size-[72px] items-center justify-center rounded-[14px] bg-[#1b1b1d] text-[10px] leading-3 font-semibold text-[#8d8d93]">
        {photo ? <img src={photo} alt="" className="size-full rounded-[14px] object-cover" /> : 'Your photo'}
        {matched && (
          <span aria-hidden="true" className="absolute -right-1 -bottom-1 flex size-[22px] items-center justify-center rounded-full bg-blue text-white shadow-[0_0_0_2px_#ffffff]">
            <Check size={12} width={3.2} />
          </span>
        )}
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="m-0 text-[17px] leading-[22px] font-[650] text-ink">{name}</p>
        <p className="m-0 text-[13px] leading-[18px] text-text">{detail}</p>
      </div>
      <p className="m-0 text-[20px] leading-6 font-[750] text-ink">{amount}</p>
    </div>
  );
}

/** The lock-screen notification when a timer ends (Timer-Done): Chapp's icon, "now", what finished and what is next. */
export function TimerNotice({ title, body, when = 'now', className }: { title: string; body: string; when?: string; className?: string }) {
  return (
    <section aria-label="Notification from Chapp" className={cn('flex flex-col gap-1.5 rounded-[22px] bg-white/92 px-4 py-3.5 text-ink', className)}>
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className="flex size-[22px] items-center justify-center overflow-hidden rounded-[6px] bg-[#e8f1fb]">
          <img src="/chapp/chapp.webp" alt="" className="size-[30px] max-w-none shrink-0" />
        </span>
        <span className="grow text-[13px] leading-[18px] font-semibold text-text">Chapp</span>
        <span className="text-[13px] leading-[18px] text-text">{when}</span>
      </div>
      <p className="m-0 text-[16px] leading-[21px] font-bold">{title}</p>
      <p className="m-0 text-[15px] leading-5 text-text">{body}</p>
    </section>
  );
}
