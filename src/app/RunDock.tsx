import { useRef, useState, type PointerEvent } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useNow } from '../components/lab/Timer.tsx';
import { cn } from '../lib/cn.ts';
import { leftText, useDock } from '../state/dock.ts';
import { useRun } from '../state/run.ts';
import { useScreen } from './screen.ts';

// The run's own screens show it whole; the camera's are the camera's.
const HIDDEN_ON = /^\/(?:run|kit|watch)(?:\/|$)/;
/** The floating run's width, and how far it keeps from the screen's side. */
const WIDTH = 224;
const EDGE = 12;
/** A press that moves farther than this (px of the screen) drags it rather than taps it. */
const DRAG_PX = 6;

/**
 * The run made small (the run's minimize button, state/dock.ts): a card floating over every screen but the run's own,
 * Chapp beside the step it is on ("Step 3 of 10", the step's title), the time left on a timer that is running, and a
 * bar of how far the run is. A tap opens the run on its step; a drag moves it, and it settles at the nearer side of the
 * screen, where it stays.
 */
export function RunDock() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { scale } = useScreen();
  const titles = useDock(s => s.titles);
  const side = useDock(s => s.side);
  const y = useDock(s => s.y);
  const protocolId = useRun(s => s.protocolId);
  const step = useRun(s => s.step);
  const timers = useRun(s => s.timers);
  const running = Object.values(timers).filter(t => t > Date.now());
  const now = useNow(running.length ? 1000 : 30000);
  const soonest = running.length ? Math.min(...running) : null;
  const card = useRef<HTMLButtonElement>(null);
  const press = useRef<{ x: number; y: number } | null>(null);
  const dragged = useRef(false);
  // How far the finger has moved it, as the last move said (the picture can be a frame behind).
  const moved = useRef({ dx: 0, dy: 0 });
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);

  if (!titles?.length || !protocolId || HIDDEN_ON.test(pathname)) return null;
  const at = Math.min(Math.max(step, 0), titles.length - 1);

  const open = () => {
    useDock.getState().restore();
    navigate(`/run/${at + 1}`);
  };
  const down = (e: PointerEvent<HTMLButtonElement>) => {
    press.current = { x: e.clientX, y: e.clientY };
    dragged.current = false;
    // Kept on the card while the finger moves, where the browser allows it.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* the moves still reach it while over it */
    }
  };
  const move = (e: PointerEvent<HTMLButtonElement>) => {
    if (!press.current) return;
    const dx = (e.clientX - press.current.x) / scale;
    const dy = (e.clientY - press.current.y) / scale;
    if (dragged.current || Math.hypot(dx, dy) > DRAG_PX) {
      dragged.current = true;
      moved.current = { dx, dy };
      setDrag({ dx, dy });
    }
  };
  // Let go after a drag: it settles at the nearer side, as far down as it was let go (the screen's px, unscaled).
  const up = () => {
    press.current = null;
    if (!dragged.current) return;
    setDrag(null);
    const host = card.current?.parentElement?.getBoundingClientRect();
    if (!host) return;
    const width = host.width / scale;
    const height = host.height / scale;
    const left = (side === 'left' ? EDGE : width - WIDTH - EDGE) + moved.current.dx;
    const top = y * height + moved.current.dy;
    useDock.getState().place(left + WIDTH / 2 < width / 2 ? 'left' : 'right', Math.min(0.82, Math.max(0.1, top / height)));
  };

  return (
    <button
      ref={card}
      type="button"
      aria-label={`Back to the run: step ${at + 1} of ${titles.length}, ${titles[at]}`}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={() => {
        press.current = null;
        setDrag(null);
      }}
      // A drag ends in a click too: only a tap opens the run.
      onClick={() => (dragged.current ? (dragged.current = false) : open())}
      className={cn(
        'absolute z-[40] flex h-[60px] cursor-pointer touch-none items-center gap-2.5 overflow-hidden rounded-[20px] border-0 bg-white/92 py-0 pr-3 pl-2 text-left font-[inherit] shadow-[0_0_0_1px_rgba(17,17,19,0.06),0_10px_30px_-6px_rgba(17,17,19,0.28)] outline-none backdrop-blur-[14px] select-none focus-visible:ring-2 focus-visible:ring-blue animate-in fade-in zoom-in-90 duration-300',
        !drag && 'transition-[left,top] duration-300 ease-out',
      )}
      style={{
        width: WIDTH,
        top: `${y * 100}%`,
        left: side === 'left' ? EDGE : `calc(100% - ${WIDTH + EDGE}px)`,
        transform: drag ? `translate(${drag.dx}px, ${drag.dy}px)` : undefined,
      }}
    >
      <img src="/chapp/chapp.webp" alt="" draggable={false} className="size-11 shrink-0 rounded-full object-cover" />
      <span className="flex min-w-0 grow flex-col">
        <span className="flex items-center justify-between gap-2 text-[12px] leading-4 font-semibold text-text">
          <span>
            Step {at + 1} of {titles.length}
          </span>
          {soonest !== null && (
            <span className="flex items-center gap-1 text-blue tabular-nums">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true">
                <circle cx="12" cy="13" r="8" />
                <path d="M12 9v4l2.5 2M9 2h6" />
              </svg>
              {leftText(soonest - now)}
            </span>
          )}
        </span>
        <span className="truncate text-[14px] leading-[19px] font-semibold text-ink">{titles[at]}</span>
      </span>
      <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-[3px] bg-blue/12">
        <span className="block h-full bg-blue" style={{ width: `${((at + 1) / titles.length) * 100}%` }} />
      </span>
    </button>
  );
}
