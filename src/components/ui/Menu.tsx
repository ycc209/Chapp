import { useEffect, useRef, type ComponentProps, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { cn } from '../../lib/cn.ts';

/**
 * A small menu that opens beside the button that called it, as the + menu (Home-Plus.dc.html): a white card of rows,
 * no veil. Arrow keys, Home and End move between rows; Escape, Tab or a tap anywhere else closes it, and focus goes
 * back where it was. Place it yourself (absolute, next to its button) inside the screen.
 *
 * Written here rather than with Radix's DropdownMenu because the button that opens it can live in another component
 * (the bottom bar), and DropdownMenu needs its own Trigger.
 */
type MenuProps = {
  open: boolean;
  onClose: () => void;
  /** What the menu is for, read by screen readers ("Start from"). */
  label: string;
  className?: string;
  children: ReactNode;
  /** Taps on these do not count as outside (the button that toggles the menu handles them itself). */
  ignore?: RefObject<HTMLElement | null>[];
};

export function Menu({ open, onClose, label, className, children, ignore = [] }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const ignored = useRef(ignore);
  ignored.current = ignore;

  useEffect(() => {
    if (!open) return;
    const menu = ref.current;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Opened from the keyboard: straight to the first row. By touch or mouse: the menu itself, so no row looks
    // selected before one is chosen (as Radix menus do); an arrow key then enters the rows.
    (lastInput === 'keyboard' ? items(menu)[0] : menu)?.focus({ preventScroll: true });

    const outside = (e: PointerEvent) => {
      const target = e.target as Node;
      if (menu?.contains(target) || ignored.current.some(r => r.current?.contains(target))) return;
      close.current();
    };
    document.addEventListener('pointerdown', outside, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      // Back to the button that opened it, unless the user has already moved on to something else.
      const active = document.activeElement;
      if (before?.isConnected && (!active || active === document.body || menu?.contains(active))) {
        before.focus({ preventScroll: true });
      }
    };
  }, [open]);

  if (!open) return null;

  const onKeyDown = (e: KeyboardEvent) => {
    const list = items(ref.current);
    const at = list.indexOf(document.activeElement as HTMLElement);
    const move = (i: number) => {
      e.preventDefault();
      list[(i + list.length) % list.length]?.focus();
    };
    if (e.key === 'ArrowDown') move(at + 1);
    else if (e.key === 'ArrowUp') move(at < 0 ? -1 : at - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(list.length - 1);
    else if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      close.current();
    }
  };

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className={cn(
        'flex min-w-[150px] flex-col rounded-[18px] bg-card p-1.5 outline-none',
        'shadow-[0_0_0_1px_rgba(17,17,19,0.06),0_1px_2px_rgba(17,17,19,0.04),0_6px_22px_rgba(17,17,19,0.07)]',
        'animate-in fade-in zoom-in-95 slide-in-from-bottom-1 duration-150 ease-out',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** One row: an icon (20 px) and a word. */
export function MenuItem({ className, ...props }: ComponentProps<'button'>) {
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      className={cn(
        'flex min-h-[46px] items-center gap-3 rounded-xl pr-4 pl-3 text-left text-[16px] leading-5 font-semibold text-ink outline-none',
        'transition-colors duration-100 hover:bg-sunken focus-visible:bg-sunken active:bg-sunken',
        className,
      )}
      {...props}
    />
  );
}

// Whether the user last pressed a key or touched the screen, to know how a menu was opened.
let lastInput: 'keyboard' | 'pointer' = 'pointer';
if (typeof document !== 'undefined') {
  document.addEventListener('keydown', () => (lastInput = 'keyboard'), true);
  document.addEventListener('pointerdown', () => (lastInput = 'pointer'), true);
}

function items(menu: HTMLElement | null) {
  return menu ? [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])')] : [];
}
