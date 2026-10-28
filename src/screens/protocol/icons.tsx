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
