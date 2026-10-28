import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSession } from '../../state/session.ts';
import { bodyShare, poseFor, prefersCalm, type Pose } from './three/poses.ts';
import type { StageApi } from './three/StageCanvas.tsx';
import { ThreeBoundary } from './three/ThreeBoundary.tsx';

// Three.js and the model load only when the stage opens: the home screen ships no WebGL (BUILD_PLAN 3.4).
const StageCanvas = lazy(() => import('./three/StageCanvas.tsx'));

/** Starts fetching the 3D code and the model early, say on pointerdown on the avatar, so the stage is ready sooner. */
export function preloadChapp3D() {
  void import('./three/StageCanvas.tsx');
}

export type ChappStageProps = {
  open: boolean;
  /** Where the avatar is on screen when the stage opens (viewport coordinates); the still flies from here and back. */
  origin: DOMRect | null;
  onClose: () => void;
  /** The "Meet Chapp" button: plays the intro. */
  onMeet: () => void;
};

/**
 * 0 closed · 1 the picture at the avatar · 2 flying to the middle · 3 Chapp in 3D · 4 the picture again · 5 flying home.
 * As on the design board Main (stage3d).
 */
type Phase = 0 | 1 | 2 | 3 | 4 | 5;

const STILL = 280; // the picture's box in the middle, px
const STAGE_TOP = 206; // the 3D canvas: full width, 402 px tall, from here (plus --screen-top)
const STAGE_H = 402;
const FLY = 'transform 0.56s cubic-bezier(0.2, 0.8, 0.2, 1), opacity 0.25s ease';
/** How long closing takes, from Close to the picture back on the avatar: 200 ms to fade, then the flight. */
export const STAGE_RETURN_MS = 780;

// Offsets from the design move with the screen's top inset, like the header's (src/app/PhoneFrame.tsx).
const below = (px: number) => `calc(${px}px + var(--screen-top, 0px))`;

/**
 * Chapp in 3D, opened by tapping the avatar (design board Main). Its picture flies from the avatar to the middle of
 * the screen and becomes a Chapp you can turn with a finger.
 *
 * Draw it inside the phone screen; it covers it (absolute, inset 0). Close, a tap beside Chapp, Escape and Meet Chapp
 * call onClose at once; the stage then flies the picture home by itself, which takes STAGE_RETURN_MS, so keep the
 * avatar hidden that long. Setting `open` to false from outside closes it the same way.
 */
export function ChappStage({ open, origin, onClose, onMeet }: ChappStageProps) {
  const [phase, setPhase] = useState<Phase>(0);
  const [pose, setPose] = useState<Pose>(() => poseFor('neutral'));
  const [path, setPath] = useState<{ home: string; mid: string } | null>(null);
  const [stage, setStage] = useState<StageApi | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const canvasBox = useRef<HTMLDivElement>(null);
  const openedAt = useRef(0);
  const timers = useRef<number[]>([]);
  // Closed by our own buttons: stay closed until the parent has seen it (open → false), even if it never does.
  const dismissed = useRef(false);
  const calm = useMemo(prefersCalm, []);

  const reset = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setPhase(0);
    setPath(null);
    setStage(null);
  }, []);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  // 4: the picture again, in the middle; 5: it flies home; 0: gone.
  const leave = useCallback(() => {
    setPhase(4);
    timers.current.push(
      window.setTimeout(() => setPhase(5), 200),
      window.setTimeout(reset, STAGE_RETURN_MS),
    );
  }, [reset]);

  useEffect(() => {
    if (!open) dismissed.current = false;
    if (open && phase === 0 && !dismissed.current) {
      // With the face Chapp has now, so the picture that flies is the one the avatar shows.
      setPose(poseFor(useSession.getState().expression));
      openedAt.current = performance.now();
      setPhase(1);
    } else if (!open && phase === 1) reset();
    else if (!open && (phase === 2 || phase === 3)) leave();
  }, [open, phase, leave, reset]);

  // 1: place the picture on the avatar in this container's own pixels (the phone may be drawn scaled), let it be
  // drawn there for two frames, then let it fly.
  useLayoutEffect(() => {
    if (phase !== 1 || !root.current) return;
    const el = root.current;
    const box = el.getBoundingClientRect();
    const width = el.offsetWidth || 402;
    const zoom = box.width / width || 1;
    const top = canvasBox.current?.offsetTop ?? STAGE_TOP;
    const home = origin
      ? `translate(${(origin.left - box.left) / zoom}px, ${(origin.top - box.top) / zoom}px) scale(${origin.width / zoom / STILL})`
      : `translate(${(width - 96) / 2}px, ${top - STAGE_TOP + 44}px) scale(${96 / STILL})`;
    // The picture sits where the 3D body will be: centred in the canvas.
    setPath({ home, mid: `translate(${(width - STILL) / 2}px, ${top + (STAGE_H - STILL) / 2}px) scale(1)` });
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setPhase(p => (p === 1 ? 2 : p)));
    });
    return () => cancelAnimationFrame(frame);
  }, [phase, origin]);

  // 2 → 3: once the model is drawn, and not before the flight has mostly landed (600 ms after opening).
  useEffect(() => {
    if (phase !== 2 || !stage) return;
    const timer = setTimeout(
      () => {
        setPhase(3);
        stage.arrive();
      },
      Math.max(0, 600 - (performance.now() - openedAt.current)),
    );
    return () => clearTimeout(timer);
  }, [phase, stage]);

  const close = useCallback(() => {
    if (phase !== 2 && phase !== 3) return;
    dismissed.current = true;
    leave();
    onClose();
  }, [phase, leave, onClose]);

  const meet = () => {
    close();
    onMeet();
  };

  useEffect(() => {
    if (phase !== 2 && phase !== 3) return;
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [phase, close]);

  if (phase === 0) return null;
  const mid = phase >= 2 && phase <= 4;
  const veil = mid ? 1 : 0;
  // Calm: no flight; the picture fades in and out in the middle.
  const still = calm ? (mid && phase !== 3 ? 1 : 0) : phase === 3 ? 0 : 1;
  const fit = (STILL / STAGE_H) * bodyShare(pose);
  const shown = (on: number) => ({ opacity: on, pointerEvents: on ? ('auto' as const) : ('none' as const) });

  return (
    <div ref={root} role="dialog" aria-modal="true" aria-label="Chapp" className="absolute inset-0 z-[8]">
      <div
        onClick={close}
        className="absolute inset-0 backdrop-blur-[20px] transition-opacity duration-[0.45s] ease-[ease]"
        style={{ background: VEIL, opacity: veil }}
      />
      <div
        ref={canvasBox}
        className="absolute right-0 left-0 transition-opacity duration-[0.25s] ease-[ease]"
        style={{ top: below(STAGE_TOP), height: STAGE_H, ...shown(phase === 3 ? 1 : 0) }}
      >
        <ThreeBoundary>
          <Suspense fallback={null}>
            <StageCanvas pose={pose} fit={fit} onReady={setStage} />
          </Suspense>
        </ThreeBoundary>
      </div>
      {path && (
        <img
          src={pose.still}
          alt=""
          draggable={false}
          className="pointer-events-none absolute top-0 left-0 max-w-none origin-top-left"
          style={{
            width: STILL,
            height: STILL,
            transform: calm || mid ? path.mid : path.home,
            opacity: still,
            transition: FLY,
          }}
        />
      )}
      <button
        type="button"
        onClick={close}
        aria-label="Close"
        className="absolute right-5 flex size-11 items-center justify-center rounded-full bg-white/86 text-ink shadow-[0_0_0_1px_rgba(17,17,19,0.06)] backdrop-blur-[12px] transition-opacity duration-300 ease-[ease]"
        style={{ top: below(56), ...shown(veil) }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      </button>
      <div
        className="absolute right-0 left-0 flex justify-center transition-opacity duration-300 ease-[ease]"
        style={{ top: below(650), ...shown(veil) }}
      >
        <button
          type="button"
          onClick={meet}
          className="flex min-h-10 items-center rounded-[20px] bg-white px-[18px] text-[15px] leading-5 font-semibold text-ink shadow-[0_1px_2px_rgba(17,17,19,0.06),0_2px_8px_rgba(17,17,19,0.04)]"
        >
          Meet Chapp
        </button>
      </div>
    </div>
  );
}

const VEIL = `radial-gradient(circle 240px at 50% ${below(407)}, rgba(121, 185, 243, 0.32) 0%, rgba(111, 211, 198, 0.12) 55%, rgba(255, 255, 255, 0) 80%), rgba(255, 255, 255, 0.86)`;
