// Pieces of the bottom bar's look (Main.dc.html) that the home screen's own controls share with it.

/** The bar's glow: blue and teal rising from the bottom edge. */
const GLOW = 'radial-gradient(56% 64% at 50% 100%, rgba(121, 185, 243, 0.3) 0%, rgba(111, 211, 198, 0.1) 55%, rgba(255, 255, 255, 0) 80%)';

/**
 * The bar's wash: the glow over white, so nothing on the page shows through behind the bar's buttons as it scrolls
 * under. BAR_FADE fades the page out just above it.
 */
export const BAR_BACKGROUND = `${GLOW}, #fff`;

/**
 * Above the bar that paints its own wash: the page fading into the bar's white, short enough to clear what a screen
 * keeps just above the bar (a run's Back, Skip and Next).
 */
export const BAR_FADE = 'pointer-events-none absolute inset-x-0 bottom-full h-4 bg-linear-to-b from-white/0 to-white';

/**
 * A screen's own wash under the bar and the pills over it (Protocol, Plan, Results, Chat), from the top of its 28 px
 * padding: the page fades out there, then white with the bar's glow.
 */
export const SCREEN_WASH = `${GLOW}, linear-gradient(rgba(255, 255, 255, 0), #fff 28px)`;

/** A 44 px round button of frosted glass: +, the keyboard, settings. */
export const GLASS_BUTTON =
  'flex size-11 shrink-0 items-center justify-center rounded-full bg-white/86 text-ink shadow-[0_0_0_1px_rgba(17,17,19,0.06)] backdrop-blur-[12px] outline-none focus-visible:ring-2 focus-visible:ring-blue';

/** The same, for a field: the search box in the sidebar, the message box when typing. */
export const GLASS_FIELD =
  'flex h-11 min-w-0 items-center rounded-full bg-white/86 text-text shadow-[0_0_0_1px_rgba(17,17,19,0.06)] backdrop-blur-[12px] focus-within:shadow-[0_0_0_1.5px_#0064e0]';
