import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import type { Expression } from '../../../shared/ai.ts';
import { useSession } from '../../state/session.ts';
import { ChappAvatar } from './ChappAvatar.tsx';
import { ChappStage } from './ChappStage.tsx';

export type ChappHeaderProps = {
  /** The line under the name when Chapp has nothing else to say: the screen's subject ("Pierce BCA · Plan"). */
  subtitle?: string;
  /** Top left, the menu: opens the sidebar (library and history). */
  onMenu?: () => void;
  /** Top left, back to a screen, instead of the menu. */
  back?: { to: string; label: string };
  /**
   * Drawn under the avatar instead of the name pill, e.g. the run screens' lab StepPill ("Chapp / Step 1 of 6 ·
   * Standards"; give it -mt-4). Chapp's status, when it has one ("Thinking", a microphone problem), still shows in
   * the name pill until it clears.
   */
  pill?: ReactNode;
};

// How long the stage takes to fly Chapp home after it closes (the design's stage3dClose: 200 ms + 580 ms); the
// avatar stays hidden until then so there are never two Chapps on screen.
const STAGE_RETURN_MS = 780;

/**
 * Chapp at the top of every screen (Main.dc.html, Listening.dc.html): the white fade the page scrolls under, the
 * breathing avatar with its name and what it is doing, and the button at the top left. Tapping Chapp opens it in 3D.
 */
export function ChappHeader({ subtitle, onMenu, back, pill }: ChappHeaderProps) {
  const navigate = useNavigate();
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
          aria-label="Chapp, in 3D"
          onClick={open}
          className="pointer-events-auto relative block size-24 cursor-pointer rounded-full outline-none focus-visible:ring-2 focus-visible:ring-blue"
          style={{ opacity: stage === 'closed' ? 1 : 0 }}
        >
          <ChappAvatar expression={face} listening={listening} />
        </button>
        {pill && !status ? (
          pill
        ) : (
          <span
            role="status"
            className="relative -mt-4 flex flex-col items-center rounded-[14px] bg-white/78 px-3 pt-1 pb-[5px] shadow-[0_0_0_1px_rgba(17,17,19,0.05),0_1px_8px_rgba(17,17,19,0.05)] backdrop-blur-[14px]"
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
            <path d="m15 6-6 6 6 6" />
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
