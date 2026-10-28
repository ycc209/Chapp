import { cn } from '../../lib/cn.ts';
import { concentrationText, microliters, shadeLevels, vialSource, type StandardVial } from './model.ts';
import { VialDot, currentVial } from './Vials.tsx';

const COLUMNS = 'grid grid-cols-[32px_minmax(0,1fr)_56px_52px_64px] gap-2';

export type StandardsTableProps = {
  vials: readonly StandardVial[];
  /** Ticked vials by id; the first unticked one is the yellow row unless `now` says otherwise. */
  done?: Record<string, boolean>;
  now?: string | null;
  className?: string;
};

/**
 * The dilution table, one row per vial: µg/mL, where it comes from, µL taken, µL of diluent (Gloves-Standards). The
 * whole series stays in view; the vial being made is the yellow row, ticked ones turn yellow with a check.
 */
export function StandardsTable({ vials, done, now, className }: StandardsTableProps) {
  const levels = shadeLevels(vials);
  const current = currentVial(vials, done, now);
  const head = 'text-[13px] leading-[18px] font-semibold text-text';
  return (
    <div role="table" aria-label={`Vials ${vials[0]?.id ?? ''} to ${vials.at(-1)?.id ?? ''}`} className={cn('flex flex-col border-b border-line tabular-nums', className)}>
      <div role="row" className={cn(COLUMNS, 'items-end px-1 pb-1.5')}>
        <span role="columnheader" className={head}>Vial</span>
        <span role="columnheader" className={cn(head, 'text-right')}>µg/mL</span>
        <span role="columnheader" className={head}>From</span>
        <span role="columnheader" className={cn(head, 'text-right')}>µL</span>
        <span role="columnheader" className={cn(head, 'text-right')}>Diluent</span>
      </div>
      {vials.map((v, i) => {
        const isDone = !!done?.[v.id];
        const isNow = v.id === current;
        const source = vialSource(v);
        return (
          <div
            key={v.id}
            role="row"
            aria-label={`Vial ${v.id}, ${concentrationText(v.concentration)} µg/mL, ${microliters(v.take)} µL from ${source}, ${microliters(v.diluent)} µL diluent${isDone ? ', done' : isNow ? ', now' : ''}`}
            className={cn(COLUMNS, 'min-h-[33px] items-center border-t border-line px-1 text-[15px] leading-5 text-ink', isNow ? 'bg-sample-bg font-bold' : 'font-medium')}
          >
            <VialDot id={v.id} level={levels[i]!} blank={v.blank} state={isDone ? 'done' : isNow ? 'now' : undefined} ground="var(--sample-bg)" />
            <span className="text-right">{concentrationText(v.concentration)}</span>
            <span>{source}</span>
            <span className="text-right">{microliters(v.take)}</span>
            <span className="text-right">{microliters(v.diluent)}</span>
          </div>
        );
      })}
    </div>
  );
}
