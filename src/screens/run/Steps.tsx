import { ReplyText, ReplySources } from '../../components/chapp/ReplyText.tsx';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Confirm } from '../../components/chapp/Confirm.tsx';
import { AmountCard, DoneAt, DotLabel, MarkChips, NumberedList, PlateMap, ReagentParts, SampleDataTag, StepList, Timer, VialRack, amountText, lengthText, stepDetail, type BenchStep, type StepItem, standardsOf } from '../../components/lab/index.ts';
import { cn } from '../../lib/cn.ts';
import { ERROR_LINE } from '../home/HomeCenter.tsx';
import { splitName } from '../protocol/content.ts';
import { currentTube, standardsLine, type Bench } from './model.ts';
import type { View } from './view.ts';
import { PlateCheckView, checkSay } from './PlateCheck.tsx';
import type { Exchange } from './voice.ts';

/**
 * The six steps as drawn with buttons (Run-Standards … Run-Read) and all the steps (Run-List). Every number comes from
 * the bench model (model.ts): the protocol's amounts sized to the plan.
 */

/**
 * Chapp's line at the top of a step (17 px, ink); `nums` lines up figures that count (Run-Standards, Run-Load). `aside`
 * sits to its right: the step's picture (Picture.tsx).
 */
export function Answer({ children, nums, aside, className }: { children: ReactNode; nums?: boolean; aside?: ReactNode; className?: string }) {
  const line = (
    <p aria-label="Chapp's answer" className={cn('m-0 px-1 text-[17px] leading-6 font-medium text-ink', aside ? 'min-w-0 flex-1' : 'mb-6 shrink-0', nums && 'tabular-nums', !aside && className)}>
      {children}
    </p>
  );
  if (!aside) return line;
  return (
    <div className={cn('mb-6 flex shrink-0 items-start gap-3', className)}>
      {line}
      {aside}
    </div>
  );
}

const B = ({ children }: { children: ReactNode }) => <b className="font-bold">{children}</b>;

/** What the user just said that Chapp acted on (Run-Standards: "● You said / C is OK."). */
export function YouSaid({ text }: { text: string }) {
  return (
    <div className="flex shrink-0 flex-col">
      <DotLabel className="mb-1.5 px-1">You said</DotLabel>
      <p className="m-0 mb-5 px-1 text-[20px] leading-[26px] font-bold text-ink">{/[.!?…]$/.test(text) ? text : `${text}.`}</p>
    </div>
  );
}

/** A question asked at the bench and Chapp's answer from the manual, with where it says so. */
export function Asked({ exchange, gloves }: { exchange: Exchange; gloves?: boolean }) {
  const answer = exchange.phase === 'error' ? exchange.error || ERROR_LINE : exchange.say || '';
  return (
    <div className="mb-6 flex shrink-0 flex-col">
      {gloves ? (
        <DotLabel size="md" className="mb-3.5 px-1">
          Heard “{exchange.ask}”
        </DotLabel>
      ) : (
        <>
          <DotLabel className="mb-1.5 px-1">{exchange.phase === 'reply' && exchange.done?.length ? 'You said' : 'You asked'}</DotLabel>
          <p className="m-0 mb-3 px-1 text-[20px] leading-[26px] font-bold text-ink">{exchange.ask}</p>
        </>
      )}
      {/* Always mounted, so screen readers announce the answer when it arrives. */}
      <div aria-live="polite" aria-label="Chapp's answer" className="m-0 px-1 text-[17px] leading-6 font-medium text-ink">
        {answer && <ReplyText text={answer} />}
        {exchange.phase === 'thinking' && (exchange.progress || !answer) && <span className={answer ? 'mt-2 block text-[13px] leading-[18px] text-muted' : 'text-muted'}>{exchange.progress || '…'}</span>}
      </div>
      {exchange.phase === 'reply' && exchange.done && (
        <ul aria-label="What Chapp changed" className="m-0 mt-3 flex list-none flex-col gap-1.5 p-0 px-1">
          {exchange.done.map((line, i) => (
            <li key={i} className="text-[15px] leading-[21px] font-semibold text-ink">
              {line}
            </li>
          ))}
        </ul>
      )}
      {exchange.phase === 'reply' && exchange.confirm && <Confirm actions={exchange.confirm} className="mt-3" />}
      {exchange.phase === 'reply' && <ReplySources sources={exchange.sources} className="px-1" />}
    </div>
  );
}

/** How the next step is named after "Next,": "the working reagent", "load the plate". */
export const nextPhrase = (s: BenchStep | undefined) => (!s ? '' : s.stage === 'mix' ? `the ${s.title.toLowerCase()}` : s.title.toLowerCase());

// ─── 1 Standards ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Run-Standards: Chapp says the vial to make; the rack ticks vial by vial (tap one, or say "C is OK"). */
export function StandardsStep({ v }: { v: View }) {
  const { series, ready, steps } = v.bench;
  const next = nextPhrase(steps[v.at + 1]);
  const line = standardsLine(series.vials, v.done);
  return (
    <>
      {ready ? (
        <Answer nums aside={v.picture?.small}>
          Your <B>{standardsOf(series.vials).length} standards</B> are already made. Next, {next}.
        </Answer>
      ) : line.kind === 'all' ? (
        <Answer nums aside={v.picture?.small}>
          All <B>{line.total} standards</B> are ready. Next, {next}.
        </Answer>
      ) : line.kind === 'last' ? (
        <Answer nums aside={v.picture?.small}>
          Last one, <B>{line.vial.id}</B>: <B>{line.say[0]}</B>
          {line.vial.blank ? <>, {line.say[1]}. That’s the blank.</> : <> and <B>{line.say[1]}</B>.</>}
        </Answer>
      ) : (
        <Answer nums aside={v.picture?.small}>
          <B>
            {line.done} of {line.total}
          </B>{' '}
          done. Next is <B>{line.vial.id}</B>: <B>{line.say[0]}</B> and <B>{line.say[1]}</B>.
        </Answer>
      )}
      <VialRack
        unit={series.unit} vials={series.vials}
        done={ready ? undefined : v.done}
        onVial={ready ? undefined : v.tickVial}
        ready={ready ? { need: series.need } : undefined}
        className="shrink-0"
      />
      <Bottles v={v} stage="standards" className="mt-7" />
    </>
  );
}

/**
 * The bottles a step pours from, with the user's own photos of them (STORYBOARD ⑤: step cards with the bottle
 * photos), as Standards-2 draws them. Shown once the kit has been photographed. The mix step has no need of them: its
 * picture plays with the user's bottles and the run's amounts on it.
 */
export function Bottles({ v, stage, className }: { v: View; stage: 'standards' | 'mix'; className?: string }) {
  const { p, bench } = v;
  const items =
    stage === 'standards'
      ? [
          ...p.components
            .filter(c => c.role === 'standard')
            .map(c => ({ c, detail: ['Stock', c.concentration && `${c.concentration.value.toLocaleString('en-US')} ${c.concentration.unit}`].filter(Boolean).join(' · '), amount: bench.series.stock })),
          ...p.components.filter(c => c.role === 'diluent').map(c => {
            const aside = splitName(c.name).aside;
            return { c, detail: aside ? `${aside[0]!.toUpperCase()}${aside.slice(1)}` : 'Diluent', amount: bench.series.diluent };
          }),
        ]
      : bench.reagent.parts.flatMap(x => {
          const c = p.components.find(k => k.id === x.component);
          return c ? [{ c, detail: `${x.parts} part${x.parts === 1 ? '' : 's'} of ${bench.reagent.ratio.replace(/ /g, '')}`, amount: x.volume }] : [];
        });
  if (!items.some(i => v.photos[i.c.id])) return null;
  return (
    <section aria-label="From your kit" className={cn('flex shrink-0 flex-col gap-2.5 tabular-nums', className)}>
      {items.map(({ c, detail, amount }) => (
        <AmountCard key={c.id} name={splitName(c.name).name} detail={detail} amount={amountText(amount)} photo={v.photos[c.id]} matched={!!v.photos[c.id]} />
      ))}
    </section>
  );
}

// ─── 2 Working reagent ───────────────────────────────────────────────────────────────────────────────────────────

/** "it keeps for several days at room temperature in a closed container", from the mix's own note. */
export function keepsFor(b: Bench, p: View['p']) {
  const note = p.mixes.find(m => m.id === b.reagent.mix)?.notes?.find(n => /^keeps\b/i.test(n.text));
  return note ? `it ${note.text[0]!.toLowerCase()}${note.text.slice(1).replace(/\.$/, '')}` : '';
}

/** Run-Mix: the step played with the user's own bottles, the amounts big on it; with the words on, how much to make, the parts in order, and why that much. */
export function MixStep({ v }: { v: View }) {
  const r = v.bench.reagent;
  const [open, setOpen] = useState(false);
  const keeps = keepsFor(v.bench, v.p);
  return (
    <>
      {v.picture?.big}
      {v.words && (
        <>
          <Answer>
            Make <B>{amountText(r.make)}</B> now{keeps ? `; ${keeps}` : ''}.
          </Answer>
          <ReagentParts plan={r} size="run" then={['Swirl until it is clear green']} note="Add B last. Cloudy, then green." className="mb-7 shrink-0" />
          <Why v={v} open={open} onOpen={setOpen} />
        </>
      )}
    </>
  );
}

/** Why that much working reagent: the wells times the volume, and what is left for what stays in the tips and the tube. */
function Why({ v, open, onOpen }: { v: View; open: boolean; onOpen: (open: boolean) => void }) {
  const r = v.bench.reagent;
  // Parts rounded for the pipette (A to 0.1 mL), shown against their exact share.
  const minor = r.parts.filter(x => amountText(x.volume) !== amountText(x.exact));
  return (
      <div className="flex shrink-0 flex-col border-b border-line">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => onOpen(!open)}
          className="flex min-h-14 items-center gap-3 border-0 border-t border-line bg-transparent px-1 text-left font-[inherit] text-ink outline-none focus-visible:outline-2 focus-visible:outline-blue"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#55555c" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M9 3h6" />
            <path d="M10 3v6l-5.5 9.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3" />
            <path d="M7 15h10" />
          </svg>
          <span className="grow text-[17px] leading-[22px] font-semibold">Why {amountText(r.make)}</span>
          <span className="text-[15px] leading-5 text-text tabular-nums">
            {r.wells} wells · {amountText(r.need)}
          </span>
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            aria-hidden="true"
            className="shrink-0 transition-transform duration-200"
            style={{ transform: `rotate(${open ? 45 : 0}deg)` }}
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
        {open && (
          <div className="flex flex-col gap-3 pr-1 pb-[18px] pl-9">
            <p className="m-0 text-[16px] leading-[22px] text-ink tabular-nums">
              {r.wells} wells × {amountText(r.perWell)} = {amountText(r.need)}. {amountText(r.make)} leaves {amountText(r.make - r.need)} for what stays in the tips and the tube.
            </p>
            {minor.length > 0 && (
              <p className="m-0 text-[15px] leading-[22px] text-text tabular-nums">
                {r.ratio} is {r.parts.map(x => amountText(x.exact)).join(' + ')}; {minor.map(x => amountText(x.volume)).join(' and ')} is close enough.
              </p>
            )}
          </div>
        )}
      </div>
  );
}

// ─── 3 Load the plate ────────────────────────────────────────────────────────────────────────────────────────────

/** Run-Load: tube by tube, where it goes on the plate. Tap the yellow wells (or say "next") for the next tube. */
export function LoadStep({ v }: { v: View }) {
  const { plate, load, add, reagent } = v.bench;
  const k = currentTube(plate, v.done);
  const t = plate.tubes[k];
  return (
    <>
      {t ? (
        <Answer nums aside={v.picture?.small}>
          <B>
            Tube {k + 1} of {plate.tubes.length}
          </B>
          . <B>{t.name}</B> →{' '}
          <b className={cn('rounded-[3px] px-0.5 font-bold whitespace-nowrap', v.flash ? 'bg-sample-bg' : 'bg-transparent')}>{t.wells.join(' · ')}</b>,{' '}
          {load} µL in each.
        </Answer>
      ) : (
        <Answer nums aside={v.picture?.small}>
          All <B>{plate.wells} wells</B> are loaded. Next, <B>{amountText(add.volume)}</B> of {reagent.name.toLowerCase()} into every well.
        </Answer>
      )}
      <PlateMap
        plan={plate}
        now={k}
        onTube={v.tapTube}
        aria-label={t ? `${t.name} goes into ${t.wells.join(' and ')}` : `All ${plate.wells} wells loaded`}
        className="shrink-0"
      />
    </>
  );
}

// ─── 4 Add the reagent ───────────────────────────────────────────────────────────────────────────────────────────

/** Run-Add: the reagent into every well, its volume big on the picture; with the words on, the shake and the cover too. */
export function AddStep({ v }: { v: View }) {
  const { add, plate, reagent, incubation } = v.bench;
  const items: ReactNode[] = [
    <>
      <B>{amountText(add.volume)}</B> {reagent.name.toLowerCase()} into all <B>{plate.wells} wells</B>
    </>,
  ];
  if (add.shake) items.push(<>Shake <B>{add.shake}</B></>);
  if (incubation?.covered) items.push('Cover the plate');
  return (
    <>
      {v.picture?.big}
      {v.words && (
        <>
          <Answer>Same order as you loaded, so every well gets the same time. Nothing to say per well.</Answer>
          <NumberedList aria-label="What to do" items={items} className="mb-7 shrink-0" />
        </>
      )}
    </>
  );
}

// ─── 5 Incubate ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Run-Incubate (choose the protocol's time or its alternative), then Run-Timer (running, stopped, done). */
export function IncubateStep({ v }: { v: View }) {
  const inc = v.bench.incubation;
  if (!inc) return <Answer>Nothing to time on this step.</Answer>;
  const temp = inc.temperature;
  const t = v.timer;
  const [first, ...alts] = inc.options;
  // A length of the user's own (a change they confirmed with Chapp): one more choice, the one chosen.
  const own = !inc.options.some(o => o.seconds === t.total);
  const choices = [...inc.options.map(o => ({ value: o.seconds, label: o.label })), ...(own ? [{ value: t.total, label: lengthText(t.total) }] : [])];
  if (t.phase === 'choose') {
    return (
      <>
        {v.picture?.big}
        {v.words && (
        <Answer>
          {temp && (
            <>
              <B>{temp}</B>.{' '}
            </>
          )}
          {own ? (
            <>
              <B>{lengthText(t.total)}</B> for this run, as you changed it; the manual says <B>{first!.label}</B>. Say “start” when the plate is in.
            </>
          ) : (
            <>
              <B>{first!.label}</B> is the standard.
            </>
          )}
          {own ? null : alts.length > 0 ? (
            <>
              {' '}
              <B>{alts.map(a => a.label).join(' or ')}</B> gives more signal and a lower floor; choose before I start the clock.
            </>
          ) : (
            ' Say “start” when the plate is in.'
          )}
        </Answer>
        )}
        <div className="mb-7 flex shrink-0 flex-col gap-3">
          {choices.length > 1 && <MarkChips aria-label="How long to incubate" options={choices} value={t.total} onChange={v.choose} />}
          <DoneAt seconds={t.total} marked={v.flash} />
        </div>
      </>
    );
  }
  const read = `${v.bench.readout.value} ${v.bench.readout.unit}`;
  return (
    <>
      <Timer
        total={t.total}
        endsAt={t.phase === 'stopped' ? null : t.endsAt}
        left={t.phase === 'stopped' ? t.left : null}
        label="Incubating"
        temperature={temp ?? undefined}
        onTap={t.phase === 'running' ? v.finish : undefined}
        className="mb-6 shrink-0"
      />
      {t.phase === 'running' && <LockScreenLine push={v.push} />}
      {t.phase === 'stopped' && <Answer>Stopped. Put it back, or read it as it is.</Answer>}
      {t.phase === 'done' && <Answer>Cool the plate to room temperature, then read.</Answer>}
      {t.phase === 'running' && (
        <div className="mt-8 flex shrink-0 flex-col gap-2 pl-1">
          <p className="m-0 text-[17px] leading-6 font-medium text-ink">
            Meanwhile: set the reader to <B>{read}</B> and rinse the tubes.
          </p>
        </div>
      )}
    </>
  );
}

// ─── 6 Read ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Run-Read: cool, read (the wavelength big on the reader; the words by choice), and hand Chapp the readings (the + at the bottom left: the export, or the sample one). */
export function ReadStep({ v }: { v: View }) {
  const read = `${v.bench.readout.value} ${v.bench.readout.unit}`;
  if (v.check) {
    return (
      <>
        <Answer>{checkSay(v.check.check, v.check.fit)}</Answer>
        <PlateCheckView check={v.check.check} fit={v.check.fit} wells={v.check.wells} onEdit={v.check.edit} onConfirm={v.check.confirm} onAgain={v.check.again} />
      </>
    );
  }
  return (
    <>
      {v.picture?.big}
      {v.words && (
        <>
          <Answer>
            Cool the plate to room temperature, then read every well at <B>{read}</B>.
          </Answer>
          <NumberedList
            aria-label="What to do"
            items={['Cool to room temperature', <>Read at <B>{read}</B></>, 'Give me the readings']}
            className="mb-7 shrink-0"
          />
        </>
      )}
      {v.reading ? (
        <p role="status" className="m-0 shrink-0 px-1 text-[17px] leading-6 font-medium text-ink">
          Reading <B>{v.reading}</B>…
        </p>
      ) : (
        <ReadingsIn v={v} />
      )}
    </>
  );
}

/**
 * Run-Timer's promise, "I will ping your lock screen when it is done", kept only where this browser can: otherwise one
 * short line says why not, in the step's own words, and where a tap can still allow it, a pill asks.
 */
export function LockScreenLine({ push, after = ' Cool the plate to room temperature before you read it.' }: { push: View['push']; after?: string }) {
  const line: Record<View['push']['state'], string> = {
    ready: 'I will ping your lock screen when it is done.',
    ask: 'Allow notifications and I will ping your lock screen when it is done.',
    'home-screen': 'Add Chapp to your Home Screen (Share, then Add to Home Screen) and I will ping your lock screen when it is done.',
    denied: 'Notifications are off for Chapp, so keep it open; I’ll ring here.',
    unsupported: 'This browser can’t ping your lock screen, so keep Chapp open; I’ll ring here.',
    failed: 'I couldn’t reach your lock screen, so keep Chapp open; I’ll ring here.',
  };
  return (
    <>
      <Answer className={push.state === 'ask' ? 'mb-3' : undefined}>
        {line[push.state]}
        {after}
      </Answer>
      {push.state === 'ask' && (
        <button
          type="button"
          onClick={push.enable}
          className="mb-6 ml-1 flex min-h-10 shrink-0 cursor-pointer items-center self-start rounded-[20px] border-0 bg-ink px-[18px] font-[inherit] text-[15px] leading-5 font-semibold text-white outline-none focus-visible:ring-2 focus-visible:ring-blue"
        >
          Allow notifications
        </button>
      )}
    </>
  );
}

/** Once readings are in: how many, "Sample data" when they are Chapp's example, and the way to the results. */
export function ReadingsIn({ v, className }: { v: View; className?: string }) {
  if (!v.readings.count) return null;
  return (
    <div className={cn('flex shrink-0 flex-col items-start gap-3 px-1', className)}>
      <p className="m-0 text-[17px] leading-6 font-medium text-ink tabular-nums">
        <B>{v.readings.count} readings</B> are in.
      </p>
      {v.readings.sample && <SampleDataTag />}
      <Link
        to="/results"
        className="flex min-h-10 items-center rounded-[20px] bg-ink px-[18px] text-[15px] leading-5 font-semibold text-white no-underline outline-none focus-visible:ring-2 focus-visible:ring-blue"
      >
        See the results
      </Link>
    </div>
  );
}

// ─── Moving through the steps ────────────────────────────────────────────────────────────────────────────────────

const NAV_PILL = 'flex min-h-10 cursor-pointer items-center rounded-[20px] border-0 px-[18px] font-[inherit] text-[15px] leading-5 font-semibold outline-none focus-visible:ring-2 focus-visible:ring-blue';
const NAV_WHITE = 'shrink-0 bg-white text-ink shadow-[0_1px_2px_rgba(17,17,19,0.06),0_2px_8px_rgba(17,17,19,0.04)]';

/**
 * Under a step, the buttons for what the voice does with "back" and "next": Back to the step before, Skip to the next
 * one with this one left unticked (All steps still shows it to do), and Next, this one ticked off; on the last step,
 * `last` (Finish) where the step has nothing of its own to end with. Not with gloves on: then the voice moves on.
 */
export function StepNav({ onBack, onSkip, next, last }: { onBack?: () => void; onSkip?: () => void; next?: { title: string; go: () => void }; last?: { label: string; go: () => void } }) {
  if (!onBack && !next && !last) return null;
  return (
    <nav aria-label="Move through the steps" className="mt-auto flex shrink-0 items-center gap-2 px-1 pt-2">
      {onBack && (
        <button type="button" onClick={onBack} className={cn(NAV_PILL, NAV_WHITE)}>
          Back
        </button>
      )}
      {next && onSkip && (
        <button type="button" onClick={onSkip} className={cn(NAV_PILL, NAV_WHITE)}>
          Skip
        </button>
      )}
      {next ? (
        <button type="button" onClick={next.go} className={cn(NAV_PILL, 'min-w-0 bg-ink text-white')}>
          <span className="truncate">Next · {next.title}</span>
        </button>
      ) : last ? (
        <button type="button" onClick={last.go} className={cn(NAV_PILL, 'shrink-0 bg-ink text-white')}>
          {last.label}
        </button>
      ) : null}
    </nav>
  );
}

// ─── All the steps ───────────────────────────────────────────────────────────────────────────────────────────────

/** Run-List: every step with what it takes; tap one to go there. */
export function AllSteps({ v, search }: { v: View; search: string }) {
  const { p, bench } = v;
  const loaded = currentTube(bench.plate, v.done);
  const items: StepItem[] = bench.steps.map((s, i) => {
    const loading = s.step.add?.some(a => a.what === 'standards-and-samples');
    let detail = stepDetail(p, s, {
      vials: bench.series.vials.length,
      reagent: bench.reagent.make,
      tubes: bench.plate.tubes.length,
      loaded: loading && (i === v.at || (loaded > 0 && loaded < bench.plate.tubes.length)) ? loaded : undefined,
    });
    if (s.id === bench.incubation?.id) detail = [bench.incubation.temperature, lengthText(v.timer.total)].filter(Boolean).join(' · ');
    // Standards already made (Plan's "Already made") count as done.
    const finished = v.done[s.id] || (bench.ready && s.stage === 'standards');
    return { title: s.title, detail, state: i === v.at ? 'now' : finished ? 'done' : 'next', to: `/run/${i + 1}${search}` };
  });
  return (
    <>
      <Answer>
        Step{' '}
        <B>
          {v.at + 1} of {bench.steps.length}
        </B>
        .
      </Answer>
      <StepList aria-label={`All ${bench.steps.length} steps`} steps={items} className="mb-7 shrink-0" />
    </>
  );
}
