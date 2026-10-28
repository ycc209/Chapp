// Pieces of the bottom bar's look (Main.dc.html) that the home screen's own controls share with it.

/** The bar's wash: a blue-teal glow rising from the bottom edge into white. */
export const BAR_BACKGROUND =
  'radial-gradient(56% 64% at 50% 100%, rgba(121, 185, 243, 0.3) 0%, rgba(111, 211, 198, 0.1) 55%, rgba(255, 255, 255, 0) 80%), linear-gradient(rgba(255, 255, 255, 0), rgba(255, 255, 255, 0.86) 38%, rgba(255, 255, 255, 0.94))';

/** A 44 px round button of frosted glass: +, the keyboard, settings. */
export const GLASS_BUTTON =
  'flex size-11 shrink-0 items-center justify-center rounded-full bg-white/86 text-ink shadow-[0_0_0_1px_rgba(17,17,19,0.06)] backdrop-blur-[12px] outline-none focus-visible:ring-2 focus-visible:ring-blue';

/** The same, for a field: the search box in the sidebar, the message box when typing. */
export const GLASS_FIELD =
  'flex h-11 min-w-0 items-center rounded-full bg-white/86 text-text shadow-[0_0_0_1px_rgba(17,17,19,0.06)] backdrop-blur-[12px] focus-within:shadow-[0_0_0_1.5px_#0064e0]';
