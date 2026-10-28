import type { ReactNode } from 'react';
import { cn } from '../../lib/cn.ts';

/**
 * Small pieces of type the bench screens share: the yellow-dot label ("You said", "Heard “C is OK”", "Incubating"),
 * the highlighter on a number that just changed or needs a look, the big lines read with gloves on, and the tag the
 * storyboard requires on example readings.
 */

/** "● You said" (13 px, Plan-Heard, Run-Timer) or, with gloves on, "● Heard “next”" (15 px). */
export function DotLabel({ children, size = 'sm', dot = 'var(--mark)', className }: { children: ReactNode; size?: 'sm' | 'md'; dot?: string; className?: string }) {
  return (
    <p className={cn('m-0 flex items-center font-semibold text-text', size === 'sm' ? 'gap-1.5 text-[13px] leading-[18px]' : 'gap-2 text-[15px] leading-5', className)}>
      <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ background: dot }} />
      <span>{children}</span>
    </p>
  );
}

/**
 * The highlighter (#fff1a3) behind a number: the one that changed with the last thing said, a sample off the curve,
 * the wells to fill now. `on={false}` keeps the padding so the text does not move when the mark comes and goes.
 */
export function Mark({ children, on = true, className }: { children: ReactNode; on?: boolean; className?: string }) {
  return <span className={cn('-mx-[3px] rounded-[6px] px-[3px]', on ? 'bg-sample-bg' : 'bg-transparent', className)}>{children}</span>;
}

const bench = {
  /** The vial line on Gloves-Standards. */
  md: 'text-[28px] leading-[34px] font-[750] tracking-[-0.01em]',
  /** Amounts and names: "9.8 mL Reagent A", "Sample 1". */
  lg: 'text-[34px] leading-[42px] font-[750] tracking-[-0.01em]',
  /** "37 °C · 30 min", "B3 · B4", "Time’s up." */
  xl: 'text-[44px] leading-[52px] font-[800] tracking-[-0.02em]',
  /** "562 nm". */
  xxl: 'text-[56px] leading-16 font-[800] tracking-[-0.02em]',
  /** The running timer, "24:37". */
  clock: 'text-[72px] leading-20 font-[800] tracking-[-0.02em]',
} as const;

/** A line read from arm's length with gloves on (Gloves-*.dc.html). Ink, tabular figures. */
export function BenchLine({ children, size = 'lg', className }: { children: ReactNode; size?: keyof typeof bench; className?: string }) {
  return <p className={cn('m-0 text-ink tabular-nums', bench[size], className)}>{children}</p>;
}

/** Above a group of rows: "Your samples" at the left, "µg/mL · CV" at the right (Results-Swipe). */
export function SectionHead({ children, aside, className }: { children: ReactNode; aside?: ReactNode; className?: string }) {
  return (
    <div className={cn('mb-2 flex items-baseline justify-between gap-3 px-1', className)}>
      <h2 className="m-0 text-[13px] leading-[18px] font-semibold text-text">{children}</h2>
      {aside !== undefined && <p className="m-0 text-[13px] leading-[18px] font-semibold text-text">{aside}</p>}
    </div>
  );
}

/**
 * "Sample data": every screen that shows Chapp's built-in example readings carries it (STORYBOARD ⑦, shared/share.ts).
 * The design has no artboard for it; it borrows the sunken chip of the style board so it reads as a label, not a
 * button.
 */
export function SampleDataTag({ className }: { className?: string }) {
  return (
    <span
      role="note"
      aria-label="Sample data: Chapp's example readings, not a real plate"
      className={cn('inline-flex items-center gap-1.5 rounded-full bg-sunken px-2.5 py-1 text-[12px] leading-4 font-semibold text-text', className)}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M9 3h6" />
        <path d="M10 3v6l-5.5 9.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3" />
      </svg>
      Sample data
    </span>
  );
}

/** The design's check mark (stroke 3–3.4, round ends). */
export function Check({ size = 16, width = 3 }: { size?: number; width?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
