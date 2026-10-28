import { useEffect, useState } from 'react';

/** The part of the page the user can see right now: shorter than the screen while the on-screen keyboard is up. */
export type VisibleArea = { height: number; top: number; keyboard: boolean };

// The keyboard is up when the visible area is this much shorter than the tallest it has been in this orientation;
// smaller changes are the browser's toolbars sliding in and out.
const KEYBOARD_PX = 120;

/**
 * Follows the visual viewport so the app can sit in the space the keyboard leaves. iOS Safari never resizes the page
 * for the keyboard: it shrinks the visual viewport and scrolls the page underneath, which would leave the message box
 * behind the keys. Android does the same unless the page asks otherwise (index.html asks it to resize the page).
 */
export function useVisibleArea(enabled: boolean): VisibleArea | null {
  const [area, setArea] = useState<VisibleArea | null>(null);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!enabled || !vv) return;
    let tallest = 0;
    const update = () => {
      tallest = Math.max(tallest, vv.height);
      const next = { height: Math.round(vv.height), top: Math.round(vv.offsetTop), keyboard: vv.height < tallest - KEYBOARD_PX };
      setArea(prev => (prev && prev.height === next.height && prev.top === next.top && prev.keyboard === next.keyboard ? prev : next));
      // Safari can leave the page scrolled once the keyboard has gone.
      if (!next.keyboard && window.scrollY) window.scrollTo(0, 0);
    };
    // Turning the phone changes the full height: measure it again.
    const portrait = window.matchMedia('(orientation: portrait)');
    const turned = () => {
      tallest = 0;
      requestAnimationFrame(update);
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    portrait.addEventListener('change', turned);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      portrait.removeEventListener('change', turned);
    };
  }, [enabled]);

  return enabled ? area : null;
}
