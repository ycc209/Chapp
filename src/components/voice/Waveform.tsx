import { cn } from '../../lib/cn.ts';

/** The still wave's bar heights (Main: "Tap to speak"). */
const STILL = [8, 14, 20, 14, 8];
/** Each moving bar starts at its own point of the 1.1 s breath, so the wave ripples. */
const DELAYS = [0, 0.18, 0.36, 0.12, 0.3];

/**
 * Five blue bars: still when Chapp is ready to listen, moving while it listens. Moving bars are `height` tall (20 on
 * the bar, 22 in gloves mode) and stand still at full height when the user asks for reduced motion. The keyframes,
 * chapp-wave, are the app's (src/app/motion.css).
 */
export function Waveform({ moving, height = 20, className }: { moving: boolean; height?: number; className?: string }) {
  return (
    <span aria-hidden="true" className={cn('flex items-center gap-1', className)} style={{ height }}>
      {STILL.map((still, i) => (
        <span
          key={i}
          className={cn('w-1 rounded-[2px] bg-blue', moving && 'chapp-anim')}
          style={moving ? { height, animation: `chapp-wave 1.1s ease-in-out infinite ${DELAYS[i]}s` } : { height: still }}
        />
      ))}
    </span>
  );
}
