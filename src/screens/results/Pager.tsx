import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react';

export type PagerPage = { label: string; content: ReactNode };

type PagerProps = {
  pages: PagerPage[];
  /** The page in view; changing it scrolls there. */
  page: number;
  /** A swipe (or a mouse drag) settled on another page. */
  onPage: (page: number) => void;
};

// Results-Swipe.dc.html's pager: each page is the width less 36 px (346 of 382 on the design's 402 px screen), 12 px
// apart, so the next one peeks in at the right edge and fades out under the mask. Each page also stops a swipe
// (scroll-snap-stop), so a quick flick turns one page, never two.
const GAP = 12;
const MASK =
  'linear-gradient(to right, transparent 0, transparent 8px, #000000 20px, #000000 calc(100% - 36px), rgba(0, 0, 0, 0.3) 100%)';

const reduced = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * The results pages side by side, swiped like the design's: fingers and trackpads scroll natively and snap to a page;
 * a mouse drags them and lets go onto the nearest one (a short flick turns the page). The pager is as tall as the page
 * it shows, so the screen scrolls only as far as that page goes.
 */
export function Pager({ pages, page, onPage }: PagerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [heights, setHeights] = useState<number[] | null>(null);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; left: number; id: number; moved: boolean } | null>(null);
  // While the pager glides to a page a tab asked for, the pages it passes are not "the page in view".
  const jump = useRef<{ to: number; timer: number } | null>(null);
  const current = useRef(page);
  current.current = page;
  const last = pages.length - 1;

  const sections = () => [...(ref.current?.querySelectorAll<HTMLElement>(':scope > section') ?? [])];
  /** One page plus the gap, as laid out (358 px on the design's screen). */
  const step = () => {
    const s = sections();
    return s.length > 1 ? s[1]!.offsetLeft - s[0]!.offsetLeft : 358;
  };
  const clamp = (p: number) => Math.max(0, Math.min(last, p));

  const glide = (to: number) => {
    const el = ref.current;
    if (!el) return;
    if (jump.current) clearTimeout(jump.current.timer);
    jump.current = { to, timer: window.setTimeout(() => (jump.current = null), 900) };
    el.scrollTo({ left: to * step(), behavior: reduced() ? 'auto' : 'smooth' });
  };

  // Opens on the page asked for, without a glide.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) el.scrollLeft = page * step();
  }, []);

  // Each page's height, kept up to date as its content changes (another amount, a reply…).
  useLayoutEffect(() => {
    const all = sections();
    const measure = () =>
      setHeights(prev => {
        const hs = all.map(s => s.offsetHeight);
        return prev && prev.join() === hs.join() ? prev : hs;
      });
    measure();
    const ro = new ResizeObserver(measure);
    all.forEach(s => ro.observe(s));
    return () => ro.disconnect();
  }, [pages.length]);

  // A tab or something said picked a page: glide there.
  useEffect(() => {
    const el = ref.current;
    if (!el || drag.current?.moved) return;
    if (Math.round(el.scrollLeft / step()) !== page || jump.current) glide(page);
  }, [page]);

  useEffect(() => () => clearTimeout(jump.current?.timer), []);

  const onScroll = () => {
    const el = ref.current;
    if (!el || drag.current?.moved) return;
    const w = step();
    const p = clamp(Math.round(el.scrollLeft / w));
    if (jump.current) {
      if (p === jump.current.to && Math.abs(el.scrollLeft - p * w) < 2) {
        clearTimeout(jump.current.timer);
        jump.current = null;
      }
      return;
    }
    if (p !== current.current) onPage(p);
  };

  // A mouse press becomes a drag only once it moves: a plain click still reaches the chips inside a page.
  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse' || e.button !== 0 || !ref.current) return;
    drag.current = { x: e.clientX, left: ref.current.scrollLeft, id: e.pointerId, moved: false };
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || !ref.current) return;
    if (!d.moved) {
      if (Math.abs(e.clientX - d.x) < 6) return;
      d.moved = true;
      e.currentTarget.setPointerCapture?.(d.id);
      setDragging(true);
    }
    ref.current.scrollLeft = d.left - (e.clientX - d.x);
  };
  const up = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d?.moved) return;
    const dx = e.clientX - d.x;
    let p = Math.round(d.left / step());
    if (dx < -40) p += 1;
    else if (dx > 40) p -= 1;
    p = clamp(p);
    glide(p);
    if (p !== current.current) onPage(p);
    setTimeout(() => setDragging(false), 450);
  };

  const style: CSSProperties = {
    height: heights?.[page] ?? 'auto',
    scrollSnapType: dragging ? 'none' : 'x mandatory',
    cursor: dragging ? 'grabbing' : 'grab',
    WebkitMaskImage: MASK,
    maskImage: MASK,
  };

  return (
    <div
      ref={ref}
      data-pager=""
      onScroll={onScroll}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      className="-mx-5 flex items-start overflow-x-auto overflow-y-hidden overscroll-x-contain scroll-pl-5 pl-5 transition-[height] duration-300 ease-[ease] select-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      style={{ ...style, gap: GAP }}
    >
      {pages.map((p, i) => (
        <section
          key={i}
          aria-label={p.label}
          aria-hidden={i === page ? undefined : true}
          inert={i === page ? undefined : true}
          className="flex shrink-0 grow-0 basis-[calc(100%-36px)] snap-start snap-always flex-col"
        >
          {p.content}
        </section>
      ))}
      <span aria-hidden="true" className="h-px shrink-0 grow-0 basis-6" />
    </div>
  );
}
