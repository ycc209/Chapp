import { cn } from '../../lib/cn.ts';
import type { ResultRow } from './model.ts';

export type ResultRowsProps = {
  /** From model.ts concentrationRows() / massRows().rows / commonRows().rows. */
  rows: ResultRow[];
  /**
   * The column at the right: `cv` (40 px, 14 px type: "3 %"), `buffer` (48 px, 15 px: µL of buffer), or none
   * (Results-Swipe's three lists).
   */
  side?: 'cv' | 'buffer' | 'none';
  className?: string;
};

/**
 * One list of results, a row per sample: its number, its name, the value, and maybe a column at the right. A row
 * that needs a look (off the curve, a wide CV, the one the sentence is about) wears the highlighter on its name and
 * value. Put a SectionHead above it ("Your samples" · "µg/mL · CV").
 */
export function ResultRows({ rows, side = 'none', className }: ResultRowsProps) {
  return (
    <div className={cn('flex flex-col border-b border-line tabular-nums', className)}>
      {rows.map(r => (
        <div key={r.n} className="flex min-h-[41px] items-center gap-3 border-t border-line px-1 text-ink">
          <span className="w-[18px] shrink-0 text-[14px] leading-5 font-bold text-text">{r.n}</span>
          <span className="min-w-0 grow text-[17px] leading-[22px] font-medium">
            <span className={cn('-mx-[3px] rounded-[4px] px-[3px]', r.mark && 'bg-sample-bg')}>{r.name}</span>
          </span>
          <span className={cn('text-right leading-[22px]', r.note ? 'text-[15px] font-medium' : 'text-[17px] font-[650]')}>
            <span className={cn('-mx-[3px] rounded-[4px] px-[3px]', r.mark && 'bg-sample-bg')}>{r.value}</span>
          </span>
          {side === 'cv' && <span className="w-10 shrink-0 text-right text-[14px] leading-5 font-semibold text-text">{r.side}</span>}
          {side === 'buffer' && <span className="w-12 shrink-0 text-right text-[15px] leading-5 font-semibold text-text">{r.side}</span>}
        </div>
      ))}
    </div>
  );
}
