import { useEffect } from 'react';
import type { Expression } from '../../../shared/ai.ts';
import { cn } from '../../lib/cn.ts';

// The faces with a closed-eyes twin for blinking; the others (happy, wink, sleepy) hold their look.
const BLINKS: ReadonlySet<Expression> = new Set(['neutral', 'thinking', 'excited', 'surprised', 'sad', 'listen']);
const FACES: Expression[] = ['neutral', 'happy', 'thinking', 'excited', 'surprised', 'sad', 'wink', 'sleepy', 'listen'];

const face = (e: Expression) => (e === 'neutral' ? '/chapp/chapp.webp' : `/chapp/chapp-${e}.webp`);
const blink = (e: Expression) => (e === 'neutral' ? '/chapp/chapp-blink.webp' : `/chapp/chapp-${e}-blink.webp`);
// Neutral and listen are rendered at 600 px, the other faces at 720 px with more room around Chapp. The artboards
// draw those 1.2× (115.2 px, 9.6 px out on each side) so Chapp's body stays the same size whatever the face.
const WIDE: ReadonlySet<Expression> = new Set(['happy', 'thinking', 'excited', 'surprised', 'sad', 'wink', 'sleepy']);

type ChappAvatarProps = {
  expression: Expression;
  /** Listening or in a conversation: faster breath and two rings going out (Listening.dc.html). */
  listening?: boolean;
  className?: string;
};

/**
 * Chapp's 96 px picture, as at the top of every artboard: it breathes (squashing from its base, 50% 87%), blinks
 * every 5.2 s, and while it listens breathes faster with two rings going out behind it.
 */
export function ChappAvatar({ expression, listening = false, className }: ChappAvatarProps) {
  usePreloadFaces();
  const size = WIDE.has(expression) ? 'top-[-9.6px] left-[-9.6px] size-[115.2px]' : 'top-0 left-0 size-24';
  return (
    <span aria-hidden="true" className={cn('relative block size-24', className)}>
      {listening && (
        <>
          <Ring delay="0s" />
          <Ring delay="0.9s" />
        </>
      )}
      <span
        className="chapp-anim absolute inset-0 origin-[50%_87%]"
        style={{ animation: `chapp-breathe ${listening ? 2.4 : 3.6}s ease-in-out infinite` }}
      >
        <img src={face(expression)} alt="" draggable={false} className={cn('absolute max-w-none select-none', size)} />
        {BLINKS.has(expression) && (
          <img
            src={blink(expression)}
            alt=""
            draggable={false}
            className={cn('chapp-anim absolute max-w-none opacity-0 select-none', size)}
            style={{ animation: 'chapp-blink 5.2s linear infinite' }}
          />
        )}
      </span>
    </span>
  );
}

function Ring({ delay }: { delay: string }) {
  return (
    <span
      className="chapp-anim absolute top-4 left-[18px] size-[60px] rounded-full border-2 border-[rgba(121,185,243,0.75)]"
      style={{ animation: `chapp-ring 1.8s ease-out infinite ${delay}` }}
    />
  );
}

let preloaded = false;

/** Fetches every face once the page is idle, so a change of expression never shows a blank frame. */
function usePreloadFaces() {
  useEffect(() => {
    if (preloaded) return;
    preloaded = true;
    const load = () => {
      for (const e of FACES) {
        new Image().src = face(e);
        if (BLINKS.has(e)) new Image().src = blink(e);
      }
    };
    if ('requestIdleCallback' in window) requestIdleCallback(load, { timeout: 3000 });
    else setTimeout(load, 1200);
  }, []);
}
