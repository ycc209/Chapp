import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import type { Box, Point } from '../../../shared/ai.ts';
import { boxAt } from '../../../shared/kit.ts';
import { cn } from '../../lib/cn.ts';
import { CloseIcon } from '../protocol/icons.tsx';
import { squareAround, type Shot } from './photo.ts';

type PickerProps = {
  shots: Shot[];
  /** The photo it opens on. */
  start: number;
  /** The bottle Chapp asked for. */
  name: string;
  /** The bottles SAM found on a photo (by shot id): a tap on one picks that bottle. */
  bottles?: (shot: string) => Box[];
  /** The tap, and the bottle SAM found under it, if any. */
  onPick: (shot: number, at: Point, bottle: Box | null) => void;
  onClose: () => void;
};

/** How long the square stays on the big photo before the confirm question: enough to see what was picked. */
const SHOW_MS = 450;

/**
 * Showing Chapp a bottle by hand: the photo large, in the camera's dark frame (Camera.dc.html), "Tap the BCA Reagent
 * A". A tap on a bottle SAM found picks that bottle's box; elsewhere, a square around the tap. Either is drawn in
 * yellow (still a question), then hands back to the list, which asks "Is this the BCA Reagent A?" (Kit.dc.html).
 * Thumbnails switch photos.
 */
export function Picker({ shots, start, name, bottles, onPick, onClose }: PickerProps) {
  const [index, setIndex] = useState(Math.min(start, shots.length - 1));
  const [box, setBox] = useState<Box | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState({ width: 0, height: 0 });
  const shot = shots[index];

  // The photo, contained in the frame at its own proportions, so a tap maps straight onto it.
  useLayoutEffect(() => {
    const el = frame.current;
    if (!el || !shot) return;
    const measure = () => {
      const scale = Math.min(el.clientWidth / shot.width, el.clientHeight / shot.height);
      setFit({ width: shot.width * scale, height: shot.height * scale });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [shot]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);

  const tap = (e: PointerEvent<HTMLDivElement>) => {
    if (box || !shot) return;
    const r = e.currentTarget.getBoundingClientRect();
    const at = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
    if (at.x < 0 || at.x > 1 || at.y < 0 || at.y > 1) return;
    const bottle = boxAt(bottles?.(shot.id) ?? [], at);
    setBox(bottle ?? squareAround(at, shot.width, shot.height));
    window.setTimeout(() => onPick(index, at, bottle), SHOW_MS);
  };

  if (!shot) return null;
  return (
    <div
      role="dialog"
      aria-label={`Show Chapp the ${name}`}
      className="absolute inset-0 z-20 flex flex-col gap-[18px] bg-[#0b0b0c] px-5 pt-[calc(56px+var(--screen-top))] pb-[calc(6px+var(--screen-bottom))] text-white animate-in fade-in duration-200"
    >
      <div className="flex min-h-11 items-center justify-between gap-3">
        <p className="pl-1 text-[17px] leading-[22px] font-medium">
          Tap the <b className="font-bold">{name}</b>
        </p>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="flex size-11 shrink-0 items-center justify-center rounded-full bg-white/12 text-white outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          <CloseIcon />
        </button>
      </div>

      <div ref={frame} className="relative flex min-h-0 grow items-center justify-center overflow-hidden rounded-[24px] bg-[#1b1b1d]">
        <div
          onPointerUp={tap}
          className="relative cursor-crosshair touch-manipulation overflow-hidden rounded-[12px]"
          style={{ width: fit.width, height: fit.height }}
        >
          <img src={shot.src} alt={`Photo ${index + 1}`} draggable={false} className="block size-full select-none" />
          {box && (
            <span
              aria-hidden="true"
              className="absolute rounded-[8px] border-2 border-mark bg-[rgba(255,232,99,0.18)] animate-in zoom-in-90 fade-in duration-150"
              style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.width * 100}%`, height: `${box.height * 100}%` }}
            />
          )}
        </div>
      </div>

      <div className="flex min-h-[76px] items-center justify-center gap-2.5">
        {shots.length > 1 &&
          shots.map((s, i) => (
            <button
              key={s.id}
              type="button"
              aria-label={`Photo ${i + 1}`}
              aria-current={i === index ? 'true' : undefined}
              onClick={() => {
                setIndex(i);
                setBox(null);
              }}
              className={cn(
                'relative size-11 overflow-hidden rounded-[10px] outline-none focus-visible:ring-2 focus-visible:ring-blue',
                i === index ? 'shadow-[0_0_0_2px_#ffffff]' : 'opacity-60 shadow-[0_0_0_1.5px_rgba(255,255,255,0.35)]',
              )}
            >
              <img src={s.src} alt="" className="size-full object-cover" />
              <span className="absolute top-0.5 left-1 text-[11px] leading-[14px] font-bold text-white [text-shadow:0_0_3px_rgba(0,0,0,0.9),0_1px_2px_rgba(0,0,0,0.6)]">
                {i + 1}
              </span>
            </button>
          ))}
      </div>
    </div>
  );
}
