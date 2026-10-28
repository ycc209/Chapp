import { createContext, useContext } from 'react';

/**
 * The phone screen every route draws into. On a computer it sits inside a drawn device that may be scaled down to fit
 * the window, so anything that measures the page or portals out of the React tree reads it from here.
 */
export type Screen = {
  /** Where sheets, drawers, dialogs and menus portal to, so they stay inside the phone (null until mounted). */
  portal: HTMLElement | null;
  /** The device's scale on a computer (1 on a phone): getBoundingClientRect() values are this much smaller. */
  scale: number;
  /** True when the screen is drawn inside a device frame (a computer), false when it is the whole page (a phone). */
  framed: boolean;
  /** The phone's on-screen keyboard is up; the screen has shrunk to the space above it. */
  keyboard: boolean;
};

export const ScreenContext = createContext<Screen>({ portal: null, scale: 1, framed: false, keyboard: false });

export function useScreen() {
  return useContext(ScreenContext);
}

/**
 * Turns a viewport rectangle (getBoundingClientRect) into the screen's own pixels, the design's 402 × 874 space:
 * what an absolutely placed overlay inside the screen needs. `screenEl` is the positioned element it is placed in.
 */
export function toScreenRect(rect: DOMRect, screenEl: Element, scale: number): DOMRect {
  const base = screenEl.getBoundingClientRect();
  return new DOMRect((rect.x - base.x) / scale, (rect.y - base.y) / scale, rect.width / scale, rect.height / scale);
}
