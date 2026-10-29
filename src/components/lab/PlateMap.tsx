import type { CSSProperties } from 'react';
import { cn } from '../../lib/cn.ts';
import { shadeColor, shadeInk, type PlatePlan, type Tube } from './model.ts';

export type PlateMapProps = {
  /** The layout, from model.ts plateMap(). */
  plan: PlatePlan;
  /**
   * While loading (Run-Load, Gloves-Load): the index of the tube going in now. Its wells are yellow with an ink ring;
   * tubes after it are still empty. Leave it out to show the whole plan (Plan's Plate panel); past the last tube, all
   * are loaded.
   */
  now?: number | null;
  /** Tubes skipped while loading: their wells stay empty. */
  skipped?: readonly number[];
  /** Makes the wells buttons: tapping the tube now moves on, an earlier one goes back to it (Run-Load). */
  onTube?: (tube: number) => void;
  /** 3 px between wells instead of 4 (Gloves-Load). */
  dense?: boolean;
  'aria-label'?: string;
  className?: string;
};

const WELL = 'flex aspect-square w-full items-center justify-center rounded-full p-0 text-[9px] leading-[normal] font-bold';
const EMPTY: CSSProperties = { background: 'var(--sunken)', color: 'var(--ink)' };
// A well that went wrong during the run (PlatePlan.bad): left empty and not read.
const BAD: CSSProperties = { background: 'var(--caution-bg)', color: 'var(--caution)', boxShadow: 'inset 0 0 0 1.5px var(--caution)' };

function wellStyle(t: Tube, now: boolean): CSSProperties {
  if (now) return { background: 'var(--mark)', color: 'var(--ink)', boxShadow: '0 0 0 2px var(--ink)' };
  if (t.kind === 'sample') return { background: 'var(--sample-bg)', color: 'var(--ink)', boxShadow: 'inset 0 0 0 1.5px var(--sample-line)' };
  if (t.blank) return { background: 'var(--std-0)', color: 'var(--ink)', boxShadow: 'inset 0 0 0 1px var(--std-2)' };
  return { background: shadeColor(t.level, 'well'), color: shadeInk(t.level, 'well') };
}

/**
 * The 96-well plate, rows A–H by columns 1–12: standards in their blues with the vial letter, the blank pale, samples
 * yellow with their number, empty wells grey. Fills the width it is given (wells stay round).
 */
export function PlateMap({ plan, now, skipped = [], onTube, dense, className, ...rest }: PlateMapProps) {
  const byWell = new Map(plan.cells.map(c => [`${c.row}:${c.col}`, c]));
  const loading = now !== undefined && now !== null;
  const label = 'text-center text-[9px] leading-3 font-semibold text-text';
  const name = (row: number, col: number) => `${String.fromCharCode(65 + row)}${col + 1}`;
  return (
    <div
      role={onTube ? 'group' : 'img'}
      aria-label={rest['aria-label'] ?? `${plan.wells} wells, replicates side by side`}
      className={cn('grid items-center tabular-nums', dense ? 'gap-[3px]' : 'gap-1', className)}
      style={{ gridTemplateColumns: `14px repeat(${plan.cols}, minmax(0, 1fr))` }}
    >
      <span />
      {Array.from({ length: plan.cols }, (_, c) => (
        <span key={c} className={label}>{c + 1}</span>
      ))}
      {Array.from({ length: plan.rows }, (_, r) => [
        <span key={`r${r}`} className={label}>{String.fromCharCode(65 + r)}</span>,
        ...Array.from({ length: plan.cols }, (_, c) => {
          const cell = byWell.get(`${r}:${c}`);
          const tube = cell && plan.tubes[cell.tube];
          const shown = tube && !skipped.includes(tube.index) && (!loading || tube.index <= now);
          const isNow = !!shown && loading && tube.index === now;
          const bad = !cell && plan.bad.includes(name(r, c));
          const style = shown ? wellStyle(tube, isNow) : bad ? BAD : EMPTY;
          const text = shown ? tube.ref : bad ? '×' : '';
          const aria = shown ? `${tube.name}${tube.label ? ` (${tube.label})` : ''} in ${name(r, c)}${isNow ? ', now' : loading ? ', loaded' : ''}` : bad ? `${name(r, c)}, went wrong, not read` : `${name(r, c)}, empty`;
          if (onTube) {
            return (
              <button
                key={`${r}:${c}`}
                type="button"
                aria-label={aria}
                disabled={!shown}
                onClick={() => tube && onTube(tube.index)}
                className={cn(WELL, 'border-0 font-[inherit] text-[9px] leading-[normal] font-bold outline-none focus-visible:outline-2 focus-visible:outline-blue disabled:cursor-default')}
                style={style}
              >
                {text}
              </button>
            );
          }
          return (
            <span key={`${r}:${c}`} className={WELL} style={style}>
              {text}
            </span>
          );
        }),
      ])}
    </div>
  );
}
