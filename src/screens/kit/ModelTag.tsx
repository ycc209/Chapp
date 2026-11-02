import type { ReactNode } from 'react';
import { cn } from '../../lib/cn.ts';

/**
 * Which model does a piece of the work ("SAM 3.1", "Muse Spark"): a small tag beside it. `dark` over the video, where
 * each model has a tint of its own: SAM the blue of its progress on the bar under the video, Muse Spark violet.
 */
export function ModelTag({ dark = false, children }: { dark?: boolean; children: ReactNode }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded-[6px] px-1.5 py-px text-[11px] leading-4 font-semibold whitespace-nowrap',
        !dark ? 'bg-sunken text-text'
        : children === 'SAM 3.1' ? 'bg-[#4f8df7]/25 text-[#bcd4ff]'
        : children === 'Muse Spark' ? 'bg-[#a78bfa]/25 text-[#ddd2ff]'
        : 'bg-white/14 text-white/85',
      )}
    >
      {children}
    </span>
  );
}
