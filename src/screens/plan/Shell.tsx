import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Link } from 'react-router';
import type { Expression } from '../../../shared/ai.ts';
import { ChappHeader } from '../../components/chapp/ChappHeader.tsx';
import { BottomBar } from '../../components/voice/BottomBar.tsx';
import { cn } from '../../lib/cn.ts';
import { useSession } from '../../state/session.ts';
import { ERROR_LINE } from '../home/HomeCenter.tsx';
import { PlusMenu } from '../home/PlusMenu.tsx';
import { TypingBar } from '../home/TypingBar.tsx';
import type { Turn } from '../home/useConverse.ts';
import { PlayIcon } from '../protocol/icons.tsx';

// The bar's wash (Plan.dc.html, Run-Choose.dc.html): the bar and the Next pills float over the page as it scrolls under.
const BAR_WASH =
  'radial-gradient(56% 64% at 50% 100%, rgba(121, 185, 243, 0.3) 0%, rgba(111, 211, 198, 0.1) 55%, rgba(255, 255, 255, 0) 80%), linear-gradient(rgba(255, 255, 255, 0), rgba(255, 255, 255, 0.86) 38%, rgba(255, 255, 255, 0.94))';
export const PILL = 'flex min-h-10 items-center rounded-[20px] text-[15px] leading-5 font-semibold no-underline outline-none focus-visible:ring-2 focus-visible:ring-blue';
export const WHITE_PILL = 'bg-white text-ink shadow-[0_1px_2px_rgba(17,17,19,0.06),0_2px_8px_rgba(17,17,19,0.04)]';

type ShellProps = {
  subtitle: string;
  /** The pills above the bar: Plan and Start, or Start alone. Hidden while talking, as on the other screens. */
  next: ReactNode;
  onUtterance: (text: string) => void;
  scroller?: RefObject<HTMLDivElement | null>;
  className?: string;
  children: ReactNode;
};

/**
 * The frame Run-Choose and Plan share: the page scrolling under Chapp, back to the protocol at the top left, the Next
 * pills and the bottom bar (speak, type, +) floating over the bottom.
 */
export function Shell({ subtitle, next, onUtterance, scroller, className, children }: ShellProps) {
  const voice = useSession(s => s.voice);
  const [plus, setPlus] = useState(false);
  const [typing, setTyping] = useState(false);
  const plusRef = useRef<HTMLButtonElement>(null);
  return (
    <div className={cn('relative h-full overflow-hidden bg-bg', className)}>
      <div
        ref={scroller}
        className="flex h-full flex-col overflow-y-auto px-5 pt-[calc(196px+var(--screen-top))] pb-[calc(168px+var(--screen-bottom))] [scrollbar-width:none]"
      >
        {children}
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[6] flex flex-col pt-7" style={{ background: BAR_WASH }}>
        {voice !== 'talking' && (
          <div aria-label="Next" className="pointer-events-none relative flex shrink-0 justify-center gap-2 px-5 pt-2 [&>*]:pointer-events-auto">
            {next}
          </div>
        )}
        <div className="pointer-events-auto px-5 pt-2 pb-[var(--screen-bottom)]">
          {typing ? (
            <TypingBar
              plusOpen={plus}
              plusRef={plusRef}
              onPlus={() => setPlus(o => !o)}
              onSend={onUtterance}
              onClose={() => {
                setTyping(false);
                setPlus(false);
              }}
            />
          ) : (
            <BottomBar wash={false} onPlus={() => setPlus(o => !o)} onKeyboard={() => setTyping(true)} onUtterance={onUtterance} />
          )}
        </div>
      </div>

      <PlusMenu open={plus} onClose={() => setPlus(false)} coverPlus={!typing} plusRef={plusRef} />
      <ChappHeader back={{ to: '/protocol', label: 'Back to the protocol' }} subtitle={subtitle} />
    </div>
  );
}

/** The black Start pill. */
export function StartPill({ to, onClick }: { to: string; onClick: () => void }) {
  return (
    <Link to={to} onClick={onClick} className={cn(PILL, 'gap-[7px] bg-ink pr-[18px] pl-[15px] text-white')}>
      <PlayIcon />
      Start
    </Link>
  );
}

/** What the user said, on the right in light blue (as on Protocol), and Chapp's answer under it. */
export function Exchange({ text, answer, thinking }: { text: string; answer: string; thinking?: boolean }) {
  return (
    <div className="flex shrink-0 flex-col">
      <div className="mb-5 flex justify-end">
        <p className="max-w-[calc(82%+32px)] rounded-[22px] bg-[#d6e8fc] px-4 py-2.5 text-[17px] leading-[22px] font-medium text-ink">{text}</p>
      </div>
      {/* Always mounted, so screen readers announce each answer as it arrives. */}
      <p aria-live="polite" aria-label="Chapp's answer" className="px-1 text-[17px] leading-6 font-medium text-ink">
        {thinking ? <span className="text-muted">…</span> : answer}
      </p>
    </div>
  );
}

/** The answer to show for a turn with Chapp. */
export const turnAnswer = (turn: Turn) => (turn.phase === 'reply' ? turn.say : turn.phase === 'error' ? ERROR_LINE : '');

/**
 * Chapp's face for this screen while it is on (excited to start, thinking while it asks), back to neutral after, unless
 * something else has changed it since.
 */
export function useFace(face: Expression | null) {
  useEffect(() => {
    if (!face) return;
    useSession.getState().setExpression(face);
    return () => {
      if (useSession.getState().expression === face) useSession.getState().setExpression('neutral');
    };
  }, [face]);
}

/** Brings the newest exchange at the bottom of the page into view. */
export function useFollow(scroller: RefObject<HTMLDivElement | null>, key: unknown) {
  useEffect(() => {
    if (key === null || key === undefined) return;
    const el = scroller.current;
    el?.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [key]);
}
