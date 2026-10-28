import { useRef, type RefObject } from 'react';
import { useNavigate } from 'react-router';
import { Menu, MenuItem } from '../../components/ui/Menu.tsx';
import { CameraIcon, CloseIcon, QrIcon, UploadIcon } from './icons.tsx';
import { startUpload } from './upload.ts';

type PlusMenuProps = {
  open: boolean;
  onClose: () => void;
  /** Draw the dark × over the bar's +, for a bar that cannot show it itself (the voice bar). */
  coverPlus: boolean;
  /** The bar's own + (the typing bar), whose taps toggle the menu rather than count as outside. */
  plusRef: RefObject<HTMLButtonElement | null>;
};

/**
 * The + menu (Home-Plus.dc.html): the ways in besides speaking. Camera photographs the kit (the first photo can be the
 * box: Chapp tells which kit it is, ../kit/analysis.ts whichKit), QR code imports a labmate's setup, Upload takes the
 * vendor's PDF: Chapp reads it into a protocol (./upload.ts) while the Overview opens.
 */
export function PlusMenu({ open, onClose, coverPlus, plusRef }: PlusMenuProps) {
  const navigate = useNavigate();
  const file = useRef<HTMLInputElement>(null);
  const cover = useRef<HTMLButtonElement>(null);

  const go = (to: string, state?: object) => {
    onClose();
    navigate(to, { state });
  };

  return (
    <>
      <Menu
        open={open}
        onClose={onClose}
        label="Start from"
        ignore={[cover, plusRef]}
        className="absolute bottom-[calc(76px+var(--screen-bottom))] left-5 z-[7] origin-bottom-left"
      >
        <MenuItem onClick={() => go('/kit', { from: 'home' })}>
          <CameraIcon />
          Camera
        </MenuItem>
        <MenuItem onClick={() => go('/import')}>
          <QrIcon />
          QR code
        </MenuItem>
        <MenuItem
          onClick={() => {
            file.current?.click();
            onClose();
          }}
        >
          <UploadIcon />
          Upload
        </MenuItem>
      </Menu>
      {open && coverPlus && (
        // Sits exactly over the bar's + (left 20, 10 px above the bar's bottom padding): the design turns it into ×.
        <button
          ref={cover}
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="absolute bottom-[calc(10px+var(--screen-bottom))] left-5 z-[7] flex size-11 items-center justify-center rounded-full bg-ink text-white outline-none focus-visible:ring-2 focus-visible:ring-blue focus-visible:ring-offset-2"
        >
          <CloseIcon />
        </button>
      )}
      <input
        ref={file}
        type="file"
        accept="application/pdf,.pdf"
        hidden
        tabIndex={-1}
        onChange={e => {
          const pdf = e.target.files?.[0];
          e.target.value = '';
          if (pdf) navigate('/protocol', { state: { upload: startUpload(pdf) } });
        }}
      />
    </>
  );
}
