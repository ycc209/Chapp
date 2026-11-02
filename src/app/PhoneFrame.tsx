import { useEffect, useMemo, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { Outlet } from 'react-router';
import { Toaster } from '../components/ui/Toaster.tsx';
import { cn } from '../lib/cn.ts';
import { DebugPanel, useDebugFlag } from './DebugPanel.tsx';
import { useVisibleArea } from './keyboard.ts';
import { RunDock } from './RunDock.tsx';
import { useRunComesBack } from './runAside.ts';
import { TimeUpHost, useExperimentLink } from './TimeUpHost.tsx';
import { ScreenContext, type Screen } from './screen.ts';
import './motion.css';

// The design's device (data/design/*.dc.html): a 426 × 898 bezel around the 402 × 874 screen.
const DEVICE_W = 426;
const DEVICE_H = 898;
const MARGIN = 24;

// A computer, or a tablet held upright: draw the phone. A phone, in either orientation: the app is the whole page.
const FRAMED = '(min-width: 600px) and (min-height: 560px), (min-width: 600px) and (pointer: fine)';

/**
 * Offsets in the design assume the screen of the drawn device: a 402 × 874 iPhone whose status bar and dynamic island
 * take the top 62 px, and a 34 px home indicator. Screens add `--screen-top` to every top offset from the design
 * (top-[calc(44px+var(--screen-top))]) and use `--screen-bottom` where the design leaves 34 px at the bottom.
 *
 * On a phone the offsets follow the real status bar. Added to the home screen, the page runs under it (safe-area top
 * about 62 px), so the design's offsets hold as drawn. In the browser the page starts below it (safe-area top 0): the
 * design's 62 px allowance would leave a gap above Chapp, so everything moves up 44 px, which leaves the menu button
 * 12 px from the top. A taller home indicator lifts the bar.
 */
const insets: Record<'framed' | 'phone' | 'keyboard', CSSProperties> = {
  framed: { '--screen-top': '0px', '--screen-bottom': '34px' } as CSSProperties,
  phone: {
    '--screen-top': 'max(-44px, env(safe-area-inset-top) - 62px)',
    '--screen-bottom': 'max(34px, env(safe-area-inset-bottom))',
  } as CSSProperties,
  // The keyboard covers the home indicator: the bar sits just above the keys.
  keyboard: { '--screen-bottom': '8px' } as CSSProperties,
};

/** The layout route: on a computer, the phone drawn as in the design and scaled to fit; on a phone, full screen. */
export function PhoneFrame() {
  const framed = useMedia(FRAMED);
  const scale = useFitScale(framed);
  const visible = useVisibleArea(!framed);
  useRunComesBack();
  useExperimentLink();
  const debug = useDebugFlag();
  // On a phone only the screens' own areas scroll, never the page: when iPhone Safari gets the page's height wrong (after
  // the camera), a page that could scroll took the finger's swipe instead of the screen under it.
  useEffect(() => {
    document.documentElement.classList.toggle('chapp-phone', !framed);
    return () => document.documentElement.classList.remove('chapp-phone');
  }, [framed]);
  const keyboard = Boolean(visible?.keyboard);
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  const screen = useMemo<Screen>(() => ({ portal, scale, framed, keyboard }), [portal, scale, framed, keyboard]);

  // The tree keeps one shape in both modes (only classes change), so resizing across the breakpoint keeps the
  // screen's state instead of remounting it. While the keyboard is up, the app is pinned to the visible area, so the
  // bottom bar and its message box sit right above the keys.
  return (
    <div
      className={cn(
        'h-dvh w-full overflow-hidden',
        framed ? 'flex items-center justify-center bg-sunken' : 'bg-bg',
        keyboard && 'fixed top-0 left-0',
      )}
      style={keyboard && visible ? { height: visible.height, transform: `translateY(${visible.top}px)` } : undefined}
    >
      <div
        className={framed ? 'relative shrink-0' : 'h-full w-full'}
        style={framed ? { width: DEVICE_W * scale, height: DEVICE_H * scale } : undefined}
      >
        <div
          className={
            framed
              ? 'absolute top-0 left-0 h-[898px] w-[426px] origin-top-left rounded-[66px] bg-[#1c1c1e] p-3 shadow-[inset_0_0_0_2px_#3a3a3c,0_30px_70px_-20px_rgba(17,17,19,0.35)]'
              : 'h-full w-full'
          }
          style={framed && scale !== 1 ? { transform: `scale(${scale})` } : undefined}
        >
          <ScreenContext value={screen}>
            {/* Framed, contain: layout makes the drawn screen the box `position: fixed` resolves against, so portaled
                sheets, dialogs and toasts cover the phone, not the browser window. On a phone the screen is the
                window already, and iOS scrolls the pages more reliably without containment. */}
            <div
              data-screen=""
              className={cn(
                'relative overflow-hidden bg-bg',
                framed ? 'h-[874px] w-[402px] rounded-[54px] [contain:layout_paint]' : 'h-full w-full',
              )}
              style={framed ? insets.framed : keyboard ? { ...insets.phone, ...insets.keyboard } : insets.phone}
            >
              {framed && (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute top-[11px] left-[138px] z-[100] h-[37px] w-[126px] rounded-[19px] bg-black"
                />
              )}
              <Outlet />
              <RunDock />
              <TimeUpHost />
              <div ref={setPortal} data-screen-portal="" />
              <Toaster />
              {debug && <DebugPanel />}
            </div>
          </ScreenContext>
        </div>
      </div>
    </div>
  );
}

function useMedia(query: string) {
  return useSyncExternalStore(
    notify => {
      const list = window.matchMedia(query);
      list.addEventListener('change', notify);
      return () => list.removeEventListener('change', notify);
    },
    () => window.matchMedia(query).matches,
  );
}

/** How much to shrink the device so it fits the window with a margin; never enlarged. */
function useFitScale(framed: boolean) {
  const [scale, setScale] = useState(() => fit());
  useEffect(() => {
    if (!framed) return;
    const update = () => setScale(fit());
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [framed]);
  return framed ? scale : 1;
}

function fit() {
  const s = Math.min(1, (window.innerHeight - 2 * MARGIN) / DEVICE_H, (window.innerWidth - 2 * MARGIN) / DEVICE_W);
  return Math.max(0.4, Math.round(s * 1000) / 1000);
}
