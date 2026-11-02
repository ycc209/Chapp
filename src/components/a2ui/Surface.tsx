import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { componentsOf, isBinding, type A2uiComponent, type A2uiMessage, type AskField, type Choice } from '../../../shared/a2ui.ts';
import type { Protocol } from '../../../shared/protocol.ts';
import { cn } from '../../lib/cn.ts';
import { PILL, WHITE_PILL } from '../../screens/plan/Shell.tsx';
import { MinusIcon } from '../../screens/plan/icons.tsx';
import { maxSamples } from '../../screens/plan/plan.ts';
import { Replicates, ROUND } from '../../screens/plan/Sections.tsx';
import { procedureFor, stepFacts } from '../../screens/protocol/content.ts';
import { PlusIcon } from '../../screens/protocol/icons.tsx';
import { useRun, type RunState } from '../../state/run.ts';
import { useShown } from '../../state/shown.ts';
import { PlateMap, ReagentParts, StandardsTable } from '../lab/index.ts';
import { amountText, lengthText, runSetup, type RunPlan } from '../lab/model.ts';
import { useBench } from '../../screens/run/bench.ts';
import { dataModel, resolve, volumeIn, type DataModel } from './data.ts';

type SurfaceProps = {
  messages: readonly A2uiMessage[];
  /** The kit open in the run; without one only words and choices are drawn. */
  protocol: Protocol | null;
  /** The latest answer: its choices, questions and cards can be used. Older ones show what was picked. */
  live?: boolean;
  /** Sends what the user picked or answered as the next thing they say. */
  onAnswer?: (text: string) => void;
  /** What the user asked, so an answer goes back in their language. */
  ask?: string;
  className?: string;
};

/**
 * Chapp's own A2UI v0.9 renderer: the surface Muse Spark wrote under its answer (shared/a2ui.ts, already checked by the
 * server), drawn with the app's parts and tokens. The data model is the app's: filled from the protocol and the run's
 * plan (data.ts), or the samples and replicates a Chapp card names ("what if 30 samples"). Basic components: Column,
 * Row, List, Card, Text (h3, body, caption), Divider, ChoicePicker (a tap answers). Chapp's: ReagentCard, PlateCard,
 * StandardsCard, StepCard, TimerCard, Compare, Ask. Anything else, or anything bound to a value the plan does not have,
 * is not drawn. On the latest answer the user can change a card's samples and replicates (what they ask next is about
 * that card, useShown) and use that plan for the run.
 */
export function A2uiSurface({ messages, protocol, live = false, onAnswer, ask = '', className }: SurfaceProps) {
  const run = useRun();
  const [edit, setEdit] = useState<Edit | null>(null);
  const plan: RunPlan = {
    procedure: run.procedure,
    samples: run.samples,
    replicates: run.replicates,
    standardReplicates: run.standardReplicates,
    standards: run.standards,
    edits: run.edits,
  };
  const components = useMemo(() => componentsOf(messages), [messages]);
  const model = useMemo(() => (protocol ? dataModel(protocol, plan) : EMPTY), [protocol, plan.procedure, plan.samples, plan.replicates, plan.standardReplicates, plan.standards, plan.edits]);
  const root = components.get('root');
  if (!root || (!protocol && CHAPP_CARDS.has(root.component))) return null;
  // A surface that is not a card of its own sits in one, like every card under an answer.
  const framed = root.component === 'Card' || CHAPP_CARDS.has(root.component);
  const answer = live ? onAnswer : undefined;
  const zh = /[㐀-鿿]/.test(ask);
  // Plan cards share one plan the user may change, with its controls under the last of them.
  const controlsAt = [...components.values()].filter(c => PLAN_CARDS.has(c.component)).at(-1)?.id;
  return (
    <Ctx.Provider value={{ components, protocol, plan, model, inCard: !framed, answer, zh, edit, setEdit, controlsAt }}>
      <div aria-label="Chapp's card" className={cn('mt-4 flex flex-col animate-in fade-in duration-300', className)}>
        {framed ? <Node id="root" path={[]} /> : <section className={FRAME}><Node id="root" path={[]} /></section>}
      </div>
    </Ctx.Provider>
  );
}

const FRAME = 'flex flex-col gap-2.5 rounded-[20px] bg-card p-4 shadow-[0_0_0_1px_rgba(17,17,19,0.05),0_4px_16px_rgba(17,17,19,0.06)]';
const CHAPP_CARDS = new Set(['ReagentCard', 'PlateCard', 'StandardsCard', 'StepCard', 'TimerCard', 'Compare', 'Ask']);
const EMPTY: DataModel = { plan: { samples: '', replicates: '' }, steps: {} };
/** The cards drawn for a plan, whose samples and replicates the user may change. */
const PLAN_CARDS = new Set(['ReagentCard', 'PlateCard', 'Compare']);
type Edit = { samples: number; replicates: number; standardReplicates: number };

type Scope = {
  components: Map<string, A2uiComponent>;
  protocol: Protocol | null;
  plan: RunPlan;
  model: DataModel;
  inCard: boolean;
  /** Set on the latest answer only: sends a pick or an answer as what the user says next. */
  answer?: (text: string) => void;
  /** The user asked in Chinese: an answer sent for them is in Chinese too. */
  zh: boolean;
  /** The plan the user changed on these cards, shared by all of them; the controls sit under the card `controlsAt`. */
  edit: Edit | null;
  setEdit: (edit: Edit) => void;
  controlsAt?: string;
};
const Ctx = createContext<Scope | null>(null);
const useScope = () => useContext(Ctx)!;

const TEXT: Record<string, string> = {
  h3: 'text-[17px] leading-[22px] font-semibold text-ink',
  body: 'text-[15px] leading-[21px] text-ink',
  caption: 'text-[13px] leading-[18px] text-text',
};
const JUSTIFY: Record<string, string> = {
  start: 'justify-start', center: 'justify-center', end: 'justify-end', spaceBetween: 'justify-between', spaceAround: 'justify-around', spaceEvenly: 'justify-evenly',
};
const ALIGN: Record<string, string> = { start: 'items-start', center: 'items-center', end: 'items-end', stretch: 'items-stretch', baseline: 'items-baseline' };

/** One component by id; `path` is the ids above it, so a loop is never followed. */
function Node({ id, path }: { id: string; path: string[] }) {
  const scope = useScope();
  const c = scope.components.get(id);
  if (!c || path.includes(id)) return null;
  const below = [...path, id];
  const kids = (Array.isArray(c.children) ? (c.children as string[]) : []).map(ref => <Node key={ref} id={ref} path={below} />);
  switch (c.component) {
    case 'Column':
    case 'List':
      return <div className={cn('flex flex-col', c.component === 'List' ? 'gap-1.5' : 'gap-2', ALIGN[String(c.align)], JUSTIFY[String(c.justify)])}>{kids}</div>;
    case 'Row':
      // Chapp's rows read as a name and its value: spread to the edges unless the model says otherwise.
      return <div className={cn('flex flex-wrap gap-x-3 gap-y-1', JUSTIFY[String(c.justify)] ?? 'justify-between', ALIGN[String(c.align)] ?? 'items-baseline')}>{kids}</div>;
    case 'Card':
      return (
        <Ctx.Provider value={{ ...scope, inCard: true }}>
          <section className={FRAME}>{typeof c.child === 'string' && <Node id={c.child} path={below} />}</section>
        </Ctx.Provider>
      );
    case 'Divider':
      return <hr className="m-0 border-0 border-t border-line" />;
    case 'ChoicePicker':
      return <ChoicePicker c={c} />;
    case 'Text': {
      const text = resolve(c.text, scope.model);
      if (typeof text !== 'string' || !text) return null;
      return <p className={cn('m-0', TEXT[String(c.variant)] ?? TEXT.body, isBinding(c.text) && 'font-semibold tabular-nums')}>{text}</p>;
    }
    case 'ReagentCard':
    case 'PlateCard':
    case 'StandardsCard':
      return scope.protocol ? <RunCard c={c} /> : null;
    case 'StepCard':
    case 'TimerCard':
      return scope.protocol ? <StepOrTimer c={c} /> : null;
    case 'Compare':
      return scope.protocol ? <Compare c={c} /> : null;
    case 'Ask':
      return scope.protocol ? <Ask c={c} /> : null;
  }
  return null;
}

/** A Chapp card: in a frame of its own, or bare inside the model's Card. */
function Frame({ label, aside, children }: { label: string; aside?: string; children: ReactNode }) {
  const { inCard } = useScope();
  const head = (
    <div className="flex items-baseline justify-between gap-3">
      <h3 className="m-0 text-[13px] leading-[18px] font-semibold text-text">{label}</h3>
      {aside && <span className="text-[13px] leading-[18px] text-text tabular-nums">{aside}</span>}
    </div>
  );
  return inCard ? (
    <div className="flex flex-col gap-2">
      {head}
      {children}
    </div>
  ) : (
    <section className={cn(FRAME, 'gap-2')}>
      {head}
      {children}
    </section>
  );
}

/** The plan a Chapp card shows: the run's, or the samples and replicates it names. */
function planOf(c: A2uiComponent, plan: RunPlan): RunPlan {
  const samples = typeof c.samples === 'number' ? c.samples : plan.samples;
  const replicates = typeof c.replicates === 'number' ? c.replicates : plan.replicates;
  return { ...plan, samples, replicates, standardReplicates: typeof c.standardReplicates === 'number' ? c.standardReplicates : plan.standardReplicates };
}

/**
 * A card's plan, which the user may change on the latest answer: the samples and replicates it shows, what the next
 * question is about (useShown), and a way to make it the run's plan.
 */
function useCardPlan(c: A2uiComponent) {
  const { plan: run, answer, edit, setEdit, controlsAt } = useScope();
  const base = planOf(c, run);
  const plan: RunPlan = edit ? { ...base, ...edit } : base;
  const change = (next: Edit) => {
    setEdit(next);
    useShown.getState().set(next);
  };
  return { plan, editable: Boolean(answer) && c.id === controlsAt, change, differs: plan.samples !== run.samples || plan.replicates !== run.replicates || plan.standardReplicates !== run.standardReplicates };
}

/** Under a card the user may change: its samples and replicates, and "Use this plan" when they are not the run's. */
function PlanControls({ plan, differs, onChange }: { plan: RunPlan; differs: boolean; onChange: (p: Edit) => void }) {
  const { protocol, zh } = useScope();
  const [used, setUsed] = useState(false);
  let max = 96;
  try {
    max = protocol ? maxSamples(protocol, plan.procedure, plan) : 96;
  } catch {
    // A kit with no plate: the card says so.
  }
  const use = () => {
    useRun.getState().setPlan({ samples: plan.samples, replicates: plan.replicates, standardReplicates: plan.standardReplicates });
    useShown.getState().clear();
    setUsed(true);
  };
  return (
    <div className="mt-1 flex flex-col gap-2.5 border-t border-line pt-3">
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-2">
        <Stepper label="Samples" value={plan.samples} min={1} max={max} onChange={samples => onChange({ samples, replicates: plan.replicates, standardReplicates: plan.standardReplicates })} />
        <Replicates label="Sample replicates" value={Math.min(3, plan.replicates)} onChange={replicates => onChange({ samples: plan.samples, replicates, standardReplicates: plan.standardReplicates })} />
      </div>
      {differs && !used && (
        <button type="button" onClick={use} className={cn(PILL, 'self-start bg-ink px-[18px] text-white')}>
          {zh ? '用這個計畫' : 'Use this plan'}
        </button>
      )}
      {used && <p className="m-0 text-[13px] leading-[18px] font-medium text-text">{zh ? '這次實驗改用這個計畫了。' : 'This is the run’s plan now.'}</p>}
    </div>
  );
}

/** − 12 +: a count the user nudges by one. */
function Stepper({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (n: number) => void }) {
  return (
    <div role="group" aria-label={label} className="grid grid-cols-[44px_minmax(0,1fr)_44px] items-center rounded-[26px] bg-sunken p-1">
      <button type="button" aria-label={`One fewer: ${label.toLowerCase()}`} aria-disabled={value <= min} onClick={() => value > min && onChange(value - 1)} className={ROUND}>
        <MinusIcon />
      </button>
      <p aria-live="polite" className="m-0 text-center text-[20px] leading-6 font-bold text-ink tabular-nums">{value}</p>
      <button type="button" aria-label={`One more: ${label.toLowerCase()}`} aria-disabled={value >= max} onClick={() => value < max && onChange(value + 1)} className={ROUND}>
        <PlusIcon />
      </button>
    </div>
  );
}

/** ReagentCard, PlateCard, StandardsCard: the run's working reagent, plate or dilution table, as Plan draws them. */
function RunCard({ c }: { c: A2uiComponent }) {
  const { protocol } = useScope();
  const { plan, editable, change, differs } = useCardPlan(c);
  let setup: ReturnType<typeof runSetup>;
  try {
    setup = runSetup(protocol!, plan);
  } catch {
    return null; // A plan the kit can't make (too many wells, a kit with no plate): the answer says why.
  }
  const forWhat = `${plan.samples} samples × ${plan.replicates}`;
  const controls = editable ? <PlanControls plan={plan} differs={differs} onChange={change} /> : null;
  if (c.component === 'ReagentCard')
    return (
      <Frame label={`Working reagent · ${amountText(setup.reagent.make)}`} aside={forWhat}>
        <ReagentParts plan={setup.reagent} />
        {controls}
      </Frame>
    );
  if (c.component === 'PlateCard')
    return (
      <Frame label={`Plate · ${setup.plate.wells} wells`} aside={forWhat}>
        <PlateMap plan={setup.plate} />
        {controls}
      </Frame>
    );
  return (
    <Frame label={`Standards · ${setup.series.vials.length} vials`} aside={`×${plan.standardReplicates}`}>
      <StandardsTable unit={setup.series.unit} vials={setup.series.vials} />
    </Frame>
  );
}

/** StepCard: one step, its numbers and what to do. TimerCard: a timed step's time, big, with its temperature. */
function StepOrTimer({ c }: { c: A2uiComponent }) {
  const { protocol: open, plan } = useScope();
  // This run's own length for the step, where the user changed it (Run's choice, or a confirmed proposal).
  const own = useBench(s => (typeof c.stepId === 'string' ? s.lengths[c.stepId] : undefined));
  const protocol = open!;
  const all = procedureFor(protocol, plan.procedure).steps;
  const step = all.find(s => s.id === c.stepId);
  if (!step) return null;
  // Numbered as Run numbers them: the bench's steps, without the analysis that follows the run.
  const steps = all.filter(s => s.stage !== 'analyze');
  const n = steps.indexOf(step);
  if (c.component === 'TimerCard' && step.timer) {
    const t = step.timer;
    const manual = t.duration.value * { s: 1, min: 60, h: 3600 }[t.duration.unit];
    const changed = own !== undefined && own !== manual;
    return (
      <Frame label={`Step ${n + 1} · ${t.label}`} aside={changed ? `The manual: ${t.duration.value} ${t.duration.unit}` : undefined}>
        <span className="text-[40px] leading-[44px] font-semibold text-ink tabular-nums">{changed ? lengthText(own) : `${t.duration.value} ${t.duration.unit}`}</span>
        <span className="text-[15px] leading-5 text-text">
          {[...(changed ? ['This run'] : []), ...stepFacts(protocol, step).filter(f => !f.endsWith(` ${t.duration.unit}`))].join(' · ')}
        </span>
      </Frame>
    );
  }
  return (
    <Frame label={n >= 0 ? `Step ${n + 1} of ${steps.length}` : 'After the run'}>
      <span className="text-[17px] leading-[22px] font-semibold text-ink">{step.title}</span>
      <span className="text-[14px] leading-[19px] text-ink">{stepFacts(protocol, step).join(' · ')}</span>
      <span className="text-[14px] leading-[20px] text-text">{step.key}</span>
    </Frame>
  );
}

/** What each volume is called when a Compare weighs it. */
const NEEDS: Record<string, string> = {
  '/reagent/make': 'Working reagent to make',
  '/reagent/need': 'Working reagent the plate uses',
  '/reagent/partA': 'Reagent A',
  '/reagent/partB': 'Reagent B',
  '/standards/stock': 'Standard stock',
  '/standards/diluent': 'Diluent',
};

/** Compare: what the plan needs (bound) against what the user says they have, judged here ("Short by 5 mL"). */
function Compare({ c }: { c: A2uiComponent }) {
  const { protocol } = useScope();
  const { plan, editable, change, differs } = useCardPlan(c);
  const model = dataModel(protocol!, plan);
  const need = resolve(c.need, model);
  const needUl = typeof need === 'string' ? volumeIn(need) : null;
  const haveUl = typeof c.have === 'string' ? volumeIn(c.have) : null;
  if (typeof need !== 'string' || needUl === null || haveUl === null || !isBinding(c.need)) return null;
  const gap = haveUl - needUl;
  return (
    <Frame label={NEEDS[c.need.path] ?? 'What you need'} aside={typeof c.samples === 'number' || typeof c.replicates === 'number' || differs ? `${plan.samples} samples × ${plan.replicates}` : undefined}>
      <div className="flex items-baseline justify-between text-[15px] leading-5">
        <span className="text-text">You need</span>
        <span className="font-semibold text-ink tabular-nums">{need}</span>
      </div>
      <div className="flex items-baseline justify-between text-[15px] leading-5">
        <span className="text-text">You have</span>
        <span className="font-semibold text-ink tabular-nums">{amountText(haveUl)}</span>
      </div>
      <span className={cn('self-start rounded-full px-2.5 py-1 text-[13px] leading-4 font-semibold', gap >= 0 ? 'bg-expected-bg text-expected' : 'bg-caution-bg text-caution')}>
        {gap >= 0 ? `Enough, ${amountText(gap)} to spare` : `Short by ${amountText(-gap)}`}
      </span>
      {editable && <PlanControls plan={plan} differs={differs} onChange={change} />}
    </Frame>
  );
}

/** ChoicePicker: what the user may pick, as buttons; a tap answers with that label. */
function ChoicePicker({ c }: { c: A2uiComponent }) {
  const { answer } = useScope();
  const [picked, setPicked] = useState<string | null>(null);
  const options = (Array.isArray(c.options) ? c.options : []) as Choice[];
  if (options.length < 2) return null;
  return (
    <div role="group" aria-label="Pick one" className="flex flex-wrap gap-2">
      {options.map(o => {
        const on = picked === o.label;
        return (
          <button
            key={o.label}
            type="button"
            disabled={!answer || picked !== null}
            onClick={() => {
              setPicked(o.label);
              answer?.(o.label);
            }}
            className={cn(PILL, 'px-[18px] disabled:cursor-default', on ? 'bg-ink text-white' : WHITE_PILL, picked !== null && !on && 'opacity-45')}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** How the standards can be made (RunState.standards), as Plan names them. */
const WAYS: { way: RunState['standards']; en: string; zh: string }[] = [
  { way: 'kit', en: 'The kit’s table', zh: '說明書的稀釋表' },
  { way: 'halve', en: 'Halving', zh: '對半稀釋' },
  { way: 'five', en: 'Five standards', zh: '五個標準品' },
  { way: 'ready', en: 'Already made', zh: '已經做好了' },
];

/**
 * Ask: Chapp's questions about the plan, each filled in with this run's value, so Continue works right away. Continue
 * makes it the run's plan (the user's own tap) and says it, so Chapp goes on from there.
 */
function Ask({ c }: { c: A2uiComponent }) {
  const { protocol, plan: run, answer, zh } = useScope();
  const fields = (Array.isArray(c.fields) ? c.fields : []) as AskField[];
  const [samples, setSamples] = useState(run.samples);
  const [replicates, setReplicates] = useState(Math.min(3, run.replicates));
  const [standards, setStandards] = useState(run.standards);
  const [sent, setSent] = useState(false);
  let max = 96;
  try {
    max = maxSamples(protocol!, run.procedure, { ...run, replicates, standards });
  } catch {
    // A kit with no plate: Chapp says so.
  }
  const go = () => {
    const plan: Partial<RunState> = {};
    const said: string[] = [];
    if (fields.includes('samples')) {
      plan.samples = Math.min(samples, max);
      said.push(zh ? `${plan.samples} 個樣本` : `${plan.samples} samples`);
    }
    if (fields.includes('replicates')) {
      plan.replicates = replicates;
      said.push(zh ? `樣本${['單次', '二重複', '三重複'][replicates - 1]}，標準品維持 ${run.standardReplicates} 次` : `samples ${['once each', 'in duplicate', 'in triplicate'][replicates - 1]}, keeping standards at ${run.standardReplicates} replicates`);
    }
    if (fields.includes('standards')) {
      plan.standards = standards;
      const way = WAYS.find(w => w.way === standards)!;
      said.push(zh ? `標準品：${way.zh}` : `standards: ${way.en.toLowerCase()}`);
    }
    useRun.getState().setPlan(plan);
    setSent(true);
    const text = said.join(zh ? '，' : ', ');
    answer?.(zh ? `${text}。` : `${text[0]!.toUpperCase()}${text.slice(1)}.`);
  };
  const off = !answer || sent;
  return (
    <Frame label={zh ? '先確認一下' : 'A few things first'}>
      <fieldset disabled={off} className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
        {fields.includes('samples') && (
          <Field label={zh ? '樣本數' : 'Samples'}>
            <Stepper label="Samples" value={Math.min(samples, max)} min={1} max={max} onChange={setSamples} />
          </Field>
        )}
        {fields.includes('replicates') && (
          <Field label={zh ? '每個樣本做幾次' : 'Each sample'}>
            <Replicates label="Replicates" value={replicates} onChange={setReplicates} />
          </Field>
        )}
        {fields.includes('standards') && (
          <Field label={zh ? '標準品' : 'Standards'}>
            <div role="radiogroup" aria-label="Standards" className="flex flex-wrap gap-2">
              {WAYS.map(w => (
                <button
                  key={w.way}
                  type="button"
                  role="radio"
                  aria-checked={standards === w.way}
                  onClick={() => setStandards(w.way)}
                  className={cn(PILL, 'px-4 text-[14px]', standards === w.way ? 'bg-ink text-white' : WHITE_PILL)}
                >
                  {zh ? w.zh : w.en}
                </button>
              ))}
            </div>
          </Field>
        )}
      </fieldset>
      {!sent ? (
        <button type="button" disabled={off} onClick={go} className={cn(PILL, 'mt-1 self-start bg-ink px-[18px] text-white disabled:opacity-45')}>
          {zh ? '繼續' : 'Continue'}
        </button>
      ) : (
        <p className="m-0 text-[13px] leading-[18px] font-medium text-text">{zh ? '這次實驗用這些了。' : 'The run uses these now.'}</p>
      )}
    </Frame>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="m-0 text-[13px] leading-[18px] font-semibold text-text">{label}</p>
      {children}
    </div>
  );
}
