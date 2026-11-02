import type { CSSProperties } from 'react';
import { cn } from '../../lib/cn.ts';

/**
 * A placeholder for what is still to come (a count, a step's card, a bottle's name), a band of light crossing it.
 * `dark` for one laid over a photo or video. Its size and shape come from `className`; it says nothing to a screen
 * reader (aria-hidden), so whatever it stands in for says it is coming.
 */
export function Shimmer({ className, dark = false, style }: { className?: string; dark?: boolean; style?: CSSProperties }) {
  return (
    <span
      aria-hidden="true"
      className={cn('chapp-anim block', className)}
      style={{
        backgroundImage: dark
          ? 'linear-gradient(100deg, rgba(255,255,255,0.14) 30%, rgba(255,255,255,0.42) 50%, rgba(255,255,255,0.14) 70%)'
          : 'linear-gradient(100deg, #ececea 30%, #f8f8f6 50%, #ececea 70%)',
        backgroundSize: '300% 100%',
        animation: 'chapp-shimmer 1.6s linear infinite',
        ...style,
      }}
    />
  );
}
