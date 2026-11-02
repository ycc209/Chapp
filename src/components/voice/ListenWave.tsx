import { useState, type CSSProperties } from 'react';

/** How big the glow is: gone, low behind the bar (listening), or up to the middle of the screen (Home, held). */
export type GlowSize = 'off' | 'small' | 'big';

/**
 * Behind the bar while Chapp listens: a soft blue glow rising from the bottom of the screen, and sinking again when it
 * stops. It is a few blurred pools of light, each drifting and swelling at its own pace, so its top edge moves like a
 * slow wave with no line anywhere; the top fades out. `small`, it reaches just above the speak button; `big`, the middle
 * of the screen, where Home shows the words heard inside it. From big back to small (let go, sent), it springs down
 * past small, back up, and settles in a ripple. Slid up to cancel, the light turns to the notes' caution colour. Still
 * for people who ask for reduced motion.
 */
export function ListenWave({ size, caution }: { size: GlowSize; caution?: boolean }) {
  // Settling from big to small is known in the same render as the change, so no transition starts first (one would
  // outrank the keyframes).
  const [was, setWas] = useState(size);
  const [settling, setSettling] = useState(false);
  if (was !== size) {
    setWas(size);
    setSettling(was === 'big' && size === 'small');
  }

  return (
    <div
      aria-hidden="true"
      className="chapp-anim pointer-events-none absolute inset-x-0 bottom-0 h-[calc(600px+var(--screen-bottom,34px))] origin-bottom overflow-hidden"
      onAnimationEnd={e => e.target === e.currentTarget && setSettling(false)}
      style={{
        maskImage: FADE,
        WebkitMaskImage: FADE,
        transform: SCALE[size],
        opacity: size === 'off' ? 0 : 1,
        transition:
          settling ? 'opacity 0.5s ease-out'
          : size === 'big' ? 'transform 0.7s cubic-bezier(.22,1,.36,1)'
          : size === 'small' ? 'transform 0.8s cubic-bezier(.22,1,.36,1), opacity 0.5s ease-out'
          : 'transform 0.5s ease-in, opacity 0.4s ease-in',
        animation: settling ? 'chapp-glow-settle 1.1s ease-in-out both' : undefined,
      }}
    >
      {POOLS.map((p, i) => (
        <span
          key={i}
          className="chapp-anim absolute rounded-full"
          style={
            {
              left: `${p.left}%`,
              width: `${p.width}%`,
              height: p.height,
              bottom: -p.height * 0.42,
              background: `radial-gradient(closest-side, ${caution ? p.caution : p.blue}, transparent)`,
              filter: 'blur(24px)',
              transition: 'background 0.25s',
              animation: `chapp-glow ${p.seconds}s ease-in-out infinite alternate ${-p.seconds * i * 0.37}s`,
              '--dx': p.dx,
              '--rise': `${p.rise}px`,
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
}

/** The glow is drawn big and squashed down to its bottom edge when small (src/app/motion.css chapp-glow-settle ends on small's). */
const SCALE: Record<GlowSize, string> = {
  off: 'translateY(25%) scale(1, 0.3)',
  small: 'scale(1, 0.4)',
  big: 'scale(1, 1)',
};

/** The glow's top dissolves into the page. */
const FADE = 'linear-gradient(to top, #000 55%, transparent 100%)';

type Pool = { left: number; width: number; height: number; dx: string; rise: number; seconds: number; blue: string; caution: string };

// Wide, slow pools at the back; a brighter, quicker one low in the middle. Blue, with a little periwinkle and teal
// (Chapp's colours). Left and width in % of the screen's width, height in px.
const POOLS: Pool[] = [
  { left: -44, width: 128, height: 990, dx: '22%', rise: 36, seconds: 7.5, blue: 'rgba(96,160,245,0.62)', caution: 'rgba(255,196,120,0.62)' },
  { left: -7.5, width: 120, height: 900, dx: '-16%', rise: 52, seconds: 9.5, blue: 'rgba(140,146,250,0.46)', caution: 'rgba(255,214,153,0.5)' },
  { left: 18, width: 128, height: 1020, dx: '-24%', rise: 32, seconds: 8.5, blue: 'rgba(104,196,232,0.5)', caution: 'rgba(255,186,110,0.5)' },
  { left: -1, width: 102, height: 600, dx: '12%', rise: 24, seconds: 5.5, blue: 'rgba(66,134,240,0.5)', caution: 'rgba(248,170,80,0.5)' },
];
