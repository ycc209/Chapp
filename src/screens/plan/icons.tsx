import type { ReactNode } from 'react';

/** The plan's row icons, as Plan.dc.html draws them (20 px, #55555c, stroke 2). */
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#55555c" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
      {children}
    </svg>
  );
}

/** Samples: a tube. */
export const TubeIcon = () => (
  <Icon>
    <path d="M9 3h6" />
    <path d="M10 3v14a2 2 0 0 0 4 0V3" />
    <path d="M10 11h4" />
  </Icon>
);

/** Standards and the working reagent: a flask. */
export const FlaskIcon = () => (
  <Icon>
    <path d="M9 3h6" />
    <path d="M10 3v6l-5.5 9.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3" />
    <path d="M7 15h10" />
  </Icon>
);

/** The plate. */
export const PlateIcon = () => (
  <Icon>
    <rect x="3" y="5" width="18" height="14" rx="2.5" />
    <path d="M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01" />
  </Icon>
);

/** − on the sample stepper (18 px, stroke 2.2). */
export const MinusIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
    <path d="M5 12h14" />
  </svg>
);

/** × closing the Standards page (20 px, stroke 2.2, as the design's close buttons). */
export const CloseIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);
