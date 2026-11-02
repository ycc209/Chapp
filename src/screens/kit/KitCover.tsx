import { cn } from '../../lib/cn.ts';
import { useCovers } from '../../state/library.ts';
import { coverFocus } from './cover.ts';

/**
 * The kit's cover (cover.ts), filling a square the caller sizes and rounds, centred on its packaging; nothing when the
 * user never photographed the kit's box or bag.
 */
export function KitCover({ protocolId, className }: { protocolId: string | null | undefined; className?: string }) {
  const cover = useCovers(s => (protocolId ? s.covers[protocolId] : undefined));
  if (!cover) return null;
  return <img src={cover.src} alt="" draggable={false} className={cn('block shrink-0 bg-[#1b1b1d] object-cover', className)} style={{ objectPosition: coverFocus(cover.box) }} />;
}

/** Whether the kit has a cover, for layouts that make room for it. */
export const useHasCover = (protocolId: string | null | undefined) => useCovers(s => Boolean(protocolId && s.covers[protocolId]));
