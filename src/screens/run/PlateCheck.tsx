import { useState, type ReactNode } from 'react';
import type { PlanFit } from '../../../shared/plate.ts';
import { cn } from '../../lib/cn.ts';
import { needsLook, readableText, typedReading, type PlateCheck } from './model.ts';

const PILL = 'flex min-h-10 cursor-pointer items-center rounded-[20px] border-0 px-[18px] font-[inherit] text-[15px] leading-5 font-semibold outline-none focus-visible:ring-2 focus-visible:ring-blue';
const WHITE_PILL = cn(PILL, 'bg-white text-ink shadow-[0_1px_2px_rgba(17,17,19,0.06),0_2px_8px_rgba(17,17,19,0.04)]');
const INK_PILL = cn(PILL, 'bg-ink text-white');

const B = ({ children }: { children: ReactNode }) => <b className="font-bold">{children}</b>;

export type PlateCheckProps = {
  check: PlateCheck;
  /** The check against the plan's wells (fitToPlan). */
  fit: PlanFit;
  /** The plan's wells, to draw only the rows and columns the plate uses. */
  wells: readonly string[];
  onEdit: (well: string, value: number | null) => void;
  /** These are right: Results takes them as the user's readings. */
  onConfirm: () => void;
  /** Photo again, or another file. */
  onAgain: () => void;
};

/** What Chapp says above the numbers: where they came from, how many wells are read, and what to do. */
export function checkSay(check: PlateCheck, fit: PlanFit): ReactNode {
  const got = Object.keys(fit.readings).length;
  const total = got + fit.missing.length + Object.keys(fit.odd).length;
  const count = got === total ? <>all <B>{total}</B> wells</> : <><B>{got} of {total}</B> wells</>;
  if (check.by === 'model') {
    return check.name ? (
      <>I read {count} from <B>{check.name}</B>. Check them against the reader before I fit the curve.</>
    ) : (
      <>I read {count} from your photo. Check them against the reader before I fit the curve.</>
    );
  }
  return (
    <>
      <B>{check.name ?? 'The file'}</B> has readings for {count}. Fix the marked ones, or go on without them.
    </>
  );
}

/** The same, said aloud with gloves on. */
export const checkSpoken = (fit: PlanFit) => `${readableText(fit)} Check them, then say “yes”.`;

/**
 * Run-Read, readings to check: the plate as the plan uses it, each well's number, the ones that need a look on the
 * highlighter (no number, text instead of one, or a digit the model was unsure of). Tap a well to type its number.
 * The design has no artboard for this; it is the plate map's grid with the bench's own type and pills.
 */
export function PlateCheckView({ check, fit, wells, onEdit, onConfirm, onAgain }: PlateCheckProps) {
  const [editing, setEditing] = useState<string | null>(null);
  const look = needsLook(check, fit);
  const at = wells.map(w => ({ row: w.charCodeAt(0) - 65, col: Number(w.slice(1)) - 1 }));
  const rows = Array.from({ length: Math.max(...at.map(a => a.row)) + 1 }, (_, r) => r);
  const cols = [...new Set(at.map(a => a.col))].sort((a, b) => a - b);
  const inPlan = new Set(wells);
  const label = 'text-center text-[12px] leading-4 font-semibold text-text';

  const commit = (well: string, text: string) => {
    setEditing(null);
    const t = text.trim();
    if (!t) return onEdit(well, null);
    const n = typedReading(t);
    if (n !== null) onEdit(well, n);
  };

  return (
    <section aria-label="Readings to check" className="flex shrink-0 flex-col gap-4">
      <div
        role="group"
        aria-label={`Readings by well, ${look.size} marked`}
        className="grid items-center gap-1 tabular-nums"
        style={{ gridTemplateColumns: `16px repeat(${cols.length}, minmax(0, 1fr))` }}
      >
        <span />
        {cols.map(c => (
          <span key={c} aria-hidden="true" className={label}>
            {c + 1}
          </span>
        ))}
        {rows.map(r => {
          const letter = String.fromCharCode(65 + r);
          return (
            <span key={r} className="contents">
              <span aria-hidden="true" className={label}>
                {letter}
              </span>
              {cols.map(c => {
                const well = `${letter}${c + 1}`;
                if (!inPlan.has(well)) return <span key={well} aria-hidden="true" className="h-9 rounded-[10px] bg-sunken/50" />;
                const value = fit.readings[well];
                const odd = fit.odd[well];
                const shown = value !== undefined ? value.toFixed(3) : odd ? odd.slice(0, 6) : '—';
                const marked = look.has(well);
                if (editing === well) {
                  return (
                    <input
                      key={well}
                      autoFocus
                      inputMode="decimal"
                      aria-label={`Reading in ${well}`}
                      defaultValue={value !== undefined ? String(value) : ''}
                      onBlur={e => commit(well, e.currentTarget.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') commit(well, e.currentTarget.value);
                        if (e.key === 'Escape') setEditing(null);
                      }}
                      className="h-9 w-full min-w-0 rounded-[10px] border-0 bg-white px-1 text-center font-[inherit] text-[13px] font-semibold text-ink shadow-[0_0_0_2px_var(--ink)] outline-none"
                    />
                  );
                }
                return (
                  <button
                    key={well}
                    type="button"
                    aria-label={`${well}: ${value !== undefined ? value : odd ? `“${odd}”` : 'no reading'}${marked ? ', check it' : ''}. Tap to change`}
                    onClick={() => setEditing(well)}
                    className={cn(
                      'h-9 min-w-0 cursor-pointer overflow-hidden rounded-[10px] border-0 p-0 font-[inherit] text-[12px] leading-4 font-semibold text-ink outline-none focus-visible:ring-2 focus-visible:ring-blue',
                      marked ? 'bg-sample-bg shadow-[inset_0_0_0_1.5px_var(--sample-line)]' : 'bg-sunken',
                    )}
                  >
                    {shown}
                  </button>
                );
              })}
            </span>
          );
        })}
      </div>
      <p className="m-0 px-1 text-[13px] leading-[18px] font-semibold text-text">
        {look.size ? 'Marked wells need a look. Tap a well to type its number.' : 'Tap a well to type its number.'}
        {check.note ? ` ${check.by === 'file' ? 'Read used' : 'Note'}: ${check.note}` : ''}
      </p>
      <div className="flex flex-wrap items-center gap-2.5 px-1">
        <button type="button" onClick={onConfirm} disabled={!Object.keys(fit.readings).length} className={cn(INK_PILL, 'disabled:opacity-40')}>
          These are right
        </button>
        <button type="button" onClick={onAgain} className={WHITE_PILL}>
          {check.name ? 'Choose another file' : 'Take it again'}
        </button>
      </div>
    </section>
  );
}
