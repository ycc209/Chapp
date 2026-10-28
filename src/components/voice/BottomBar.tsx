import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react';
import { cn } from '../../lib/cn.ts';
import { primeSpeech } from '../../voice/speak.ts';
import { useVoice } from '../../voice/useVoice.ts';
import { Waveform } from './Waveform.tsx';

export type BottomBarProps = {
  /** Opens the + menu: camera, QR code, upload. */
  onPlus: () => void;
  /** Switches to typing. */
  onKeyboard: () => void;
  /** Called with each thing the user finished saying (a tap's one sentence, or each turn while talking). */
  onUtterance: (text: string) => void;
  /**
   * Paints the idle wash behind the bar (default). A screen that paints one wash under both its pills and the bar
   * (Plan, Results, Protocol) turns it off, so the two do not double; the listening glow still shows.
   */
  wash?: boolean;
};

/** Hold this long before sliding counts: a quicker press is a tap. */
const HOLD_MS = 350;
/** Sliding up this far is a full lift; release past 90% of it starts the conversation. */
const LIFT_PX = 80;
const TALK_LIFT = 0.9;
/** How far the wave and chevron rise at a full lift. */
const RISE_PX = 22;

// Gradients from the design, Main and Listening.
/** Idle: a soft blue and teal wash at the bottom edge, fading into white. */
const IDLE_BG =
  'radial-gradient(56% 64% at 50% 100%, rgba(121, 185, 243, 0.3) 0%, rgba(111, 211, 198, 0.1) 55%, rgba(255, 255, 255, 0) 80%), linear-gradient(rgba(255, 255, 255, 0), rgba(255, 255, 255, 0.86) 38%, rgba(255, 255, 255, 0.94))';
/** Listening, talking and the glow while holding: the same wash, stronger and wider. */
const GLOW =
  'radial-gradient(120% 100% at 50% 100%, rgba(121, 185, 243, 0.45) 0%, rgba(111, 211, 198, 0.18) 42%, rgba(255, 255, 255, 0) 72%), linear-gradient(rgba(255, 255, 255, 0), rgba(255, 255, 255, 0.9) 62%)';

/**
 * The design's margin -8px -20px -34px and padding 8px 20px 34px: the screen pads its content 20 px at the sides and
 * 34 px at the bottom, and the bar bleeds to its edges. 34 px is --screen-bottom (more on a phone with a taller home
 * indicator).
 */
const BAR = '-mx-5 -mt-2 mb-[calc(-1*var(--screen-bottom,34px))] px-5 pt-2 pb-[var(--screen-bottom,34px)]';
const ROUND =
  'relative flex size-11 items-center justify-center rounded-[22px] bg-[rgba(255,255,255,0.86)] text-ink shadow-[0_0_0_1px_rgba(17,17,19,0.06)] backdrop-blur-[12px] outline-none focus-visible:ring-2 focus-visible:ring-blue';
const CENTER =
  'relative flex h-16 min-w-[132px] flex-col items-center justify-center gap-[7px] rounded-[32px] px-3 text-text outline-none focus-visible:ring-2 focus-visible:ring-blue';
const LABEL = 'text-[15px] leading-5 font-semibold text-text';

/**
 * + on the left, Tap to speak in the middle, the keyboard on the right (design: Main, Listening).
 *
 * Tap: say one thing (listening; a tap on Listening sends it now). Hold for a moment, then slide up and let go:
 * talk with Chapp (talking; a tap on Listening ends it). Enter or Space on the button is a tap.
 */
export function BottomBar({ onPlus, onKeyboard, onUtterance, wash = true }: BottomBarProps) {
  const { voice, tap, talk, send, end } = useVoice(onUtterance);
  const [hold, setHold] = useState(false);
  const [lift, setLift] = useState(0);
  const press = useRef({ on: false, held: false, y: 0, lift: 0, timer: 0, upAt: -Infinity });

  useEffect(() => () => clearTimeout(press.current.timer), []);

  const reset = () => {
    const p = press.current;
    clearTimeout(p.timer);
    p.on = false;
    p.held = false;
    p.lift = 0;
    setHold(false);
    setLift(0);
  };
  const rise = (y: number) => Math.max(0, Math.min(1, (press.current.y - y) / LIFT_PX));

  const down = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    primeSpeech();
    const p = press.current;
    p.on = true;
    p.held = false;
    p.y = e.clientY;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    clearTimeout(p.timer);
    p.timer = window.setTimeout(() => {
      p.held = true;
      setHold(true);
      setLift(0);
    }, HOLD_MS);
  };
  const move = (e: PointerEvent<HTMLButtonElement>) => {
    const p = press.current;
    if (!p.on || !p.held) return;
    const l = rise(e.clientY);
    if (Math.abs(l - p.lift) > 0.04) {
      p.lift = l;
      setLift(l);
    }
  };
  const up = (e: PointerEvent<HTMLButtonElement>) => {
    const p = press.current;
    if (!p.on) return;
    const held = p.held;
    const l = rise(e.clientY);
    reset();
    p.upAt = performance.now();
    if (!held) tap();
    else if (l >= TALK_LIFT) talk();
  };
  const cancel = () => press.current.on && reset();
  // Enter or Space: a click with no pointer behind it.
  const key = (e: MouseEvent) => e.detail === 0 && tap();
  // The click that follows a tap's pointerup reaches the button after it became Listening: it must not stop what it started.
  const echo = (e: MouseEvent) => e.detail > 0 && performance.now() - press.current.upAt < 500;

  if (voice === 'talking') {
    return (
      <div className={cn('relative flex justify-center', BAR)} style={{ background: GLOW }}>
        <button type="button" aria-label="Listening. Tap to end the conversation" onClick={e => echo(e) || end()} className={CENTER}>
          <Waveform moving />
          <span className={LABEL}>Listening</span>
        </button>
      </div>
    );
  }

  const listening = voice === 'listening';
  const holding = hold && !listening;
  const shift = { transform: `translateY(${Math.round(-lift * RISE_PX)}px)` };
  return (
    <div className={cn('relative grid grid-cols-3 items-center', BAR)} style={{ background: listening ? GLOW : wash ? IDLE_BG : undefined }}>
      {!listening && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 h-[170px]"
          style={{ opacity: holding ? Math.round((0.35 + lift * 0.65) * 100) / 100 : 0, transition: 'opacity 0.25s', background: GLOW }}
        />
      )}
      <button type="button" aria-label="Camera, QR code or upload" onClick={onPlus} className={cn(ROUND, 'justify-self-start')}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
      {listening ? (
        <button type="button" aria-label="Stop listening and send" onClick={e => echo(e) || send()} className={cn(CENTER, 'justify-self-center')}>
          <Waveform moving />
          <span className={LABEL}>Listening</span>
        </button>
      ) : (
        <button
          type="button"
          aria-label="Tap to speak. Hold and slide up to talk with Chapp"
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={cancel}
          onClick={key}
          onContextMenu={e => e.preventDefault()}
          className={cn(CENTER, 'justify-self-center touch-none select-none [-webkit-touch-callout:none]')}
        >
          <span
            aria-hidden="true"
            className="absolute top-[-14px] left-1/2 ml-[-8px] flex text-blue"
            style={{ opacity: holding ? 1 : 0, transition: 'opacity 0.2s', ...shift }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m6 15 6-6 6 6" />
            </svg>
          </span>
          <span aria-hidden="true" className="flex" style={shift}>
            <Waveform moving={holding} />
          </span>
          <span className={LABEL}>{holding ? 'Talk with Chapp' : 'Tap to speak'}</span>
        </button>
      )}
      <button type="button" aria-label="Type instead" onClick={onKeyboard} className={cn(ROUND, 'justify-self-end')}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="2" y="5" width="20" height="14" rx="2" />
          <path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M7 16h10" />
        </svg>
      </button>
    </div>
  );
}
