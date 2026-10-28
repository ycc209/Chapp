// Icons of the protocol and kit screens, copied from the design's inline SVGs (Overview, Protocol, Camera, Kit).
import type { ReactNode } from 'react';

type IconProps = { size: number; width?: number; color?: string; fill?: string; className?: string; children: ReactNode };

function Icon({ size, width = 2, color = 'currentColor', fill = 'none', className, children }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill}
      stroke={fill === 'none' ? color : undefined}
      strokeWidth={fill === 'none' ? width : undefined}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {children}
    </svg>
  );
}

export const CameraIcon = ({ size = 16 }: { size?: number }) => (
  <Icon size={size}>
    <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z" />
    <circle cx="12" cy="13" r="3" />
  </Icon>
);

/** The chevron on the camera tab, nudging right every 1.2 s (Overview.dc.html's animateTransform). */
export const NudgeIcon = () => (
  <Icon size={10} width={3}>
    <g>
      <path d="m9 6 6 6-6 6" />
      <animateTransform attributeName="transform" type="translate" values="0 0; 4 0; 0 0" dur="1.2s" repeatCount="indefinite" />
    </g>
  </Icon>
);

export const ForwardIcon = () => (
  <Icon size={22}>
    <path d="m9 6 6 6-6 6" />
  </Icon>
);

export const PlusIcon = ({ className }: { className?: string }) => (
  <Icon size={18} width={2.2} className={className}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

export const StepsIcon = () => (
  <Icon size={20} color="#55555c">
    <path d="M10 6h11M10 12h11M10 18h11" />
    <path d="M4 6h1M4 12h1M4 18h1" />
  </Icon>
);

export const BulbIcon = () => (
  <Icon size={20} color="#55555c">
    <path d="M9 18h6M10 21h4" />
    <path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z" />
  </Icon>
);

export const WarningIcon = () => (
  <Icon size={20} color="#8a4d00">
    <path d="M12 3 2 20h20z" />
    <path d="M12 10v4M12 17h.01" />
  </Icon>
);

export const DocumentIcon = ({ size = 16 }: { size?: number }) => (
  <Icon size={size} width={2.2}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
  </Icon>
);

export const BookmarkIcon = () => (
  <Icon size={16} width={2.2}>
    <path d="M6 3h12v18l-6-4-6 4z" />
  </Icon>
);

export const PlayIcon = () => (
  <Icon size={12} fill="currentColor">
    <path d="M7 4.5v15l12.5-7.5z" />
  </Icon>
);

export const CheckIcon = ({ size = 11, width = 3.2 }: { size?: number; width?: number }) => (
  <Icon size={size} width={width}>
    <path d="M20 6 9 17l-5-5" />
  </Icon>
);

export const PhotosIcon = () => (
  <Icon size={20}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="9" cy="9" r="2" />
    <path d="m21 15-5-5L5 21" />
  </Icon>
);

export const CloseIcon = () => (
  <Icon size={20} width={2.2}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Icon>
);

/** The blue tick on a matched bottle (Recognized, Kit, Protocol-Kit): 20 px, ringed in white. */
export function CheckBadge({ stroke = 3.4 }: { stroke?: number }) {
  return (
    <span
      aria-hidden="true"
      className="absolute -right-1 -bottom-1 flex size-5 items-center justify-center rounded-full bg-blue text-white shadow-[0_0_0_2px_#ffffff]"
    >
      <CheckIcon width={stroke} />
    </span>
  );
}

/** The yellow ? on a bottle Chapp is not sure of (Recognized, Kit). */
export function AskBadge() {
  return (
    <span
      aria-hidden="true"
      className="absolute -right-1 -bottom-1 size-5 rounded-full bg-mark text-center text-[12px] leading-5 font-extrabold text-ink shadow-[0_0_0_2px_#ffffff]"
    >
      ?
    </span>
  );
}

/** One outline picture per kind of step, for the steps' progress row (stage as in shared/protocol.ts). */
export function StageIcon({ stage, size = 28 }: { stage?: string; size?: number }) {
  const shapes: Record<string, ReactNode> = {
    // Three tubes in a row: making the standards.
    standards: (
      <>
        <path d="M5 4v13a2 2 0 0 0 4 0V4M10.5 4v13a2 2 0 0 0 4 0V4M16 4v13a2 2 0 0 0 4 0V4" />
        <path d="M4 4h6M9.5 4h6M15 4h6" />
      </>
    ),
    // A flask: getting something ready.
    prepare: <path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3" />,
    // A flask with a swirl: making a mix.
    mix: (
      <>
        <path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3" />
        <path d="M7.5 15c1.5-1 3-1 4.5 0s3 1 4.5 0" />
      </>
    ),
    // A micropipette, plunger up, tip down: putting liquid into wells or tubes.
    load: (
      <>
        <path d="M11 2h2v3h-2zM8.5 5h7l-1.2 9h-4.6z" />
        <path d="M11 14h2l-.6 5h-.8zM12 19v2.5" />
      </>
    ),
    // A dropper: adding to the cells.
    treat: <path d="m12 9 3-3a2.1 2.1 0 0 1 3 3l-3 3M11 8l5 5M13 11l-7 7H4v-2l7-7" />,
    // A thermometer: waiting at a temperature.
    incubate: (
      <>
        <path d="M12 3a2 2 0 0 0-2 2v9.3a4 4 0 1 0 4 0V5a2 2 0 0 0-2-2z" />
        <path d="M12 10v6" />
      </>
    ),
    // A drop: washing.
    wash: <path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z" />,
    // A light beam through a well: reading on an instrument.
    read: (
      <>
        <rect x="4" y="9" width="16" height="11" rx="2" />
        <path d="M12 3v9M9 6l3-3 3 3M8 15h8" />
      </>
    ),
    // An eye: looking at the cells.
    observe: (
      <>
        <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
        <circle cx="12" cy="12" r="3" />
      </>
    ),
    // A curve through points: working out the result.
    analyze: (
      <>
        <path d="M4 20V4M4 20h16" />
        <path d="M7 16c3-1 5-4 6-7s3-4 6-4" />
      </>
    ),
  };
  return (
    <Icon size={size} width={1.6}>
      {shapes[stage ?? ''] ?? shapes.prepare}
    </Icon>
  );
}
