// The home screen's icons, copied from the design's inline SVGs (Home-Plus.dc.html, Sidebar.dc.html).
import type { ReactNode } from 'react';

function Icon({ size, width = 2, children }: { size: number; width?: number; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={width}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const CameraIcon = () => (
  <Icon size={20}>
    <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z" />
    <circle cx="12" cy="13" r="3" />
  </Icon>
);

export const QrIcon = () => (
  <Icon size={20}>
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
    <path d="M14 14h3v3h-3zM21 14v.01M14 21h.01M21 21h-4v-4" />
  </Icon>
);

export const UploadIcon = () => (
  <Icon size={20}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6M12 18v-6M9 15l3-3 3 3" />
  </Icon>
);

export const PlusIcon = () => (
  <Icon size={22}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

export const CloseIcon = ({ size = 22 }: { size?: number }) => (
  <Icon size={size}>
    <path d="M18 6 6 18M6 6l12 12" />
  </Icon>
);

export const HomeIcon = () => (
  <Icon size={22}>
    <path d="M3 10.5 12 3l9 7.5" />
    <path d="M5 9.5V20h14V9.5" />
  </Icon>
);

export const LibraryIcon = () => (
  <Icon size={22}>
    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
  </Icon>
);

export const GlobeIcon = () => (
  <Icon size={22}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
  </Icon>
);

export const PeopleIcon = () => (
  <Icon size={22}>
    <circle cx="9" cy="7" r="4" />
    <path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75M21 21v-2a4 4 0 0 0-3-3.85" />
  </Icon>
);

export const SettingsIcon = () => (
  <Icon size={20}>
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    <circle cx="12" cy="12" r="3" />
  </Icon>
);

export const SearchIcon = () => (
  <Icon size={18}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </Icon>
);

export const PencilIcon = () => (
  <Icon size={22}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </Icon>
);

/** Send, in the message box (no artboard: the design's arrow style, pointing up as the chevron of Tap to speak). */
export const SendIcon = () => (
  <Icon size={18} width={2.4}>
    <path d="M12 19V5M6 11l6-6 6 6" />
  </Icon>
);
