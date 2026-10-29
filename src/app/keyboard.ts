import { useEffect, useState, type RefObject } from 'react';

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
    let keyboardWasUp = false;
    const update = () => {
      tallest = Math.max(tallest, vv.height);
      const next = { height: Math.round(vv.height), top: Math.round(vv.offsetTop), keyboard: vv.height < tallest - KEYBOARD_PX };
      setArea(prev => (prev && prev.height === next.height && prev.top === next.top && prev.keyboard === next.keyboard ? prev : next));
      // Safari can leave the page scrolled once the keyboard has gone: put it back once, as the keyboard closes. Doing it
      // on every scroll fought the user's own swipes whenever Safari let the page itself scroll (after the camera).
      if (keyboardWasUp && !next.keyboard && window.scrollY) window.scrollTo(0, 0);
      keyboardWasUp = next.keyboard;
    };
    // Turning the phone, or coming back from the camera or another app, can change the full height: measure it again.
    const portrait = window.matchMedia('(orientation: portrait)');
    const remeasure = () => {
      tallest = 0;
      requestAnimationFrame(update);
    };
    const shown = () => document.visibilityState === 'visible' && remeasure();
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    portrait.addEventListener('change', remeasure);
    document.addEventListener('visibilitychange', shown);
    window.addEventListener('pageshow', remeasure);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      portrait.removeEventListener('change', remeasure);
      document.removeEventListener('visibilitychange', shown);
      window.removeEventListener('pageshow', remeasure);
    };
  }, [enabled]);

  return enabled ? area : null;
}

/**
 * While the user types, the conversation at the bottom of the page stays in view above the message box: the page
 * scrolls to its end when the box opens, and again once the keyboard is up and the screen has shrunk above it.
 */
export function useBottomWhileTyping(scroller: RefObject<HTMLElement | null>, typing: boolean, keyboard: boolean) {
  useEffect(() => {
    if (!typing) return;
    // Once the layout has settled: the box mounted, or the screen shrunk for the keys.
    const t = window.setTimeout(() => {
      const el = scroller.current;
      el?.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }, 60);
    return () => clearTimeout(t);
  }, [typing, keyboard]);
}
