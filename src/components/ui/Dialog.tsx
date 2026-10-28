import * as DialogPrimitive from '@radix-ui/react-dialog';
import type { ComponentProps, ReactNode } from 'react';
import { useScreen } from '../../app/screen.ts';
import { cn } from '../../lib/cn.ts';

/**
 * A card in the middle of the phone that asks one thing (Radix Dialog). The veil is Chapp's frosted white, as behind
 * the 3D stage, not the usual dark scrim; it portals into the phone screen.
 */
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

type DialogContentProps = ComponentProps<typeof DialogPrimitive.Content> & {
  /** Shown under the card, e.g. the buttons. */
  footer?: ReactNode;
};

export function DialogContent({ className, children, footer, ...props }: DialogContentProps) {
  const { portal } = useScreen();
  return (
    <DialogPrimitive.Portal container={portal}>
      <DialogPrimitive.Overlay
        className={cn(
          'fixed inset-0 z-50 bg-white/70 backdrop-blur-[12px]',
          'duration-200 data-[state=open]:animate-in data-[state=open]:fade-in data-[state=closed]:animate-out data-[state=closed]:fade-out',
        )}
      />
      {/* Give it a DialogDescription, or pass aria-describedby={undefined} when there is none. */}
      <DialogPrimitive.Content
        className={cn(
          'fixed top-1/2 left-1/2 z-50 flex w-[calc(100%-40px)] max-w-[362px] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-card bg-card p-[22px] text-text outline-none',
          'shadow-[0_0_0_1px_rgba(17,17,19,0.06),0_1px_2px_rgba(17,17,19,0.04),0_6px_22px_rgba(17,17,19,0.07)]',
          'duration-200 data-[state=open]:animate-in data-[state=open]:fade-in data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out data-[state=closed]:zoom-out-95',
          className,
        )}
        {...props}
      >
        {children}
        {footer && <div className="mt-2 flex flex-col gap-2.5">{footer}</div>}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogTitle({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cn('text-[22px] leading-7 font-[650] text-ink', className)} {...props} />;
}

export function DialogDescription({ className, ...props }: ComponentProps<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description className={cn('text-[17px] leading-6 text-text', className)} {...props} />;
}
