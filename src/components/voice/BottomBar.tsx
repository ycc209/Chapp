import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react';
import { cn } from '../../lib/cn.ts';
import { useSession } from '../../state/session.ts';
import { primeSpeech } from '../../voice/speak.ts';
import { useVoice } from '../../voice/useVoice.ts';
import { Waveform } from './Waveform.tsx';

export type BottomBarProps = {
  /** Opens the + menu: camera, QR code, upload. */
  onPlus: () => void;
  /** Switches to typing. */
  onKeyboard: () => void;
  /** Called with each thing the user finished saying (a tap's one sentence, a hold, or each turn while talking). */
  onUtterance: (text: string) => void;
  /**
   * Paints the idle wash behind the bar (default). A screen that paints one wash under both its pills and the bar
   * (Plan, Results, Protocol) turns it off, so the two do not double; the listening glow still shows.
   */
  wash?: boolean;
  /**
   * A tap starts listening for good (turn after turn) instead of for one sentence, and a tap while listening pauses:
   * Chapp's conversation mode. Holding works the same either way.
   */
  tapTalks?: boolean;
};

/** Held this long, a press is a hold: let go, it sends what was said. A quicker press is a tap. */
export const HOLD_MS = 350;
/** Slid up this far while holding, letting go cancels instead of sending. Sliding back down sends again. */
export const CANCEL_PX = 64;
/** How far the wave and the hint rise as the press slides up to cancel. */
const RISE_PX = 18;

// Gradients from the design, Main and Listening.
/** Idle: a soft blue and teal wash at the bottom edge, fading into white. */
const IDLE_BG =
  'radial-gradient(56% 64% at 50% 100%, rgba(121, 185, 243, 0.3) 0%, rgba(111, 211, 198, 0.1) 55%, rgba(255, 255, 255, 0) 80%), linear-gradient(rgba(255, 255, 255, 0), rgba(255, 255, 255, 0.86) 38%, rgba(255, 255, 255, 0.94))';
/** Listening, talking and holding: the same wash, stronger and wider. */
const GLOW =
  'radial-gradient(120% 100% at 50% 100%, rgba(121, 185, 243, 0.45) 0%, rgba(111, 211, 198, 0.18) 42%, rgba(255, 255, 255, 0) 72%), linear-gradient(rgba(255, 255, 255, 0), rgba(255, 255, 255, 0.9) 62%)';
/** Slid up to cancel: the glow turns to the notes' caution colour. */
const CANCEL_GLOW =
  'radial-gradient(120% 100% at 50% 100%, rgba(255, 214, 153, 0.55) 0%, rgba(255, 244, 224, 0.3) 42%, rgba(255, 255, 255, 0) 72%), linear-gradient(rgba(255, 255, 255, 0), rgba(255, 255, 255, 0.9) 62%)';

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
 * Tap: say one thing (listening; a tap on Listening sends it now). Press and hold: Chapp listens at once and the words
 * appear in a bubble above the bar as they are heard; let go to send them, or slide up first and let go to cancel
 * (sliding back down sends again). Nothing heard, nothing is sent. Enter or Space on the button is a tap.
 */
export function BottomBar({ onPlus, onKeyboard, onUtterance, wash = true, tapTalks = false }: BottomBarProps) {
  const { voice, tap, hold, asTap, cancel, talk, send, end } = useVoice(onUtterance);
  const heard = useSession(s => s.heard);
  const interim = useSession(s => s.interim);
  // Held long enough to be a hold; slid up to cancel; let go, waiting for the last words to be sent.
  const [held, setHeld] = useState(false);
  const [lift, setLift] = useState(0);
  const [sending, setSending] = useState(false);
  const press = useRef({ on: false, y: 0, at: 0, timer: 0, upAt: -Infinity });

  useEffect(() => () => clearTimeout(press.current.timer), []);
  // The microphone closed (sent, cancelled, or it failed): the bar is back to Tap to speak.
  useEffect(() => {
    if (voice === 'holding') return;
    clearTimeout(press.current.timer);
    press.current.on = false;
    setHeld(false);
    setLift(0);
    setSending(false);
  }, [voice]);

  const cancelling = lift >= CANCEL_PX;
  const rise = (y: number) => Math.max(0, press.current.y - y);

  const down = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    primeSpeech();
    const p = press.current;
    p.on = true;
    p.y = e.clientY;
    p.at = performance.now();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setLift(0);
    // The microphone opens at once, so the first word is not lost; a quick release turns it into a tap.
    hold();
    clearTimeout(p.timer);
    p.timer = window.setTimeout(() => setHeld(true), HOLD_MS);
  };
  const move = (e: PointerEvent<HTMLButtonElement>) => {
    if (!press.current.on) return;
    const l = Math.round(rise(e.clientY));
    setLift(prev => (Math.abs(l - prev) >= 2 ? l : prev));
  };
  const up = (e: PointerEvent<HTMLButtonElement>) => {
    const p = press.current;
    if (!p.on) return;
    p.on = false;
    clearTimeout(p.timer);
    p.upAt = performance.now();
    const quick = p.upAt - p.at < HOLD_MS;
    const slid = rise(e.clientY) >= CANCEL_PX;
    // The microphone may already have stopped (no microphone, permission refused): nothing to send or cancel.
    if (useSession.getState().voice !== 'holding') return;
    if (slid) cancel();
    else if (quick) {
      if (tapTalks) talk();
      else asTap();
    } else {
      setSending(true);
      send();
    }
  };
  const lost = () => {
    if (!press.current.on) return;
    press.current.on = false;
    clearTimeout(press.current.timer);
    if (useSession.getState().voice === 'holding') cancel();
  };
  // Enter or Space: a click with no pointer behind it.
  const key = (e: MouseEvent) => e.detail === 0 && (tapTalks ? talk() : tap());
  // The click that follows a tap's pointerup reaches the button after it became Listening: it must not stop what it started.
  const echo = (e: MouseEvent) => e.detail > 0 && performance.now() - press.current.upAt < 500;

  if (voice === 'talking') {
    return (
      <div className={cn('relative grid grid-cols-3 items-center', BAR)} style={{ background: GLOW }}>
        <span />
        <button
          type="button"
          aria-label={tapTalks ? 'Listening. Tap to pause' : 'Listening. Tap to end the conversation'}
          onClick={e => echo(e) || end()}
          className={cn(CENTER, 'justify-self-center')}
        >
          <Waveform moving />
          <span className={LABEL}>Listening</span>
        </button>
        {tapTalks ? (
          <button type="button" aria-label="Type instead" onClick={onKeyboard} className={cn(ROUND, 'justify-self-end')}>
            <KeyboardIcon />
          </button>
        ) : (
          <span />
        )}
      </div>
    );
  }

  const listening = voice === 'listening';
  const holding = voice === 'holding';
  const words = heard || interim;
  // The bubble shows once it is a hold (or words came in), and stays while the last words are sent.
  const bubble = holding && (held || Boolean(words) || sending);
  const shift = { transform: `translateY(${-Math.round(Math.min(lift, CANCEL_PX) / CANCEL_PX * RISE_PX)}px)` };
  return (
    <div
      className={cn('relative grid grid-cols-3 items-center', BAR)}
      style={{ background: holding ? (cancelling ? CANCEL_GLOW : GLOW) : listening ? GLOW : wash ? IDLE_BG : undefined, transition: 'background 0.2s' }}
    >
      {bubble && <HoldBubble heard={heard} interim={interim} cancelling={cancelling && !sending} sending={sending} />}
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
          aria-label={tapTalks ? 'Tap to listen. Hold to say one thing' : 'Tap to speak. Hold to talk, slide up to cancel'}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={lost}
          onClick={key}
          onContextMenu={e => e.preventDefault()}
          className={cn(CENTER, 'justify-self-center touch-none select-none [-webkit-touch-callout:none]')}
        >
          {/* Held: "Slide up to cancel" above the wave, rising as the finger does. */}
          <span
            aria-hidden="true"
            className="absolute top-[-22px] left-1/2 flex -translate-x-1/2 items-center gap-1 text-[12px] leading-4 font-semibold whitespace-nowrap text-muted"
            style={{ opacity: holding && held && !cancelling && !sending ? 1 : 0, transition: 'opacity 0.2s', ...shift }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m6 15 6-6 6 6" />
            </svg>
            Slide up to cancel
          </span>
          <span aria-hidden="true" className="flex" style={shift}>
            <Waveform moving={holding && !cancelling} className={cancelling ? '[&>span]:bg-caution' : undefined} />
          </span>
          <span className={cn(LABEL, 'whitespace-nowrap', cancelling && !sending && 'text-caution')}>
            {!holding ? (tapTalks ? 'Tap to listen' : 'Tap to speak') : sending ? 'Sending' : cancelling ? 'Release to cancel' : held ? 'Release to send' : 'Listening'}
          </span>
        </button>
      )}
      <button type="button" aria-label="Type instead" onClick={onKeyboard} className={cn(ROUND, 'justify-self-end')}>
        <KeyboardIcon />
      </button>
    </div>
  );
}

/**
 * What is heard while Tap to speak is held, in a bubble above the bar (the user's bubbles elsewhere): settled words in
 * ink, the ones still being recognized in grey; the moving wave until the first word (the server's recognizer has
 * none until the end). Slid up, it turns to caution: letting go cancels.
 */
function HoldBubble({ heard, interim, cancelling, sending }: { heard: string; interim: string; cancelling: boolean; sending: boolean }) {
  const words = heard || interim;
  return (
    <div className="pointer-events-none absolute right-5 bottom-[calc(100%+20px)] left-5 flex justify-end">
      <div
        role="status"
        aria-live="polite"
        aria-label={cancelling ? 'Release to cancel' : 'What Chapp hears'}
        className={cn(
          'flex max-w-[calc(82%+32px)] flex-col gap-1 rounded-[22px] px-4 py-2.5 text-[17px] leading-[22px] font-medium shadow-[0_2px_12px_rgba(17,17,19,0.06)] transition-colors duration-200 [overflow-wrap:anywhere] animate-in fade-in slide-in-from-bottom-1',
          cancelling ? 'bg-caution-bg text-caution' : 'bg-[#d6e8fc] text-ink',
        )}
      >
        {cancelling && (
          <span className="flex items-center gap-1.5 text-[15px] leading-5 font-semibold">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
            Release to cancel
          </span>
        )}
        {words ? (
          <p className={cn('m-0', cancelling && 'opacity-60')}>
            {heard}
            {interim && (
              <span className={cancelling ? undefined : 'text-muted'}>
                {heard && !heard.endsWith(' ') ? ' ' : ''}
                {interim}
              </span>
            )}
          </p>
        ) : (
          !cancelling && (
            <span className="flex items-center gap-2 text-[15px] leading-5 font-semibold text-text">
              <Waveform moving={!sending} height={14} />
              {sending ? 'Sending' : 'Listening'}
            </span>
          )
        )}
      </div>
    </div>
  );
}

function KeyboardIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M7 16h10" />
    </svg>
  );
}
