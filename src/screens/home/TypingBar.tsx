import { useEffect, useRef, useState, type RefObject } from 'react';
import { cn } from '../../lib/cn.ts';
import { BAR_BACKGROUND, GLASS_BUTTON, GLASS_FIELD } from './bar.ts';
import { CloseIcon, PlusIcon, SendIcon } from './icons.tsx';

type TypingBarProps = {
  /** The + menu is open: + turns into its dark close button (Home-Plus.dc.html). */
  plusOpen: boolean;
  plusRef: RefObject<HTMLButtonElement | null>;
  onPlus: () => void;
  onSend: (text: string) => void;
  /** Back to Tap to speak. */
  onClose: () => void;
};

/**
 * The bottom bar while typing (no artboard): the same bar, with a message box in place of Tap to speak and a close
 * button in place of the keyboard. Enter or the arrow sends; Escape or × goes back to speaking.
 */
export function TypingBar({ plusOpen, plusRef, onPlus, onSend, onClose }: TypingBarProps) {
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const ready = text.trim().length > 0;

  useEffect(() => input.current?.focus({ preventScroll: true }), []);

  return (
    <form
      aria-label="Message Chapp"
      onSubmit={e => {
        e.preventDefault();
        if (!ready) return;
        onSend(text);
        setText('');
        // Put the phone's keyboard away so the answer is in view; a tap on the box brings it back.
        input.current?.blur();
      }}
      onKeyDown={e => {
        if (e.key === 'Escape' && !plusOpen) {
          e.preventDefault();
          onClose();
        }
      }}
      // Bleeds out of the screen's content padding like the voice bar (20 px at the sides, the bottom inset below).
      className="relative -mx-5 -mt-2 mb-[calc(-1*var(--screen-bottom))] grid grid-cols-[44px_minmax(0,1fr)_44px] grid-rows-[64px] items-center gap-2.5 px-5 pt-2 pb-[var(--screen-bottom)]"
      style={{ background: BAR_BACKGROUND }}
    >
      <button
        ref={plusRef}
        type="button"
        aria-label={plusOpen ? 'Close' : 'Camera, QR code or upload'}
        aria-expanded={plusOpen}
        onClick={onPlus}
        className={cn(GLASS_BUTTON, plusOpen && 'bg-ink text-white shadow-none')}
      >
        {plusOpen ? <CloseIcon /> : <PlusIcon />}
      </button>
      <label className={cn(GLASS_FIELD, 'gap-2 pr-1.5 pl-4')}>
        <input
          ref={input}
          value={text}
          onChange={e => setText(e.target.value)}
          aria-label="Message"
          placeholder="Ask Chapp"
          enterKeyHint="send"
          autoComplete="off"
          className="min-w-0 grow bg-transparent text-[17px] leading-[22px] text-ink outline-none placeholder:text-muted"
        />
        <button
          type="submit"
          aria-label="Send"
          disabled={!ready}
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-blue text-white transition-[opacity,scale] duration-150 outline-none focus-visible:ring-2 focus-visible:ring-blue focus-visible:ring-offset-2 disabled:scale-75 disabled:opacity-0"
        >
          <SendIcon />
        </button>
      </label>
      <button type="button" aria-label="Stop typing" onClick={onClose} className={GLASS_BUTTON}>
        <CloseIcon size={20} />
      </button>
    </form>
  );
}
