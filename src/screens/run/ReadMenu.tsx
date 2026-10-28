import { useRef, type RefObject } from 'react';
import { Menu, MenuItem } from '../../components/ui/Menu.tsx';
import { CameraIcon, CloseIcon, UploadIcon } from '../home/icons.tsx';

type ReadMenuProps = {
  open: boolean;
  onClose: () => void;
  /** Draw the dark × over the bar's + (the voice bar cannot show it itself). */
  coverPlus: boolean;
  plusRef: RefObject<HTMLButtonElement | null>;
  /** The reader's screen, photographed (Gloves-Photo). */
  onPhoto: () => void;
  /** The reader's export file (CSV, TSV, TXT or XLSX). */
  onFile: (file: File) => void;
  /** Chapp's example readings, labeled Sample data wherever they show. */
  onSample: () => void;
};

const FlaskIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 3h6" />
    <path d="M10 3v6l-5.5 9.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3" />
  </svg>
);

/** What the reader's export can be: text in any of its layouts, or the Excel file most readers also write. */
export const EXPORT_TYPES =
  '.csv,.tsv,.txt,.xlsx,text/csv,text/plain,text/tab-separated-values,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * The + on Run-Read: the ways to hand Chapp the readings. The design's way in is the reader's export; with no plate
 * reader at hand, the sample export stands in (and says so on every screen that shows it).
 */
export function ReadMenu({ open, onClose, coverPlus, plusRef, onPhoto, onFile, onSample }: ReadMenuProps) {
  const file = useRef<HTMLInputElement>(null);
  const cover = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Menu
        open={open}
        onClose={onClose}
        label="Give Chapp the readings"
        ignore={[cover, plusRef]}
        className="absolute bottom-[calc(76px+var(--screen-bottom))] left-5 z-[7] origin-bottom-left"
      >
        <MenuItem
          onClick={() => {
            file.current?.click();
            onClose();
          }}
        >
          <UploadIcon />
          Upload the reader’s export
        </MenuItem>
        <MenuItem
          onClick={() => {
            onClose();
            onPhoto();
          }}
        >
          <CameraIcon />
          Photo of the reader
        </MenuItem>
        <MenuItem
          onClick={() => {
            onClose();
            onSample();
          }}
        >
          <FlaskIcon />
          Use the sample export
        </MenuItem>
      </Menu>
      {open && coverPlus && (
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
        accept={EXPORT_TYPES}
        hidden
        tabIndex={-1}
        onChange={e => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) onFile(f);
        }}
      />
    </>
  );
}
