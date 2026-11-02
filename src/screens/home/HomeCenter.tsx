import { ReplyText, ReplySources } from '../../components/chapp/ReplyText.tsx';
import { useScreen } from '../../app/screen.ts';
import { useSession } from '../../state/session.ts';
import { cn } from '../../lib/cn.ts';
import type { Turn } from './useConverse.ts';

// The design's display type for what is said on this screen (Listening.dc.html): 30/38 bold, tight.
const DISPLAY = 'text-[30px] leading-[38px] font-bold tracking-[-0.02em] text-ink';
// A longer answer steps down to the title size so it still fits above the bar.
const LONG = 'text-[22px] leading-[30px] font-[650] tracking-[-0.01em] text-ink';
const LONG_AFTER = 110;
// The small line above it: the greeting.
const SMALL = 'text-[15px] leading-5 font-semibold text-text';
// What the user said, once sent: at the top on the left, Chapp's answer under it on the right.
const SAID = 'text-[20px] leading-[26px] font-semibold tracking-[-0.01em] text-text';

export const ERROR_LINE = "Sorry, I couldn't get an answer. Try again?";

/**
 * The middle of the home screen: the greeting, the words being heard (held, inside the bar's glow, which has grown up
 * behind them), or the last exchange with Chapp: what the user said at the top on the left, the answer under it on the
 * right.
 */
export function HomeCenter({ turn }: { turn: Turn | null }) {
  const voice = useSession(s => s.voice);
  const heard = useSession(s => s.heard);
  const interim = useSession(s => s.interim);
  const hearing = voice !== 'idle' && (heard || interim);
  const answer = turn?.phase === 'reply' || turn?.phase === 'thinking' ? turn.say || '' : turn?.phase === 'error' ? turn.error || ERROR_LINE : '';
  // With the keyboard up there is little room left: the words sit close to the message box.
  const { keyboard } = useScreen();

  return (
    // In front of the bar's glow, which rises behind these words while Chapp listens.
    <div
      className={cn(
        'relative z-[1] flex min-h-0 grow flex-col gap-2 overflow-y-auto px-2 [scrollbar-width:none]',
        turn && !hearing ? 'justify-start pt-4' : 'justify-center-safe',
        keyboard ? 'pb-3' : 'pb-16',
      )}
    >
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
      ) : turn ? (
        <>
          {/* Up from the glow, where it was heard. */}
          <p className={cn(SAID, 'line-clamp-3 animate-in fade-in slide-in-from-bottom-8 duration-500')}>{turn.text}</p>
          <div className="mt-4 flex max-w-[88%] flex-col gap-2 self-end animate-in fade-in duration-500">
            {turn.phase === 'thinking' ? (
              answer ? <ReplyText text={answer} className={LONG} /> : <p className={DISPLAY}>{turn.progress || '…'}</p>
            ) : (
              answer && <ReplyText text={answer} className={answer.length > LONG_AFTER ? LONG : DISPLAY} />
            )}
            {turn.phase === 'reply' && <ReplySources sources={turn.sources} />}
          </div>
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
