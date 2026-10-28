import type { ComponentProps } from 'react';
import { Drawer as Vaul } from 'vaul';
import { useScreen } from '../../app/screen.ts';
import { cn } from '../../lib/cn.ts';

/**
 * A sheet that rises from the bottom and follows the finger (vaul), for longer choices than a menu holds. It portals
 * into the phone screen and leaves the page's own styles alone (noBodyStyles), since the phone is not the window on a
 * computer.
 */
export function Drawer(props: ComponentProps<typeof Vaul.Root>) {
  const { portal } = useScreen();
  return <Vaul.Root container={portal} noBodyStyles {...props} />;
}

export const DrawerTrigger = Vaul.Trigger;
export const DrawerClose = Vaul.Close;

export function DrawerContent({ className, children, ...props }: ComponentProps<typeof Vaul.Content>) {
  const { portal } = useScreen();
  return (
    <Vaul.Portal container={portal}>
      <Vaul.Overlay className="fixed inset-0 z-50 bg-[rgba(17,17,19,0.12)]" />
      <Vaul.Content
        aria-describedby={undefined}
        className={cn(
          'fixed inset-x-0 bottom-0 z-50 flex max-h-[85%] flex-col rounded-t-[28px] bg-card text-text outline-none',
          'pb-[var(--screen-bottom)] shadow-[0_-1px_0_rgba(17,17,19,0.04),0_-6px_22px_rgba(17,17,19,0.07)]',
          className,
        )}
        {...props}
      >
        <div aria-hidden="true" className="mx-auto mt-2 mb-1 h-[5px] w-9 shrink-0 rounded-full bg-line" />
        {children}
      </Vaul.Content>
    </Vaul.Portal>
  );
}

export function DrawerTitle({ className, ...props }: ComponentProps<typeof Vaul.Title>) {
  return <Vaul.Title className={cn('px-5 pt-3 text-[22px] leading-7 font-[650] text-ink', className)} {...props} />;
}
