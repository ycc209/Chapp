import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { Link } from 'react-router';
import { prefersCalm } from '../../components/chapp/three/poses.ts';
import { ThreeBoundary } from '../../components/chapp/three/ThreeBoundary.tsx';
import './intro.css';

// Three.js arrives in its own chunk while the first card plays: card 0 is the sea alone, so it has five seconds.
const IntroCanvas = lazy(() => import('../../components/chapp/three/IntroCanvas.tsx'));

// Offsets from the design move with the screen's top inset, like every screen's (src/app/PhoneFrame.tsx).
const below = (px: number) => `calc(${px}px + var(--screen-top, 0px))`;
const MIDDLE = 330; // Chapp's middle on the board, px from the top

/** How long each card stays before the next; the last one stays. */
const DURATIONS = [5000, 6200, 6400, 5400];

const STORY = [
  {
    eyebrow: 'Methanocaldococcus jannaschii',
    title: 'Born in extreme conditions.',
    body: 'A heat-loving archaeon from deep-sea hydrothermal vents.',
  },
  {
    eyebrow: 'Hsp16.5',
    title: 'A small protein with a protective role.',
    body: 'Under extreme conditions, it helps prevent other proteins from clumping together.',
  },
  {
    eyebrow: 'PDB 1SHS',
    title: 'Small pieces working together to protect something greater.',
    body: '24 identical subunits form a hollow sphere with windows.',
  },
];

/**
 * The opening, design board Intro: born in extreme conditions, then Meet Chapp. Five cards that move on by themselves
 * or on a tap anywhere; Chapp assembles in 3D behind the words, and the deep sea gives way to the app's light.
 */
export function Intro() {
  const [{ card, at }, setShow] = useState(() => ({ card: 0, at: performance.now() }));
  const [live, setLive] = useState(false);
  const [flat, setFlat] = useState(false);
  const calm = useMemo(prefersCalm, []);
  const go = useCallback((n: number) => setShow({ card: n, at: performance.now() }), []);
  const ready = useCallback(() => setLive(true), []);
  const failed = useCallback(() => setFlat(true), []);
  // The 3D needs Chapp's middle in px: read it off an element placed there, since the inset is a CSS value.
  const probe = useRef<HTMLSpanElement>(null);
  const [middle, setMiddle] = useState(MIDDLE);
  useLayoutEffect(() => setMiddle(probe.current?.offsetTop ?? MIDDLE), []);

  useEffect(() => {
    const ms = DURATIONS[card];
    if (!ms) return;
    const timer = setTimeout(() => go(card + 1), ms - (performance.now() - at));
    return () => clearTimeout(timer);
  }, [card, at, go]);

  const dark = card <= 2;
  const ink = dark ? '#ffffff' : '#111113';
  const keep = (e: MouseEvent) => e.stopPropagation();

  return (
    <div
      onClick={() => card < 4 && go(card + 1)}
      className="absolute inset-0 cursor-pointer overflow-hidden bg-[#020b17] select-none"
    >
      <span ref={probe} aria-hidden="true" className="absolute left-0 size-0" style={{ top: below(MIDDLE) }} />
      <div aria-hidden="true" className="absolute inset-0" style={{ background: GLOW }} />
      <div
        aria-hidden="true"
        className="absolute inset-0 transition-opacity duration-[1.4s] ease-[ease]"
        style={{ background: SEA, opacity: dark ? 1 : 0 }}
      />
      <div
        aria-hidden="true"
        className="absolute inset-0 transition-opacity duration-[1.2s] ease-[ease]"
        style={{ background: HEAT, opacity: card === 1 || card === 2 ? 1 : 0 }}
      />
      <div
        aria-hidden="true"
        className="absolute inset-0 transition-opacity duration-[0.6s] ease-[ease]"
        style={{ opacity: live ? 1 : 0 }}
      >
        <ThreeBoundary onError={failed}>
          <Suspense fallback={null}>
            <IntroCanvas card={card} at={at} calm={calm} middle={middle} onReady={ready} />
          </Suspense>
        </ThreeBoundary>
      </div>
      {flat && card >= 3 && (
        <img
          src="/chapp/chapp.webp"
          alt=""
          className="chapp-anim absolute left-1/2 -ml-[120px] size-[240px]"
          style={{ top: below(MIDDLE - 120), animation: 'intro-pop 0.7s cubic-bezier(0.2, 0.8, 0.2, 1) 0.5s both' }}
        />
      )}
      <Sea dark={dark} vent={card === 0} />

      <div aria-hidden="true" className="pointer-events-none absolute right-5 left-5 z-[3] flex gap-1" style={{ top: below(58) }}>
        {[0, 1, 2, 3, 4].map(i => (
          <span
            key={i}
            className="h-[3px] flex-1 overflow-hidden rounded-[2px]"
            style={{ background: dark ? 'rgba(255, 255, 255, 0.24)' : 'rgba(17, 17, 19, 0.1)' }}
          >
            <span
              key={i === card ? at : 'still'}
              className="block h-[3px] origin-left"
              style={{
                background: ink,
                transform: `scaleX(${i < card || card === 4 ? 1 : 0})`,
                animation: i === card && DURATIONS[i] ? `intro-fill ${DURATIONS[i]}ms linear forwards` : 'none',
              }}
            />
          </span>
        ))}
      </div>
      {card < 4 ? (
        <Link
          to="/"
          onClick={keep}
          className="absolute right-2.5 z-[3] flex h-11 items-center px-3 text-[15px] leading-5 font-semibold no-underline opacity-80"
          style={{ top: below(68), color: ink }}
        >
          Skip
        </Link>
      ) : (
        <button
          type="button"
          onClick={e => {
            e.stopPropagation();
            go(0);
          }}
          className="absolute right-2.5 z-[3] flex h-11 items-center px-3 text-[15px] leading-5 font-semibold text-text"
          style={{ top: below(68) }}
        >
          Replay
        </button>
      )}

      <div aria-live="polite">
        {dark && (
          <div key={card} className={TEXT} style={{ animation: 'intro-in 0.7s ease both' }}>
            <p className={`text-[13px] leading-[18px] font-medium tracking-[0.01em] text-white/66 ${card === 0 ? 'italic' : ''}`}>
              {STORY[card].eyebrow}
            </p>
            <h1 className="text-[30px] leading-9 font-bold tracking-[-0.02em] text-white">{STORY[card].title}</h1>
            <p className="text-[17px] leading-6 text-white/80">{STORY[card].body}</p>
          </div>
        )}
        {card === 3 && (
          <div key={card} className={TEXT} style={{ animation: 'intro-in 0.7s ease 0.7s both' }}>
            <h1 className="text-[34px] leading-10 font-bold tracking-[-0.02em] text-ink">Meet Chapp.</h1>
            <p className="text-[17px] leading-6 font-semibold text-text">
              A little companion, inspired by nature’s way of protecting life.
            </p>
          </div>
        )}
        {card === 4 && (
          <div key={card} className={TEXT} style={{ animation: 'intro-in 0.7s ease both' }}>
            <h1 className="text-[30px] leading-9 font-bold tracking-[-0.02em] text-ink">Now, let’s discover together.</h1>
            <p className="text-[17px] leading-6 text-text">
              Your little companion for every experiment, every question, and every discovery.
            </p>
          </div>
        )}
      </div>
      {card === 4 && (
        <div
          className="chapp-anim absolute right-0 bottom-16 left-0 z-[3] flex justify-center"
          style={{ animation: 'intro-in 0.7s ease 0.5s both' }}
        >
          <Link
            to="/"
            onClick={keep}
            className="flex min-h-12 items-center rounded-3xl bg-ink px-[26px] text-[17px] leading-[22px] font-semibold text-white no-underline"
          >
            Get started
          </Link>
        </div>
      )}
    </div>
  );
}

const TEXT = 'chapp-anim absolute right-7 bottom-[150px] left-7 z-[3] flex flex-col gap-2.5';
const GLOW = `radial-gradient(circle 230px at 50% ${below(MIDDLE)}, rgba(121, 185, 243, 0.3) 0%, rgba(111, 211, 198, 0.1) 55%, rgba(255, 255, 255, 0) 80%), #ffffff`;
const SEA = 'linear-gradient(180deg, #0d3150 0%, #082440 38%, #04152a 72%, #020b17 100%)';
const HEAT = `radial-gradient(circle 200px at 50% ${below(MIDDLE)}, rgba(255, 138, 61, 0.22) 0%, rgba(255, 138, 61, 0) 100%)`;

// The scenery is drawn on the 402 × 874 board: light and snow hang from the top, the vent stands on the bottom.
const SHAFTS = [
  { left: 60, turn: -16, width: 64, alpha: 0.14, run: '9s ease-in-out infinite 0s' },
  { left: 190, turn: -8, width: 90, alpha: 0.1, run: '11s ease-in-out infinite 1.5s' },
  { left: 300, turn: 6, width: 56, alpha: 0.12, run: '10s ease-in-out infinite 3s' },
];
// left, top, size, seconds, delay
const SNOW = [
  [34, 90, 3, 9, 0],
  [78, 210, 2, 11, 2.5],
  [122, 130, 2, 10, 5],
  [160, 300, 3, 12, 1.2],
  [206, 80, 2, 9.5, 3.8],
  [248, 240, 3, 11.5, 0.6],
  [292, 150, 2, 10.5, 4.4],
  [336, 280, 3, 9, 2],
  [372, 110, 2, 12, 6],
  [58, 380, 2, 10, 7],
  [184, 420, 2, 11, 3],
  [318, 400, 3, 9.5, 5.5],
  [110, 520, 2, 12, 1.8],
  [262, 500, 2, 10, 6.6],
];
// left, size, seconds, delay; all rise from 664 px
const SMOKE = [
  [196, 52, 5.5, 0],
  [204, 40, 6, 1.4],
  [190, 60, 6.5, 2.8],
  [200, 46, 5.8, 4.1],
];
// left, size, seconds, delay; all start at 720 px
const BUBBLES = [
  [176, 6, 4.5, 0.4],
  [238, 5, 5, 1.9],
  [214, 7, 4.2, 3.1],
  [160, 4, 5.4, 2.4],
  [252, 6, 4.8, 0.9],
];
const BOARD = 'absolute left-1/2 h-[874px] w-[402px] -translate-x-1/2';

/** The deep sea over the 3D: shafts of light, falling snow and, on the first card, the hydrothermal vent. */
function Sea({ dark, vent }: { dark: boolean; vent: boolean }) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-[2] transition-opacity duration-[1.2s] ease-[ease]"
      style={{ opacity: dark ? 1 : 0 }}
    >
      <div className={`${BOARD} top-0`}>
        {SHAFTS.map(s => (
          <span key={s.left} className="absolute -top-10 origin-top" style={{ left: s.left, transform: `rotate(${s.turn}deg)` }}>
            <span
              className="chapp-anim block h-[560px] origin-top blur-[12px]"
              style={{
                width: s.width,
                background: `linear-gradient(180deg, rgba(150, 210, 255, ${s.alpha}), rgba(150, 210, 255, 0))`,
                animation: `intro-sway ${s.run}`,
              }}
            />
          </span>
        ))}
        {SNOW.map(([left, top, size, s, delay]) => (
          <span
            key={`${left} ${top}`}
            className="chapp-anim absolute rounded-full bg-[rgba(214,232,255,0.75)]"
            style={{ left, top, width: size, height: size, animation: `intro-snow ${s}s linear infinite ${delay}s` }}
          />
        ))}
      </div>
      <div className={`${BOARD} bottom-0 transition-opacity duration-[1.2s] ease-[ease]`} style={{ opacity: vent ? 1 : 0 }}>
        {SMOKE.map(([left, size, s, delay]) => (
          <span
            key={left}
            className="chapp-anim absolute top-[664px] rounded-full blur-[5px]"
            style={{
              left,
              width: size,
              height: size,
              background: 'radial-gradient(closest-side, rgba(214, 226, 238, 0.5), rgba(214, 226, 238, 0))',
              animation: `intro-rise ${s}s ease-out infinite ${delay}s`,
            }}
          />
        ))}
        <span
          className="chapp-anim absolute top-[650px] left-[150px] h-[96px] w-[140px]"
          style={{
            background: 'radial-gradient(closest-side, rgba(255, 150, 70, 0.7), rgba(255, 150, 70, 0))',
            animation: 'intro-glow 2.6s ease-in-out infinite',
          }}
        />
        <svg width="402" height="260" viewBox="0 0 402 260" className="absolute bottom-0 left-0 block">
          <path
            d="M0 260V206c36-8 64 2 92-8 24-8 40-4 56-14l8-62c2-12 12-16 18-6l8 46c6-8 12-10 18-2l8-68c2-12 18-14 22-2l10 74c12-8 26-4 36 6 30 4 58-6 88 4 18 6 28 4 38 8v28z"
            fill="#0a2236"
            stroke="rgba(130, 180, 230, 0.28)"
            strokeWidth="1.5"
          />
          <path d="M0 260v-28c52-10 96 4 140-4 40-8 80 2 122-6 52-10 96 6 140-2v40z" fill="#030d1a" />
        </svg>
        {BUBBLES.map(([left, size, s, delay]) => (
          <span
            key={left}
            className="chapp-anim absolute top-[720px] rounded-full shadow-[inset_0_0_0_1px_rgba(214,236,255,0.55)]"
            style={{ left, width: size, height: size, animation: `intro-bubble ${s}s ease-in infinite ${delay}s` }}
          />
        ))}
      </div>
    </div>
  );
}
