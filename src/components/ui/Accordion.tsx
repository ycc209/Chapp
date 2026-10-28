import * as AccordionPrimitive from '@radix-ui/react-accordion';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../../lib/cn.ts';

/**
 * Sections that open in place, as the protocol's "In the kit" and "Steps" (Overview.dc.html): a hairline between
 * rows, a + that turns into × when open. `type="single" collapsible` for one open at a time.
 */
export function Accordion({ className, ...props }: ComponentProps<typeof AccordionPrimitive.Root>) {
  return <AccordionPrimitive.Root className={cn('flex flex-col border-b border-line', className)} {...props} />;
}

export const AccordionItem = AccordionPrimitive.Item;

type AccordionTriggerProps = ComponentProps<typeof AccordionPrimitive.Trigger> & {
  /** What sits before the +: a count ("3 items") or thumbnails. */
  aside?: ReactNode;
};

export function AccordionTrigger({ className, children, aside, ...props }: AccordionTriggerProps) {
  return (
    <AccordionPrimitive.Header className="flex">
      <AccordionPrimitive.Trigger
        className={cn(
          'group flex min-h-14 grow items-center gap-3 border-t border-line px-1 text-left text-ink outline-none',
          'focus-visible:bg-sunken',
          className,
        )}
        {...props}
      >
        <span className="grow text-[17px] leading-[22px] font-semibold">{children}</span>
        {aside}
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          aria-hidden="true"
          className="shrink-0 transition-transform duration-200 group-data-[state=open]:rotate-45"
        >
          <path d="M12 5v14M5 12h14" />
        </svg>
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  );
}

export function AccordionContent({ className, children, ...props }: ComponentProps<typeof AccordionPrimitive.Content>) {
  return (
    <AccordionPrimitive.Content
      className="overflow-hidden data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down"
      {...props}
    >
      <div className={cn('px-1 pb-[18px] text-[15px] leading-[22px] text-text', className)}>{children}</div>
    </AccordionPrimitive.Content>
  );
}
