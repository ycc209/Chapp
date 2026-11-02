import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { OWN_TAP, tapReader, type StepTap } from './taps.ts';

/** What a tap did, shown for a moment: a step on or back, one skipped, or none further that way. */
type Flash = StepTap | 'first' | 'last';

type TapNavOptions = {
  /** Next, Back and Skip, when there is a step that way; undefined where there is none. */
  onNext?: () => void;
  onBack?: () => void;
  onSkip?: () => void;
};

const HINT_KEY = 'chapp.run.tapHint';

/**
 * Moving through a run's steps by tapping the page (taps.ts): the right of it is Next, the left Back, two taps anywhere
 * Skip; a tap on something with its own (a button, a bottle to tick) is that thing's. `onClick` goes on the page; the
 * `overlay` shows what each tap did (a glow at that side, "Skipped", or that there is no step further), and, the first
 * time on this device, how it works.
 */
export function useTapNav({ onNext, onBack, onSkip }: TapNavOptions): { onClick: (e: MouseEvent<HTMLElement>) => void; overlay: ReactNode } {
  const [flash, setFlash] = useState<{ what: Flash; n: number } | null>(null);
  const latest = useRef({ onNext, onBack, onSkip });
  latest.current = { onNext, onBack, onSkip };
  const read = useMemo(
    () =>
      tapReader(tap => {
        const { onNext, onBack, onSkip } = latest.current;
        const go = tap === 'next' ? onNext : tap === 'back' ? onBack : onSkip;
        setFlash(f => ({ what: go ? tap : tap === 'back' ? 'first' : 'last', n: (f?.n ?? 0) + 1 }));
        go?.();
      }),
    [],
  );
  // A tap still waiting for its twin when the screen goes does nothing.
  useEffect(() => () => read.cancel(), [read]);

  const onClick = (e: MouseEvent<HTMLElement>) => {
    if ((e.target as Element).closest(OWN_TAP)) return;
    if (window.getSelection()?.toString()) return;
    const box = e.currentTarget.getBoundingClientRect();
    read((e.clientX - box.left) / box.width);
  };

  return {
    onClick,
    overlay: (
      <>
        {flash && <TapFlash key={flash.n} what={flash.what} />}
        <TapHint />
      </>
    ),
  };
}

function TapFlash({ what }: { what: Flash }) {
  const fade = { animation: 'chapp-tap-flash 0.65s ease-out both' };
  if (what === 'next' || what === 'back') {
    const right = what === 'next';
    return (
      <div
        aria-hidden="true"
        className={`chapp-anim pointer-events-none absolute inset-y-0 z-[5] flex w-20 items-center ${right ? 'right-0 justify-end bg-[linear-gradient(to_left,rgba(31,111,235,0.16),transparent)] pr-3' : 'left-0 justify-start bg-[linear-gradient(to_right,rgba(31,111,235,0.16),transparent)] pl-3'}`}
        style={fade}
      >
        <span className="flex size-10 items-center justify-center rounded-full bg-white text-blue shadow-[0_2px_10px_rgba(17,17,19,0.15)]">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
            <path d={right ? 'm9 5 7 7-7 7' : 'm15 5-7 7 7 7'} />
          </svg>
        </span>
      </div>
    );
  }
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-1/2 z-[5] flex -translate-y-1/2 justify-center">
      <span className="chapp-anim rounded-full bg-ink/85 px-4 py-2 text-[15px] leading-5 font-semibold text-white backdrop-blur-sm" style={fade}>
        {what === 'skip' ? 'Skipped' : what === 'first' ? 'This is the first step' : 'This is the last step'}
      </span>
    </div>
  );
}

/** The first time on this device: how tapping the page moves through the steps, for a few seconds. */
function TapHint() {
  const [shown, setShown] = useState(() => {
    try {
      return !localStorage.getItem(HINT_KEY);
    } catch {
      return false;
    }
  });
  useEffect(() => {
    if (!shown) return;
    try {
      localStorage.setItem(HINT_KEY, '1');
    } catch {
      /* shown again next time */
    }
    const t = window.setTimeout(() => setShown(false), 4500);
    return () => clearTimeout(t);
  }, [shown]);
  if (!shown) return null;
  return (
    <div role="note" className="pointer-events-none absolute inset-x-5 bottom-[calc(112px+var(--screen-bottom))] z-[7] flex justify-center animate-in fade-in slide-in-from-bottom-2 duration-300">
      <span className="flex items-center gap-3 rounded-[18px] bg-ink/90 px-4 py-2.5 text-[13px] leading-[18px] font-medium text-white backdrop-blur-sm">
        <span>
          Tap <b>left</b> to go back, <b>right</b> for next, <b>twice</b> to skip
        </span>
      </span>
    </div>
  );
}
