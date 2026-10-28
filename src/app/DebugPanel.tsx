import { useEffect, useState } from 'react';

const KEY = 'chapp.debug';

/**
 * Turned on by opening any page with ?debug=1 (kept for later pages), off with ?debug=0. The app added to the Home
 * Screen has no address bar: there, five quick taps on Chapp's name (the pill under the avatar) switch it.
 */
export function useDebugFlag() {
  useEffect(() => {
    let taps: number[] = [];
    const tap = (e: MouseEvent) => {
      if (!(e.target as Element | null)?.closest?.('[role="status"]')) return;
      const now = Date.now();
      taps = [...taps.filter(t => now - t < 3000), now];
      if (taps.length < 5) return;
      try {
        if (localStorage.getItem(KEY) === '1') localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, '1');
      } catch {
        return;
      }
      // Reload without ?debug=…, which would set it back.
      location.replace(location.pathname + location.hash);
    };
    window.addEventListener('click', tap, true);
    return () => window.removeEventListener('click', tap, true);
  }, []);
  const [on] = useState(() => {
    const asked = new URLSearchParams(window.location.search).get('debug');
    try {
      if (asked === '1') localStorage.setItem(KEY, '1');
      if (asked === '0') localStorage.removeItem(KEY);
      return localStorage.getItem(KEY) === '1';
    } catch {
      return asked === '1';
    }
  });
  return on;
}

type Readout = Record<string, string | number>;

const name = (el: Element | null) =>
  el ? `${el.tagName.toLowerCase()}${el.getAttribute('aria-label') ? `[${el.getAttribute('aria-label')}]` : ''}.${String(el.className).slice(0, 40)}` : 'none';

/** The nearest element above `el` that scrolls vertically, as the browser sees it. */
function scrollerOf(el: Element | null): HTMLElement | null {
  for (let e = el as HTMLElement | null; e; e = e.parentElement) {
    const y = getComputedStyle(e).overflowY;
    if ((y === 'auto' || y === 'scroll') && e.scrollHeight > e.clientHeight) return e;
  }
  return null;
}

/**
 * What the phone itself reports while the user swipes: where the finger landed, what scrolls there, whether anything
 * cancelled the move, and the page's and viewport's sizes. For finding scrolling bugs that only happen on a real iPhone.
 */
export function DebugPanel() {
  const [r, setR] = useState<Readout>({});
  useEffect(() => {
    let target: Element | null = null;
    let startTop = 0;
    let moves = 0;
    let cancelled = 0;
    const sizes = (): Readout => {
      const vv = window.visualViewport;
      const sc = scrollerOf(target);
      return {
        path: location.pathname,
        inner: `${innerWidth}×${innerHeight}`,
        vv: vv ? `${Math.round(vv.width)}×${Math.round(vv.height)} top ${Math.round(vv.offsetTop)} ×${vv.scale.toFixed(2)}` : 'none',
        page: `scrollY ${Math.round(scrollY)} / doc ${document.documentElement.scrollHeight}`,
        scroller: sc ? `${Math.round(sc.scrollTop)} of ${sc.scrollHeight - sc.clientHeight} (${name(sc)})` : 'none under finger',
        bodyStyle: document.body.getAttribute('style') ?? '',
        root: (document.querySelector('#root > div') as HTMLElement | null)?.getAttribute('style') ?? '',
      };
    };
    // Each box from the finger up to the page: its height, its content's height and how it overflows. A box whose
    // content is taller than it, set to auto, is what should scroll.
    const chain = (el: Element | null) => {
      const lines: string[] = [];
      for (let e = el as HTMLElement | null, i = 0; e && e !== document.documentElement && i < 14; e = e.parentElement, i++) {
        const cs = getComputedStyle(e);
        if (e.clientHeight === e.scrollHeight && cs.overflowY === 'visible' && i > 0 && i < 12) continue;
        lines.push(`${e.tagName.toLowerCase()} h${e.clientHeight} content${e.scrollHeight} ${cs.overflowY}${e.style.overflowY ? ` inline:${e.style.overflowY}` : ''} ${cs.position !== 'static' ? cs.position : ''} ${String(e.className).slice(0, 28)}`);
      }
      return lines.join('\n  ');
    };
    const start = (e: TouchEvent) => {
      target = e.target as Element;
      startTop = scrollerOf(target)?.scrollTop ?? 0;
      moves = 0;
      cancelled = 0;
      setR({ ...sizes(), touch: name(target), at: `${Math.round(e.touches[0]!.clientX)},${Math.round(e.touches[0]!.clientY)}`, moved: '…', boxes: `\n  ${chain(target)}` });
    };
    const move = (e: TouchEvent) => {
      moves++;
      // Read after every listener has run: was the browser's scroll cancelled by someone?
      setTimeout(() => e.defaultPrevented && cancelled++, 0);
    };
    const end = () =>
      setTimeout(() => {
        const sc = scrollerOf(target);
        setR(prev => ({ ...prev, ...sizes(), moved: `${moves} moves, ${cancelled} cancelled, scroller ${Math.round((sc?.scrollTop ?? 0) - startTop)} px` }));
      }, 400);
    window.addEventListener('touchstart', start, { capture: true, passive: true });
    window.addEventListener('touchmove', move, { capture: true, passive: true });
    window.addEventListener('touchend', end, { capture: true, passive: true });
    setR(sizes());
    return () => {
      window.removeEventListener('touchstart', start, { capture: true });
      window.removeEventListener('touchmove', move, { capture: true });
      window.removeEventListener('touchend', end, { capture: true });
    };
  }, []);
  return (
    <pre className="pointer-events-none fixed top-0 right-0 left-0 z-[1000] m-0 bg-black/75 p-1.5 text-[9px] leading-[11px] whitespace-pre-wrap text-[#7CFC00]">
      {Object.entries(r)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n')}
    </pre>
  );
}
