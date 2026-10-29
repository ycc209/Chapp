import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import type { Expression } from '../../../shared/ai.ts';
import { useSession } from '../../state/session.ts';
import { startListening } from '../../voice/controller.ts';
import { ChappAvatar } from './ChappAvatar.tsx';
import { ChappStage } from './ChappStage.tsx';

export type ChappHeaderProps = {
  /** The line under the name when Chapp has nothing else to say: the screen's subject ("Pierce BCA · Plan"). */
  subtitle?: string;
  /** Top left, the menu: opens the sidebar (library and history). */
  onMenu?: () => void;
  /** Top left, back to a screen, instead of the menu. */
  back?: { to: string; label: string; /** An × instead of the back arrow: closing what is open (the conversation). */ close?: boolean };
  /**
   * Drawn under the avatar instead of the name pill, e.g. the run screens' lab StepPill ("Chapp / Step 1 of 6 ·
   * Standards"; give it -mt-4). Chapp's status, when it has one ("Thinking", a microphone problem), still shows in
   * the name pill until it clears.
   */
  pill?: ReactNode;
  /** A tap on Chapp, instead of opening the conversation (the conversation itself pauses or resumes listening). */
  onAvatar?: () => void;
  /** Says what a tap on Chapp does, with onAvatar. */
  avatarLabel?: string;
};

/** Held this long, a press on Chapp opens it in 3D instead. */
const STAGE_HOLD_MS = 500;

// How long the stage takes to fly Chapp home after it closes (the design's stage3dClose: 200 ms + 580 ms); the
// avatar stays hidden until then so there are never two Chapps on screen.
const STAGE_RETURN_MS = 780;

/**
 * Chapp at the top of every screen (Main.dc.html, Listening.dc.html): the white fade the page scrolls under, the
 * breathing avatar with its name and what it is doing, and the button at the top left. Tapping Chapp opens the
 * conversation with it (/chat), listening already; holding Chapp opens it in 3D.
 */
export function ChappHeader({ subtitle, onMenu, back, pill, onAvatar, avatarLabel }: ChappHeaderProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const held = useRef({ timer: 0, opened: false });
  const voice = useSession(s => s.voice);
  const expression = useSession(s => s.expression);
  const status = useSession(s => s.status);
  const avatar = useRef<HTMLButtonElement>(null);
  const [stage, setStage] = useState<'closed' | 'open' | 'closing'>('closed');
  const [origin, setOrigin] = useState<DOMRect | null>(null);

  const listening = voice !== 'idle';
  // Listening shows its own face, unless a reply is showing a stronger one (thinking, happy, sad…).
  const face: Expression = listening && expression === 'neutral' ? 'listen' : expression;
  const line = status || (listening ? 'Listening' : subtitle);

  useEffect(() => {
    if (stage !== 'closing') return;
    const t = setTimeout(() => setStage('closed'), STAGE_RETURN_MS);
    return () => clearTimeout(t);
  }, [stage]);

  const open = () => {
    if (stage !== 'closed' || !avatar.current) return;
    setOrigin(avatar.current.getBoundingClientRect());
    setStage('open');
  };
  useEffect(() => () => clearTimeout(held.current.timer), []);
  const press = (e: PointerEvent) => {
    if (e.button !== 0) return;
    held.current.opened = false;
    clearTimeout(held.current.timer);
    held.current.timer = window.setTimeout(() => {
      held.current.opened = true;
      open();
    }, STAGE_HOLD_MS);
  };
  const letGo = () => clearTimeout(held.current.timer);
  const tap = () => {
    // The click after a long press opened the 3D stage: nothing more.
    if (held.current.opened) {
      held.current.opened = false;
      return;
    }
    if (onAvatar) return onAvatar();
    // Listening starts inside the tap, where the browser lets the microphone open; the conversation takes the words.
    startListening('talk');
    navigate('/chat', { state: { from: `${location.pathname}${location.search}` } });
  };

  return (
    <>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 z-[4] h-[calc(200px+var(--screen-top))] bg-[linear-gradient(#ffffff_80%,rgba(255,255,255,0))]"
      />
      <div className="pointer-events-none absolute inset-x-0 top-[calc(44px+var(--screen-top))] z-[5] flex flex-col items-center">
        <button
          ref={avatar}
          type="button"
          aria-label={avatarLabel ?? 'Talk with Chapp'}
          aria-description="Hold for Chapp in 3D"
          onClick={tap}
          onPointerDown={press}
          onPointerUp={letGo}
          onPointerLeave={letGo}
          onPointerCancel={letGo}
          onContextMenu={e => e.preventDefault()}
          // Drawn at 85 % from its bottom edge, so the name under it and every screen's layout stay where they were.
          className="pointer-events-auto relative block size-24 origin-bottom scale-[0.85] cursor-pointer touch-manipulation rounded-full outline-none select-none [-webkit-touch-callout:none] focus-visible:ring-2 focus-visible:ring-blue"
          style={{ opacity: stage === 'closed' ? 1 : 0 }}
        >
          <ChappAvatar expression={face} listening={listening} />
        </button>
        {pill && !status ? (
          pill
        ) : (
          <span
            role="status"
            className="pointer-events-auto relative -mt-4 flex flex-col items-center rounded-[14px] bg-white/78 px-3 pt-1 pb-[5px] shadow-[0_0_0_1px_rgba(17,17,19,0.05),0_1px_8px_rgba(17,17,19,0.05)] backdrop-blur-[14px]"
          >
            <b className="text-[15px] leading-5 font-semibold text-ink">Chapp</b>
            {line && (
              <span className="max-w-[220px] truncate text-[13px] leading-[18px] font-medium text-text">{line}</span>
            )}
          </span>
        )}
      </div>
      {back ? (
        <Link to={back.to} aria-label={back.label} className={corner}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d={back.close ? 'M6 6l12 12M18 6 6 18' : 'm15 6-6 6 6 6'} />
          </svg>
        </Link>
      ) : onMenu ? (
        <button type="button" aria-label="Library and history" onClick={onMenu} className={corner}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
      ) : null}
      <ChappStage
        open={stage === 'open'}
        origin={origin}
        onClose={() => setStage(s => (s === 'open' ? 'closing' : s))}
        onMeet={() => navigate('/intro')}
      />
    </>
  );
}

const corner =
  'absolute top-[calc(56px+var(--screen-top))] left-5 z-[6] flex size-11 items-center justify-center rounded-full text-ink outline-none focus-visible:ring-2 focus-visible:ring-blue';
