import { useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/cn.ts';
import { clockText, countdownText, lengthText } from './model.ts';
import { Check, DotLabel } from './Text.tsx';

/** The current time, ticking every `ms` (a second by default). Pass `frozen` to stop it at a given time. */
export function useNow(ms = 1000, frozen?: number): number {
  const [now, setNow] = useState(() => frozen ?? Date.now());
  useEffect(() => {
    if (frozen !== undefined) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms, frozen]);
  return frozen ?? now;
}

export type TimerProps = {
  /** The whole length, seconds (1800 for 30 min). */
  total: number;
  /** Running: when it ends (ms since epoch, as useRun().timers keeps it). */
  endsAt?: number | null;
  /** Stopped: the seconds that were left. Ignored while `endsAt` is set. */
  left?: number | null;
  /** "Incubating" (run) or "Incubating · 37 °C" (gloves); "Stopped" when stopped. */
  label?: string;
  /** "37 °C", for "Ends at 11:17 · 37 °C" and "Done · 30 min at 37 °C". */
  temperature?: string;
  /** `run`: 24 px time and a 2 px yellow line (Run-Timer). `gloves`: 72 px time and an 8 px ink bar (Gloves-Timer). */
  size?: 'run' | 'gloves';
  /** Tap the time (in the design's prototype: jump to the end). */
  onTap?: () => void;
  /** Called once when the time runs out while on screen. */
  onDone?: () => void;
  /** Freeze the clock (the /lab gallery, tests). */
  now?: number;
  className?: string;
};

/**
 * The incubation timer: what is running, the time left counting down to `endsAt`, a bar filling up, and when it ends.
 * Stopped, it shows the time that was left; at zero, the done line (run) or "Time’s up." (gloves). The design draws a
 * bar, not a ring (Run-Timer, Gloves-Timer).
 */
export function Timer({ total, endsAt, left, label = 'Incubating', temperature, size = 'run', onTap, onDone, now: frozen, className }: TimerProps) {
  const now = useNow(1000, frozen);
  const running = endsAt !== undefined && endsAt !== null;
  const remaining = running ? Math.max(0, Math.ceil((endsAt - now) / 1000)) : Math.max(0, left ?? total);
  const done = running ? remaining === 0 : left === 0;
  const stopped = !running && !done;
  const fired = useRef(false);
  useEffect(() => {
    if (done && running && !fired.current) {
      fired.current = true;
      onDone?.();
    }
    if (!done) fired.current = false;
  }, [done, running, onDone]);

  const time = countdownText(remaining);
  const pct = `${Math.round(((total - remaining) / total) * 1000) / 10}%`;
  const length = lengthText(total);
  const ends = running ? clockText(endsAt) : clockText(now + remaining * 1000);
  const aria = `${time} left${stopped ? ', stopped' : ''}${onTap ? '. Tap to finish now' : ''}`;

  if (size === 'gloves') {
    if (done) {
      return (
        <div className={cn('flex flex-col px-1', className)}>
          <p className="m-0 text-[44px] leading-[52px] font-[800] tracking-[-0.02em] text-ink tabular-nums">Time’s up.</p>
        </div>
      );
    }
    return (
      <div className={cn('flex flex-col items-start px-1', className)}>
        <DotLabel size="md" className="mb-1">{stopped ? 'Stopped' : label}</DotLabel>
        <button type="button" onClick={onTap} aria-label={aria} className="cursor-pointer border-0 bg-transparent p-0 text-left font-[inherit] text-[72px] leading-20 font-[800] tracking-[-0.02em] text-ink tabular-nums">
          {time}
        </button>
        <div aria-hidden="true" className="my-2 mb-2.5 h-2 self-stretch overflow-hidden rounded-[4px] bg-line">
          <div className="h-2 rounded-[4px] bg-ink" style={{ width: pct }} />
        </div>
        <p className="m-0 text-[17px] leading-6 font-medium text-ink">
          {stopped ? (
            <>
              Paused with <b className="font-bold">{time}</b> left
            </>
          ) : (
            <>
              Ends at <b className="font-bold">{ends}</b>
            </>
          )}
        </p>
      </div>
    );
  }

  if (done) {
    return (
      <div className={cn('flex items-center gap-2.5 px-1', className)}>
        <span aria-hidden="true" className="flex size-[22px] shrink-0 items-center justify-center rounded-full bg-mark text-ink">
          <Check size={11} width={3.2} />
        </span>
        <p className="m-0 text-[17px] leading-[22px] font-semibold text-ink tabular-nums">
          Done · {length}
          {temperature ? ` at ${temperature}` : ''}
        </p>
      </div>
    );
  }
  return (
    <div className={cn('flex flex-col gap-2.5 px-1', className)}>
      <DotLabel dot={stopped ? 'var(--sample-line)' : 'var(--mark)'}>{stopped ? 'Stopped' : label}</DotLabel>
      <button type="button" onClick={onTap} aria-label={aria} className="m-0 cursor-pointer border-0 bg-transparent p-0 text-left font-[inherit] text-[24px] leading-[30px] font-bold text-ink tabular-nums">
        {time} left
      </button>
      <div aria-hidden="true" className="h-0.5 overflow-hidden rounded-[1px] bg-line">
        <div className="h-0.5 bg-sample-line transition-[width] duration-1000 ease-linear" style={{ width: pct }} />
      </div>
      <p className="m-0 text-[13px] leading-[18px] font-semibold text-text tabular-nums">
        {stopped ? `${length}${temperature ? ` at ${temperature}` : ''}, paused` : `Ends at ${ends}${temperature ? ` · ${temperature}` : ''}`}
      </p>
    </div>
  );
}

/**
 * "Done at 11:23": when a timer of `seconds` started now would end (Run-Incubate, Gloves-Incubate). `marked` flashes
 * the time when the choice just changed.
 */
export function DoneAt({ seconds, size = 'run', marked = false, now: frozen, className }: { seconds: number; size?: 'run' | 'gloves'; marked?: boolean; now?: number; className?: string }) {
  const now = useNow(15000, frozen);
  const at = clockText(now + seconds * 1000);
  if (size === 'gloves') {
    return (
      <p className={cn('m-0 text-[17px] leading-6 font-medium text-ink', className)}>
        Done at <b className="font-bold">{at}</b>
      </p>
    );
  }
  return (
    <p className={cn('m-0 px-1 text-[15px] leading-[22px] text-text tabular-nums', className)}>
      Done at <b className={cn('rounded-[3px] px-0.5 font-bold text-ink', marked ? 'bg-sample-bg' : 'bg-transparent')}>{at}</b>
    </p>
  );
}
