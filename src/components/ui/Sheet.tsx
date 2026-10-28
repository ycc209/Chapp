import * as DialogPrimitive from '@radix-ui/react-dialog';
import type { ComponentProps } from 'react';
import { useScreen } from '../../app/screen.ts';
import { cn } from '../../lib/cn.ts';

/**
 * A panel that slides in from an edge of the phone (Radix Dialog): the sidebar. Focus stays inside while it is open,
 * Escape or a tap outside closes it. It portals into the phone screen, so on a computer it stays inside the device.
 */
export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;

// The design's slide: quick out of the gate, settling softly (as iOS sheets do).
export const SHEET_EASE = 'ease-[cubic-bezier(0.32,0.72,0,1)]';
export const SHEET_DURATION = 'duration-[380ms]';

const sides = {
  left: 'inset-y-0 left-0 data-[state=open]:slide-in-from-left data-[state=closed]:slide-out-to-left',
  right: 'inset-y-0 right-0 data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right',
  bottom:
    'inset-x-0 bottom-0 rounded-t-card data-[state=open]:slide-in-from-bottom data-[state=closed]:slide-out-to-bottom',
};

type SheetContentProps = ComponentProps<typeof DialogPrimitive.Content> & {
  side?: keyof typeof sides;
  /** A veil over the rest of the screen. Off when the sheet pushes the page aside instead (the sidebar). */
  veil?: boolean;
};

export function SheetContent({ side = 'left', veil = true, className, children, ...props }: SheetContentProps) {
  const { portal } = useScreen();
  return (
    <DialogPrimitive.Portal container={portal}>
      {veil && (
        <DialogPrimitive.Overlay
          className={cn(
            'fixed inset-0 z-50 bg-white/60 backdrop-blur-[6px]',
            'data-[state=open]:animate-in data-[state=open]:fade-in data-[state=closed]:animate-out data-[state=closed]:fade-out',
            SHEET_DURATION,
          )}
        />
      )}
      <DialogPrimitive.Content
        aria-describedby={undefined}
        className={cn(
          'fixed z-50 flex flex-col bg-card text-text outline-none',
          'data-[state=open]:animate-in data-[state=closed]:animate-out',
          SHEET_DURATION,
          SHEET_EASE,
          sides[side],
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

/** Every sheet needs a title for screen readers; pass className="sr-only" when the design shows none. */
export function SheetTitle({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cn('text-[22px] leading-7 font-[650] text-ink', className)} {...props} />;
}
