import * as AccordionPrimitive from '@radix-ui/react-accordion';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { Protocol } from '../../../shared/protocol.ts';
import { toMicroliters } from '../../../shared/calc.ts';
import { amountText, concentrationText, Mark, microliters, PlateMap, ReagentParts, VialRack } from '../../components/lab/index.ts';
import { cn } from '../../lib/cn.ts';
import { PlusIcon } from '../protocol/icons.tsx';
import { FlaskIcon, MinusIcon, PlateIcon, TubeIcon } from './icons.tsx';
import { repWord, type PlanKey, type PlanView, type Way } from './plan.ts';

export type Section = 'samples' | 'standards' | 'reagent' | 'plate';

const SHADOW = 'shadow-[0_1px_2px_rgba(17,17,19,0.06),0_2px_8px_rgba(17,17,19,0.04)]';

/** Plan.dc.html's four ways to make the standards; "Something else" is the run's fourth, five standards. */
export function waysFor(v: PlanView): { way: Way; label: string }[] {
  return [
    { way: 'kit', label: `Kit’s ${v.kitCount}` },
    { way: 'halve', label: `Halve from ${concentrationText(v.procedure.range.max)}` },
    { way: 'ready', label: 'Already made' },
    { way: 'five', label: 'Something else' },
  ];
}

/** The four ways as chips: the chosen one in ink. */
export function Ways({ v, value, onPick, className }: { v: PlanView; value: Way | null; onPick: (way: Way) => void; className?: string }) {
  return (
    <div role="radiogroup" aria-label="How to make the standards" className={cn('flex flex-wrap gap-2', className)}>
      {waysFor(v).map(w => {
        const on = w.way === value;
        return (
          <button
            key={w.way}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onPick(w.way)}
            className={cn(
              'min-h-11 rounded-[22px] px-4 text-[15px] leading-5 font-semibold outline-none focus-visible:ring-2 focus-visible:ring-blue',
              on ? 'bg-ink text-white' : cn('bg-white text-ink', SHADOW),
            )}
          >
            {w.label}
          </button>
        );
      })}
    </div>
  );
}

/** 1× 2× 3× on a grey track: the chosen one is a white pill. */
export function Replicates({ label, value, onChange }: { label: string; value: number; onChange: (k: number) => void }) {
  return (
    <div role="radiogroup" aria-label={label} className="grid grid-cols-3 rounded-[26px] bg-sunken p-1">
      {[1, 2, 3].map(k => {
        const on = k === value;
        return (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={['Single', 'Duplicate', 'Triplicate'][k - 1]}
            onClick={() => onChange(k)}
            className={cn(
              'min-h-11 rounded-[22px] p-0 text-[16px] leading-5 font-[650] tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-blue',
              on ? cn('bg-white text-ink', SHADOW) : 'bg-transparent text-text',
            )}
          >
            {k}×
          </button>
        );
      })}
    </div>
  );
}

export const ROUND = cn('flex size-11 items-center justify-center rounded-[22px] bg-white p-0 text-ink outline-none focus-visible:ring-2 focus-visible:ring-blue', SHADOW);
const NOTE = 'm-0 text-[15px] leading-[22px] text-text tabular-nums';
const PANEL = 'flex flex-col gap-3 pr-1 pb-[18px] pl-9';

type SectionsProps = {
  protocol: Protocol;
  v: PlanView;
  picked: boolean;
  open: Section | '';
  onOpen: (open: Section | '') => void;
  /** Wears the highlighter: one of these changed with the last thing said or tapped. */
  hl: (...keys: PlanKey[]) => boolean;
  onPick: (way: Way) => void;
  onSamples: (n: number) => void;
  onReplicates: (k: number) => void;
  onStandardReplicates: (k: number) => void;
};

/**
 * Samples, Standards, Working reagent, Plate: rows that open in place, a + turning into × (Plan.dc.html). Every
 * number is worked out from the run's plan (planFor); the rack, the reagent and the plate are the shared bench parts.
 */
export function Sections({ protocol, v, picked, open, onOpen, hl, onPick, onSamples, onReplicates, onStandardReplicates }: SectionsProps) {
  const { samples: n, replicates: nr, standardReplicates: sr, standards: way } = v.plan;
  const ready = way === 'ready';
  const mix = protocol.mixes.find(m => m.id === v.procedure.mix);
  const expected = mix?.notes?.find(x => x.kind === 'expected')?.text;
  const mixPerWell = microliters(toMicroliters(v.procedure.mixPerSample));
  const reagentName = v.reagent.name.toLowerCase();
  const fitsOneMore = n < v.max;

  return (
    <AccordionPrimitive.Root
      type="single"
      collapsible
      value={open}
      onValueChange={x => onOpen(x as Section | '')}
      className="flex shrink-0 flex-col border-b border-line"
    >
      <AccordionPrimitive.Item value="samples">
        <Trigger icon={<TubeIcon />} title="Samples" aside={`${n} · ×${nr}`} marked={hl('n', 'nr')} />
        <Content>
          <div className={PANEL}>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <p className="m-0 text-[13px] leading-[18px] font-semibold text-text">How many</p>
                <div className="grid grid-cols-[44px_minmax(0,1fr)_44px] items-center rounded-[26px] bg-sunken p-1">
                  <button type="button" aria-label="One sample fewer" onClick={() => onSamples(Math.max(1, n - 1))} className={ROUND}>
                    <MinusIcon />
                  </button>
                  <p aria-live="polite" className="m-0 text-center text-[20px] leading-6 font-bold text-ink tabular-nums">{n}</p>
                  <button type="button" aria-label="One sample more" aria-disabled={!fitsOneMore} onClick={() => fitsOneMore && onSamples(n + 1)} className={ROUND}>
                    <PlusIcon />
                  </button>
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <p className="m-0 text-[13px] leading-[18px] font-semibold text-text">Each</p>
                <Replicates label="Sample replicates" value={nr} onChange={onReplicates} />
              </div>
            </div>
            <p className={NOTE}>
              Up to {v.max} samples fit beside {v.beside}.
            </p>
          </div>
        </Content>
      </AccordionPrimitive.Item>

      <AccordionPrimitive.Item value="standards">
        <Trigger icon={<FlaskIcon />} title="Standards" aside={ready || !picked ? (picked ? v.wayName : 'Not set') : `${v.wayName} · ×${sr}`} marked={hl('way', 'S', 'sr')} />
        <Content>
          <div className={PANEL}>
            {!picked && <Ways v={v} value={null} onPick={onPick} />}
            {picked && (
              <>
                <div className="grid grid-cols-[minmax(0,1fr)_168px] items-center gap-3">
                  <p className="m-0 text-[13px] leading-[18px] font-semibold text-text">Each</p>
                  <Replicates label="Standard replicates" value={sr} onChange={onStandardReplicates} />
                </div>
                <VialRack vials={v.series.vials} ready={ready ? { need: v.series.need } : undefined} />
              </>
            )}
            {picked && !ready && (
              <p className={NOTE}>
                {/* The amounts open the Standards page: the same vials, with the bottles they come from. */}
                <Link to="/plan?state=standards" aria-label={`${amountText(v.series.stock)} ${v.stockName} and ${amountText(v.series.diluent)} diluent: what goes into the vials`} className="text-inherit no-underline">
                  <Mark on={hl('std')}>
                    {amountText(v.series.stock)} {v.stockName} and {amountText(v.series.diluent)} diluent
                  </Mark>
                </Link>
                . Each vial keeps at least {microliters(v.series.minLeft)} µL; the plate takes {microliters(v.series.need)} µL.
                {v.diluentNote && ` ${v.diluentNote}.`}
              </p>
            )}
            {picked && ready && <p className={NOTE}>I’ll plan for the kit’s {v.kitCount}. The run skips making them.</p>}
          </div>
        </Content>
      </AccordionPrimitive.Item>

      <AccordionPrimitive.Item value="reagent">
        <Trigger icon={<FlaskIcon />} title={v.reagent.name.charAt(0) + reagentName.slice(1)} aside={amountText(v.reagent.make)} marked={hl('wr')} />
        <Content>
          <div className={PANEL}>
            <ReagentParts plan={v.reagent} marked={hl('wr')} />
            <p className={NOTE}>
              It needs {(v.reagent.need / 1000).toFixed(1)} mL; {amountText(v.reagent.make)} leaves spare for the tips.{expected && ` ${expected}`}
            </p>
          </div>
        </Content>
      </AccordionPrimitive.Item>

      <AccordionPrimitive.Item value="plate">
        <Trigger icon={<PlateIcon />} title="Plate" aside={`${v.plate.wells} of ${v.plate.rows * v.plate.cols}`} marked={hl('wells')} />
        <Content>
          <div className={PANEL}>
            <PlateMap
              plan={v.plate}
              aria-label={`${v.plate.wells} wells: ${v.vials} standards ${repWord(sr)} and ${n} samples ${repWord(nr)}, replicates side by side`}
            />
            <p className={NOTE}>
              Replicates side by side, standards first. Sample 1 lands at {v.firstSample}. {microliters(v.perWell)} µL in each well, then {mixPerWell} µL of {reagentName}.
            </p>
          </div>
        </Content>
      </AccordionPrimitive.Item>
    </AccordionPrimitive.Root>
  );
}

function Trigger({ icon, title, aside, marked }: { icon: ReactNode; title: string; aside: string; marked: boolean }) {
  return (
    <AccordionPrimitive.Header className="flex flex-col">
      <AccordionPrimitive.Trigger className="group flex min-h-14 items-center gap-3 border-t border-line px-1 text-left text-ink outline-none focus-visible:bg-sunken">
        {icon}
        <span className="grow text-[17px] leading-[22px] font-semibold">{title}</span>
        <span className="text-[15px] leading-5 text-text">
          <Mark on={marked} className="-mx-1 px-1 tabular-nums">
            {aside}
          </Mark>
        </span>
        <PlusIcon className="shrink-0 transition-transform duration-200 group-data-[state=open]:rotate-45" />
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  );
}

function Content({ children }: { children: ReactNode }) {
  return (
    <AccordionPrimitive.Content className="overflow-hidden data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down">
      {children}
    </AccordionPrimitive.Content>
  );
}
