import type { ReactNode } from 'react';
import { BenchLine, DoneAt, PlateMap, ReagentParts, StandardsTable, Timer, VialNow, amountText, shadeLevels } from '../../components/lab/index.ts';
import { Waveform } from '../../components/voice/Waveform.tsx';
import { cn } from '../../lib/cn.ts';
import { currentTube, standardsLine } from './model.ts';
import { ReadingsIn, keepsFor } from './Steps.tsx';
import type { View } from './view.ts';
import { PlateCheckView, checkSay } from './PlateCheck.tsx';

/**
 * The same six steps with gloves on (Gloves-*.dc.html): Chapp keeps listening, so there are no buttons to aim for;
 * the instruction is big enough to read from arm's length and the rest of the step stays in view below it.
 */

const B = ({ children }: { children: ReactNode }) => <b className="font-bold">{children}</b>;

/** Chapp's line, 17 px, no space under it (the gloves layouts space their blocks with margins on the next one). */
function Say({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p aria-label="Chapp's answer" className={cn('m-0 px-1 text-[17px] leading-6 font-medium text-ink', className)}>
      {children}
    </p>
  );
}

/** A small label over a big line: "Incubate at", "Read at". */
const Over = ({ children }: { children: ReactNode }) => <p className="m-0 mb-1 text-[15px] leading-5 font-semibold text-text">{children}</p>;

/** Gloves-Standards: the vial now in big type, the whole table under it. */
export function GlovesStandards({ v }: { v: View }) {
  const { series, ready } = v.bench;
  const line = standardsLine(series.vials, v.done);
  const levels = shadeLevels(series.vials);
  return (
    <div className="flex shrink-0 flex-col">
      {ready ? (
        <BenchLine size="md" className="px-1">Your {series.vials.length} standards are already made.</BenchLine>
      ) : line.kind === 'all' ? (
        <BenchLine size="md" className="px-1">All {line.total} standards are ready.</BenchLine>
      ) : (
        <VialNow vial={line.vial} level={levels[series.vials.indexOf(line.vial)]!} />
      )}
      <StandardsTable vials={series.vials} done={ready ? Object.fromEntries(series.vials.map(x => [x.id, true])) : v.done} className="mt-5" />
    </div>
  );
}

/** Gloves-Mix: how much to make, then the two amounts in big type. */
export function GlovesMix({ v }: { v: View }) {
  const r = v.bench.reagent;
  // Read from arm's length: the keeping note without its fine print ("in a closed container").
  const keeps = keepsFor(v.bench, v.p).replace(/\s+in an? [^,.]+$/, '');
  return (
    <div className="flex shrink-0 flex-col">
      <Say>
        Make <B>{amountText(r.make)}</B> of {r.name.toLowerCase()}.{keeps ? ` ${keeps[0]!.toUpperCase()}${keeps.slice(1)}.` : ''}
      </Say>
      <ReagentParts plan={r} size="gloves" note="Add B last. Swirl until it is clear green." className="mt-5" />
    </div>
  );
}

/** Gloves-Load: the tube now, where it goes in big type, and the plate filling up. */
export function GlovesLoad({ v }: { v: View }) {
  const { plate, load } = v.bench;
  const k = currentTube(plate, v.done);
  const t = plate.tubes[k];
  return (
    <div className="flex shrink-0 flex-col">
      {t ? (
        <div className="flex flex-col px-1">
          <Over>
            Tube {k + 1} of {plate.tubes.length} · {load} µL in each
          </Over>
          <BenchLine size="lg">{t.name}</BenchLine>
          <BenchLine size="xl" className="mt-0.5">
            <span className="-mx-1.5 rounded-[8px] bg-sample-bg px-1.5">{t.wells.join(' · ')}</span>
          </BenchLine>
        </div>
      ) : (
        <BenchLine size="lg" className="px-1">All {plate.wells} wells are loaded.</BenchLine>
      )}
      <PlateMap plan={plate} now={k} dense aria-label={t ? `${t.name} goes into ${t.wells.join(' and ')}` : `All ${plate.wells} wells loaded`} className="mt-[22px]" />
    </div>
  );
}

/** Gloves-Add: the reagent into every well, then shake and cover. */
export function GlovesAdd({ v }: { v: View }) {
  const { add, plate, incubation } = v.bench;
  const then = [add.shake && <>shake <B>{add.shake}</B></>, incubation?.covered && 'cover the plate'].filter(Boolean);
  return (
    <div className="flex shrink-0 flex-col">
      <Say>Same order as you loaded, so every well gets the same time.</Say>
      <div className="mt-5 flex flex-col px-1">
        <BenchLine className="font-medium">
          <b className="font-[750]">{amountText(add.volume)}</b> into all <b className="font-[750]">{plate.wells}&nbsp;wells</b>
        </BenchLine>
        {then.length > 0 && (
          <p className="m-0 mt-3.5 text-[20px] leading-7 font-medium text-ink">
            Then {then.map((x, i) => (
              <span key={i}>
                {i > 0 && ' and '}
                {x}
              </span>
            ))}
            .
          </p>
        )}
      </div>
    </div>
  );
}

/** Gloves-Incubate, then Gloves-Timer: the temperature and time in big type, then the clock itself. */
export function GlovesIncubate({ v }: { v: View }) {
  const inc = v.bench.incubation;
  const t = v.timer;
  if (!inc) return <Say>Nothing to time on this step.</Say>;
  const read = `${v.bench.readout.value} ${v.bench.readout.unit}`;
  if (t.phase === 'choose') {
    const [first, ...alts] = inc.options;
    const chosen = inc.options.find(o => o.seconds === t.total) ?? first!;
    return (
      <div className="flex shrink-0 flex-col">
        <div className="flex flex-col px-1">
          <Over>Incubate at</Over>
          <BenchLine size="xl">{[inc.temperature, chosen.label].filter(Boolean).join(' · ')}</BenchLine>
          <DoneAt seconds={t.total} size="gloves" className="mt-2" />
        </div>
        <Say className="mt-5">
          {first!.label} is the standard.
          {alts.length > 0 && ` ${alts.map(a => a.label.replace(/^2 h$/, 'Two hours')).join(' or ')} gives more signal and a lower floor.`} I start the clock when the plate is in.
        </Say>
      </div>
    );
  }
  return (
    <div className="flex shrink-0 flex-col">
      {t.phase === 'done' ? (
        <div className="flex flex-col px-1">
          <BenchLine size="xl">Time’s up.</BenchLine>
          <p className="m-0 mt-2 text-[17px] leading-6 font-medium text-ink">Cool the plate to room temperature, then read.</p>
        </div>
      ) : (
        <Timer
          size="gloves"
          total={t.total}
          endsAt={t.phase === 'stopped' ? null : t.endsAt}
          left={t.phase === 'stopped' ? t.left : null}
          label={['Incubating', inc.temperature].filter(Boolean).join(' · ')}
          onTap={t.phase === 'running' ? v.finish : undefined}
        />
      )}
      <div className="mt-6 flex flex-col">
        {t.phase === 'running' && !t.confirm && (
          <Say>
            I’ll say it out loud when it’s done, and the screen stays on. Meanwhile, set the reader to <B>{read}</B>.
          </Say>
        )}
        {t.phase === 'running' && t.confirm && (
          <Say>
            <B>Stop the timer?</B>
          </Say>
        )}
        {t.phase === 'stopped' && (
          <Say>Stopped. Put the plate back{inc.temperature ? ` at ${inc.temperature}` : ''}, or read it as it is.</Say>
        )}
      </div>
    </div>
  );
}

/** Gloves-Read: cool, read, then show Chapp the reader's screen ("photo"). */
export function GlovesRead({ v }: { v: View }) {
  if (v.check) {
    return (
      <div className="flex shrink-0 flex-col gap-5">
        <Say>
          {checkSay(v.check.check, v.check.fit)} Say “yes” when they match.
        </Say>
        <PlateCheckView check={v.check.check} fit={v.check.fit} wells={v.check.wells} onEdit={v.check.edit} onConfirm={v.check.confirm} onAgain={v.check.again} />
      </div>
    );
  }
  return (
    <div className="flex shrink-0 flex-col">
      <Say>Cool the plate to room temperature and read every well. Then show me the reader’s screen.</Say>
      <div className="mt-5 flex flex-col px-1">
        <Over>Read at</Over>
        <BenchLine size="xxl">
          {v.bench.readout.value} {v.bench.readout.unit}
        </BenchLine>
      </div>
      <ReadingsIn v={v} className="mt-6" />
    </div>
  );
}

// The Listening glow (Gloves-*.dc.html), on white and on the camera's black.
const GLOW =
  'radial-gradient(120% 100% at 50% 100%, rgba(121, 185, 243, 0.45) 0%, rgba(111, 211, 198, 0.18) 42%, rgba(255, 255, 255, 0) 72%), linear-gradient(rgba(255, 255, 255, 0), rgba(255, 255, 255, 0.9) 62%)';
const GLOW_DARK =
  'radial-gradient(120% 100% at 50% 100%, rgba(121, 185, 243, 0.45) 0%, rgba(111, 211, 198, 0.18) 42%, rgba(11, 11, 12, 0) 72%), linear-gradient(rgba(11, 11, 12, 0), rgba(11, 11, 12, 0.9) 62%)';

/**
 * The bottom of the gloves layouts: the whole width is one target. While Chapp listens it says Listening, and a tap
 * stops listening and goes back to the buttons. If the microphone is not on (opened by address, or after a reload),
 * it says Tap to listen and a tap turns it on.
 */
export function GlovesBar({ listening, dark, onTap }: { listening: boolean; dark?: boolean; onTap: () => void }) {
  return (
    <button
      type="button"
      onClick={onTap}
      aria-label={listening ? 'Listening. Tap to stop listening and use the buttons' : 'Tap to listen, gloves on'}
      className="absolute inset-x-0 bottom-0 z-[6] flex h-[calc(114px+var(--screen-bottom))] cursor-pointer flex-col items-center justify-end gap-2.5 border-0 px-5 pb-[calc(6px+var(--screen-bottom))] font-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-blue focus-visible:ring-inset"
      style={{ background: dark ? GLOW_DARK : GLOW }}
    >
      <Waveform moving={listening} height={22} className={dark ? '[&>span]:bg-white' : undefined} />
      <span className={cn('text-[15px] leading-5 font-semibold', dark ? 'text-white' : 'text-text')}>{listening ? 'Listening' : 'Tap to listen'}</span>
    </button>
  );
}

/**
 * Gloves on or off, at the top right of the run screen (where the back button's twin would be): on, Chapp keeps
 * listening and the step turns into its big-type layout; off, the buttons come back. Filled while on.
 */
export function GlovesToggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={on ? 'Gloves on: Chapp keeps listening. Tap for the buttons' : 'Gloves on: Chapp keeps listening, no buttons'}
      onClick={() => onChange(!on)}
      className={cn(
        'absolute top-[calc(56px+var(--screen-top))] right-5 z-[6] flex size-11 items-center justify-center rounded-full outline-none transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-blue',
        on ? 'bg-ink text-white' : 'text-ink',
      )}
    >
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2" />
        <path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2" />
        <path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8" />
        <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
      </svg>
    </button>
  );
}
