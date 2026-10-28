import * as ToggleGroupPrimitive from '@radix-ui/react-toggle-group';
import { createContext, useContext, type ComponentProps } from 'react';
import { cn } from '../../lib/cn.ts';

/**
 * Pick one of a few (Radix ToggleGroup, single): arrow keys move between options. Two looks from the design:
 * `segmented`, a grey track with the chosen option lifted in white (Single · Duplicate · Triplicate, Style.dc.html);
 * `chips`, separate pills with the chosen one in ink (how to make the standards, Plan.dc.html).
 */
type Variant = 'segmented' | 'chips';
const VariantContext = createContext<Variant>('segmented');

const groups: Record<Variant, string> = {
  segmented: 'grid auto-cols-fr grid-flow-col rounded-[26px] bg-sunken p-1',
  chips: 'flex flex-wrap gap-2 px-1',
};

const items: Record<Variant, string> = {
  segmented:
    'min-h-11 rounded-full px-2 text-[15px] leading-5 font-semibold text-text transition-[background-color,color,box-shadow] duration-150 data-[state=on]:bg-card data-[state=on]:text-ink data-[state=on]:shadow-[0_1px_2px_rgba(17,17,19,0.06),0_2px_8px_rgba(17,17,19,0.04)]',
  chips:
    'min-h-11 rounded-full bg-card px-4 text-[15px] leading-5 font-semibold text-ink shadow-[0_1px_2px_rgba(17,17,19,0.06),0_2px_8px_rgba(17,17,19,0.04)] transition-[background-color,color] duration-150 data-[state=on]:bg-ink data-[state=on]:text-white data-[state=on]:shadow-none',
};

type ToggleGroupProps = Omit<ToggleGroupPrimitive.ToggleGroupSingleProps, 'type'> & { variant?: Variant };

export function ToggleGroup({ variant = 'segmented', className, onValueChange, ...props }: ToggleGroupProps) {
  return (
    <VariantContext value={variant}>
      <ToggleGroupPrimitive.Root
        type="single"
        className={cn(groups[variant], className)}
        // Radix lets a tap on the chosen option clear it; a choice like replicates always has an answer.
        onValueChange={value => value && onValueChange?.(value)}
        {...props}
      />
    </VariantContext>
  );
}

export function ToggleGroupItem({ className, ...props }: ComponentProps<typeof ToggleGroupPrimitive.Item>) {
  const variant = useContext(VariantContext);
  return (
    <ToggleGroupPrimitive.Item
      className={cn(items[variant], 'outline-none focus-visible:ring-2 focus-visible:ring-blue', className)}
      {...props}
    />
  );
}
