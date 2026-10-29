import { cn } from '../../lib/cn.ts';

export type MarkChipsProps<T extends string | number> = {
  options: readonly { value: T; label: string; aria?: string }[];
  value: T;
  onChange: (value: T) => void;
  /**
   * `choice`: white pills, the chosen one yellow (Run-Incubate: 30 min · 2 h).
   * `tabs`: bare labels, the chosen one on yellow in bold (Results-Swipe: µg/mL · 20 µg · 0.4 mg/mL · Curve).
   */
  variant?: 'choice' | 'tabs';
  'aria-label': string;
  className?: string;
};

const SHADOW = 'shadow-[0_1px_2px_rgba(17,17,19,0.06),0_2px_8px_rgba(17,17,19,0.04)]';

/**
 * Pick one, the choice marked in yellow: the thing to do now, as the run and results screens use it.
 */
export function MarkChips<T extends string | number>({ options, value, onChange, variant = 'choice', className, ...rest }: MarkChipsProps<T>) {
  const tabs = variant === 'tabs';
  return (
    <div role={tabs ? 'tablist' : 'radiogroup'} aria-label={rest['aria-label']} className={cn('flex', tabs ? 'gap-1' : 'flex-wrap gap-2 px-1', className)}>
      {options.map(o => {
        const on = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            role={tabs ? 'tab' : 'radio'}
            aria-selected={tabs ? on : undefined}
            aria-checked={tabs ? undefined : on}
            aria-label={o.aria}
            onClick={() => onChange(o.value)}
            className={cn(
              'min-h-11 cursor-pointer rounded-[22px] border-0 font-[inherit] text-[15px] leading-5 text-ink outline-none focus-visible:outline-2 focus-visible:outline-blue',
              tabs
                ? cn('px-3 whitespace-nowrap', on ? 'bg-mark font-bold' : 'bg-transparent font-[550]')
                : cn('px-4 font-semibold', on ? 'bg-mark' : cn('bg-white', SHADOW)),
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
