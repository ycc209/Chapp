import { useScreen } from '../../app/screen.ts';
import { useSession } from '../../state/session.ts';
import { cn } from '../../lib/cn.ts';
import type { Turn } from './useConverse.ts';

// The design's display type for what is said on this screen (Listening.dc.html): 30/38 bold, tight.
const DISPLAY = 'text-[30px] leading-[38px] font-bold tracking-[-0.02em] text-ink';
// A longer answer steps down to the title size so it still fits above the bar.
const LONG = 'text-[22px] leading-[30px] font-[650] tracking-[-0.01em] text-ink';
const LONG_AFTER = 110;
// The small line above it: the greeting, or what the user asked once Chapp answers.
const SMALL = 'text-[15px] leading-5 font-semibold text-text';

export const ERROR_LINE = "Sorry, I couldn't get an answer. Try again?";

/** The middle of the home screen: the greeting, the words being heard, or the last exchange with Chapp. */
export function HomeCenter({ turn }: { turn: Turn | null }) {
  const voice = useSession(s => s.voice);
  const heard = useSession(s => s.heard);
  const interim = useSession(s => s.interim);
  const hearing = voice !== 'idle' && (heard || interim);
  const answer = turn?.phase === 'reply' ? turn.say : turn?.phase === 'error' ? ERROR_LINE : '';
  // With the keyboard up there is little room left: the words sit close to the message box.
  const { keyboard } = useScreen();

  return (
    <div className={cn('flex min-h-0 grow flex-col justify-center-safe gap-2 overflow-y-auto px-2 [scrollbar-width:none]', keyboard ? 'pb-3' : 'pb-16')}>
      {/* Always mounted, so screen readers announce each answer as it arrives. */}
      <p aria-live="polite" className="sr-only">
        {answer}
      </p>
      {hearing ? (
        // Listening.dc.html: settled words in ink, the ones still being recognized in grey.
        <p aria-live="polite" className={DISPLAY}>
          {heard}
          {interim && (
            <span className="text-faint">
              {heard && !heard.endsWith(' ') ? ' ' : ''}
              {interim}
            </span>
          )}
        </p>
      ) : turn?.phase === 'thinking' ? (
        <p className={DISPLAY}>{turn.text}</p>
      ) : turn ? (
        <>
          <p className={cn(SMALL, 'line-clamp-2')}>{turn.text}</p>
          {answer && <p className={answer.length > LONG_AFTER ? LONG : DISPLAY}>{answer}</p>}
        </>
      ) : (
        <>
          <p className={SMALL}>{greeting()}</p>
          <h1 className="text-[32px] leading-[38px] font-bold tracking-[-0.02em] text-ink">What are we running today?</h1>
        </>
      )}
    </div>
  );
}

/** Morning until noon, afternoon until six, evening after that (and through the night), by the phone's clock. */
export function greeting(hour = new Date().getHours()) {
  if (hour >= 5 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 18) return 'Good afternoon';
  return 'Good evening';
}
