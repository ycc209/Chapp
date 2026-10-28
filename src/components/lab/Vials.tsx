import type { CSSProperties } from 'react';
import { cn } from '../../lib/cn.ts';
import { concentrationText, microliters, shadeColor, shadeInk, shadeLevels, vialRecipe, vialSay, type StandardVial } from './model.ts';
import { Check } from './Text.tsx';

/**
 * The standard vials, A to I: shaded by concentration in Meta blue, the blank white. Three looks from the design: the
 * card (Run-Standards, Plan, Plan-Full, Standards-2), the round dot (Gloves-Standards' table and its big "now" vial)
 * and the table row (StandardsTable.tsx).
 */

export type VialState = 'done' | 'now' | undefined;

/** Which vial is next: the one asked for, or else the first one not ticked (when ticks are being kept). */
export function currentVial(vials: readonly StandardVial[], done?: Record<string, boolean>, now?: string | null) {
  if (now !== undefined) return now;
  if (!done) return null;
  return vials.find(v => !done[v.id])?.id ?? null;
}

const NOW_RING = (ground: string, width: number) => `0 0 0 2px ${ground}, 0 0 0 ${width}px var(--sample-line)`;
const BLANK_RING = 'inset 0 0 0 1.5px var(--std-2)';

export type VialCardProps = {
  vial: StandardVial;
  /** Shade level 8…1, 0 for the blank (model.ts shadeLevels). */
  level: number;
  state?: VialState;
  /** Already made ("Already made" on Plan): "Ready / Need 50" instead of the recipe. */
  ready?: { need: number };
  onTap?: () => void;
};

/** One vial card: letter and µg/mL on top, what goes in below (min 118 px tall, 18 px corners). */
export function VialCard({ vial, level, state, ready, onTap }: VialCardProps) {
  const done = state === 'done';
  const rings = [vial.blank && BLANK_RING, done && 'inset 0 0 0 200px rgba(255, 255, 255, 0.72)', state === 'now' && NOW_RING('#ffffff', 4.5)].filter(Boolean);
  const [l1, l2] = ready ? ['Ready', `Need ${microliters(ready.need)}`] : vialRecipe(vial);
  const style: CSSProperties = {
    background: shadeColor(level),
    color: done ? 'var(--text)' : shadeInk(level),
    boxShadow: rings.length ? rings.join(', ') : 'none',
  };
  const body = (
    <>
      <span className="flex items-start justify-between gap-1.5">
        {done ? (
          <span aria-hidden="true" className="flex size-[30px] items-center justify-center rounded-full bg-mark text-ink">
            <Check size={16} />
          </span>
        ) : (
          <b className="text-[26px] leading-[30px] font-bold">{vial.id}</b>
        )}
        <span className="text-right text-[11px] leading-[13px] font-[650]" style={{ opacity: done ? 0.45 : 0.85 }}>
          {concentrationText(vial.concentration)}
          <br />
          <span className="text-[9px] font-semibold">µg/mL</span>
        </span>
      </span>
      <span className="text-[13px] leading-[17px] font-semibold" style={{ opacity: done ? 0.45 : 1 }}>
        {l1}
        <br />
        {l2}
      </span>
    </>
  );
  const box = 'box-border flex min-h-[118px] flex-col justify-between rounded-[18px] p-3 text-left';
  if (!onTap) return <li className={box} style={style}>{body}</li>;
  return (
    <li className="flex">
      <button
        type="button"
        onClick={onTap}
        aria-pressed={done}
        aria-label={`Vial ${vial.id}, ${concentrationText(vial.concentration)} µg/mL${done ? ', done' : state === 'now' ? ', now' : ''}`}
        className={cn(box, 'grow border-0 font-[inherit] transition-[box-shadow,color] duration-[250ms] outline-none focus-visible:outline-2 focus-visible:outline-blue')}
        style={style}
      >
        {body}
      </button>
    </li>
  );
}

export type VialRackProps = {
  vials: readonly StandardVial[];
  /** Ticked vials by id (Run-Standards). With ticks kept, the first unticked vial wears the yellow ring. */
  done?: Record<string, boolean>;
  /** The vial to make now, when it is not simply the first unticked one; null for none. */
  now?: string | null;
  /** Tap a vial to tick it (or untick it): the screen decides what that means. */
  onVial?: (id: string) => void;
  /** The vials are already made: each shows "Ready" and what the plate needs from it (µL). */
  ready?: { need: number };
  className?: string;
};

/** The rack, three across with 10 px gaps: Run-Standards, the Standards panel of Plan / Plan-Heard / Plan-Full, Standards-2. */
export function VialRack({ vials, done, now, onVial, ready, className }: VialRackProps) {
  const levels = shadeLevels(vials);
  const current = currentVial(vials, done, now);
  return (
    <ol aria-label={`Vials ${vials[0]?.id ?? ''} to ${vials.at(-1)?.id ?? ''}`} className={cn('m-0 grid list-none grid-cols-3 gap-2.5 p-0 tabular-nums', className)}>
      {vials.map((v, i) => (
        <VialCard
          key={v.id}
          vial={v}
          level={levels[i]!}
          state={done?.[v.id] ? 'done' : v.id === current ? 'now' : undefined}
          ready={ready}
          onTap={onVial && (() => onVial(v.id))}
        />
      ))}
    </ol>
  );
}

export type VialDotProps = {
  id: string;
  level: number;
  blank?: boolean;
  state?: VialState;
  /** 24 in the table, 56 for the vial being made with gloves on. */
  size?: 24 | 56;
  /** What is behind the dot, for the gap inside the yellow ring: white, or the table's yellow row. */
  ground?: string;
};

/** A vial as a round dot: a ticked one turns yellow with a check, the one now wears the yellow ring. */
export function VialDot({ id, level, blank, state, size = 24, ground = '#ffffff' }: VialDotProps) {
  const done = state === 'done';
  const big = size === 56;
  return (
    <span
      aria-hidden="true"
      className={cn('flex shrink-0 items-center justify-center rounded-full leading-none', big ? 'size-14 text-[28px] font-[800]' : 'size-6 text-[12px] font-bold')}
      style={{
        background: done ? 'var(--mark)' : shadeColor(level),
        color: done ? 'var(--ink)' : shadeInk(level),
        boxShadow: state === 'now' ? NOW_RING(ground, 4) : blank && !done ? BLANK_RING : 'none',
      }}
    >
      {done ? (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="m5 12 5 5 9-10" />
        </svg>
      ) : (
        id
      )}
    </span>
  );
}

/** The vial being made, with gloves on (Gloves-Standards): its 56 px dot and the two amounts in 28 px type. */
export function VialNow({ vial, level }: { vial: StandardVial; level: number }) {
  const [l1, l2] = vialSay(vial);
  const line = 'm-0 text-[28px] leading-[34px] font-[750] tracking-[-0.01em] text-ink tabular-nums';
  return (
    <div className="flex items-center gap-3.5 px-1">
      <VialDot id={vial.id} level={level} blank={vial.blank} state="now" size={56} />
      <span className="flex min-w-0 flex-col">
        <b className={line}>{l1}</b>
        <b className={line}>{l2}</b>
      </span>
    </div>
  );
}
