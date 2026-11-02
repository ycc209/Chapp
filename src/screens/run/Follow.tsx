import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router';
import type { Procedure, Protocol } from '../../../shared/protocol.ts';
import { ChappHeader, type ChappHeaderProps } from '../../components/chapp/ChappHeader.tsx';
import { Check, DotLabel, StepPill, lengthText, useNow } from '../../components/lab/index.ts';
import { toast } from '../../components/ui/Toaster.tsx';
import { BottomBar } from '../../components/voice/BottomBar.tsx';
import { cn } from '../../lib/cn.ts';
import { applyActions } from '../../state/actions.ts';
import { useRun } from '../../state/run.ts';
import { PlusMenu } from '../home/PlusMenu.tsx';
import { TypingBar } from '../home/TypingBar.tsx';
import { acknowledge, converseContext } from '../home/useConverse.ts';
import { Expected } from '../protocol/Body.tsx';
import { shortName } from '../protocol/content.ts';
import { EyeIcon } from '../protocol/icons.tsx';
import { endsText, followNote, followSteps, leftText, prepItems, type FollowStep } from './follow.ts';
import { stepFromParam } from './model.ts';
import { enablePush, usePush, type PushState } from './push.ts';
import { Answer, Asked, LockScreenLine, StepNav, YouSaid } from './Steps.tsx';
import { useRunVoice, type Handled, type RunHandlers } from './voice.ts';
import { MinimizeRun } from './Minimize.tsx';
import { goToRunStep, skipRunStep } from './navigation.ts';
import { useTapNav } from './TapNav.tsx';
import { useStepPictures } from './Picture.tsx';

const PILL = 'flex min-h-10 cursor-pointer items-center rounded-[20px] border-0 px-[18px] font-[inherit] text-[15px] leading-5 font-semibold outline-none focus-visible:ring-2 focus-visible:ring-blue';
const INK = 'bg-ink text-white';
const WHITE = 'bg-white text-ink shadow-[0_1px_2px_rgba(17,17,19,0.06),0_2px_8px_rgba(17,17,19,0.04)]';
const NOTE_LABEL = { caution: 'Caution', tip: 'Tip', info: 'Note' } as const;
/** The pictures' words big, as on Run (no plan sizes anything here). */
const BIG = { big: true };

type TimerPhase = 'ready' | 'running' | 'done';

/**
 * Start for a protocol Chapp cannot plan (follow.ts): one step at a time, /run/1 … /run/N, and /run/all for the list.
 * Each step says what to do, its timer, what the user should see when it works (apart from what to do) and the
 * manual's cautions and tips; Next, Skip and Back move on, as does a tap on the page (its right side Next, its left
 * Back, twice Skip: TapNav), or the voice: "next", "back", "start", "stop", and anything else is a question for Chapp.
 * The button at the top right makes the run small, floating over Home (src/app/RunDock.tsx). Progress is the run's
 * (useRun), so a reload picks up where it was.
 */
export function FollowScreen({ p, proc }: { p: Protocol; proc: Procedure }) {
  const { step: param } = useParams();
  const navigate = useNavigate();
  const steps = useMemo(() => followSteps(proc), [proc]);
  const total = steps.length;
  const where = stepFromParam(param, total);
  const list = where === 'all';
  const runStep = useRun(s => s.step);
  const at = list ? Math.min(Math.max(runStep, 0), total - 1) : where;
  const step = steps[at]!;
  const done = useRun(s => s.done);
  const ends = useRun(s => s.timers[step.id]);
  const push = usePush(s => s.state);
  const note = followNote(p, proc);
  const hasPrep = (proc.prep ?? []).length > 0;
  const [heard, setHeard] = useState<string | null>(null);

  // The address and the run agree on the step; Chapp moving the run on (a reply's nextStep) is followed.
  useEffect(() => {
    if (!list && useRun.getState().step !== at) useRun.getState().goTo(at);
  }, [at, list]);
  useEffect(() => {
    if (list) return;
    const s = useRun.getState().step;
    if (s === at) return;
    if (s >= total) {
      useRun.getState().goTo(total - 1);
      return;
    }
    if (s === at + 1) useRun.getState().setDone(step.id);
    navigate(`/run/${s + 1}`);
  }, [runStep]);

  const goStep = (i: number) => {
    goToRunStep(steps, i, navigate);
  };
  const finish = () => {
    useRun.getState().setDone(step.id);
    toast(`All ${total} steps done.`);
    navigate('/protocol');
  };

  // The step's timer: ready, running until `ends`, or done.
  const now = useNow(ends !== undefined && ends > Date.now() ? 1000 : 30000);
  const phase: TimerPhase | null = !step.timer ? null : ends === undefined ? 'ready' : ends > now ? 'running' : 'done';
  const next = steps[at + 1];
  const startTimer = () => step.timer && useRun.getState().startTimer(step.id, step.timer.seconds);
  // Stopped, its push is called off; ending, it rings and goes to the lock screen from state/alarms.ts, for every
  // experiment and on any screen (a cell protocol waits for hours or days, rarely on this screen).
  const stopTimer = () => useRun.getState().stopTimer(step.id);

  // ─── The voice ─────────────────────────────────────────────────────────────────────────────────────────────────
  const stepSay = (i: number) => `Step ${i + 1}: ${steps[i]!.key}.`;
  const advance = (): Handled => {
    const at = useRun.getState().step;
    if (at >= total - 1) return { say: 'That’s the last step.', ok: false };
    goStep(at + 1);
    return { say: stepSay(at + 1) };
  };
  const back = (): Handled => {
    const at = useRun.getState().step;
    if (at === 0) return { say: 'This is the first step.', ok: false };
    goStep(at - 1);
    return { say: stepSay(at - 1) };
  };
  const handlers = useRef<RunHandlers>(null!);
  handlers.current = {
    command: (actions, said) => {
      if (actions.length === 1 && actions[0]!.type === 'nextStep') return advance();
      if (actions.length === 1 && actions[0]!.type === 'previousStep') return back();
      setHeard(said);
      applyActions(actions, navigate);
      return { say: acknowledge(actions) };
    },
    local: (c, said) => {
      switch (c.type) {
        case 'advance':
          return advance();
        case 'timer':
          if (!step.timer) return { say: 'This step has no timer.' };
          setHeard(said);
          if (c.what === 'stop') {
            if (phase !== 'running') return { say: 'The timer isn’t running.' };
            stopTimer();
            return { say: 'Stopped.' };
          }
          if (phase === 'running') return { say: 'It’s already running.' };
          startTimer();
          return { say: `${lengthText(step.timer.seconds)}. It ends ${endsText(Date.now() + step.timer.seconds * 1000)}.` };
        case 'answer':
          return { say: 'There is no pending question on this step.', ok: false };
        default:
          return null;
      }
    },
    context: () => converseContext('run', p, { step: useRun.getState().step, stepTitle: steps[useRun.getState().step]?.title }),
    protocol: () => p,
  };
  const { exchange, send, clear } = useRunVoice(handlers);

  // A new step starts clean: no "You said", no question.
  useEffect(() => {
    setHeard(null);
    clear();
  }, [at, list, clear]);

  const photos = useRun(s => s.photos);
  const pictures = useStepPictures(p, proc.id, steps.map(s => s.id), photos, BIG);

  const backTo = list
    ? { to: `/run/${at + 1}`, label: 'Back to the current step' }
    : at === 0
      ? hasPrep
        ? { to: '/run/prep', label: 'Back to reagent prep' }
        : { to: '/protocol', label: 'Back to the conversation' }
      : { to: `/run/${at}`, label: `Back to ${steps[at - 1]!.title.toLowerCase()}` };
  const taps = useTapNav({
    onNext: next ? () => goStep(at + 1) : undefined,
    onBack: at > 0 ? () => goStep(at - 1) : undefined,
    onSkip: next ? () => skipRunStep(steps, at, navigate) : undefined,
  });

  return (
    <RunFrame
      send={send}
      atKey={list ? 'all' : at}
      taps={list ? undefined : taps}
      corner={list ? undefined : <MinimizeRun titles={steps.map(s => s.title)} className="right-5" />}
      header={{
        back: backTo,
        subtitle: list ? `${shortName(p)} · All ${total} steps` : undefined,
        pill: list ? undefined : <StepPill index={at} total={total} title={step.title} to="/run/all" className="-mt-4" />,
      }}
    >
      {list ? (
        <AllSteps steps={steps} at={at} done={done} prep={hasPrep ? prepItems(proc) : []} onOpen={i => navigate(`/run/${i + 1}`)} onPrep={() => navigate('/run/prep')} />
      ) : (
        <>
          {exchange ? <Asked exchange={exchange} /> : heard ? <YouSaid text={heard} /> : null}
          {note && at === 0 && <p className="m-0 mb-4 shrink-0 px-1 text-[15px] leading-[22px] text-text">{note}</p>}
          {pictures.pictureOf(at)?.big}
          <Answer>{step.key}</Answer>
          {step.timer && phase && (
            <StepTimer timer={step.timer} phase={phase} ends={ends ?? null} now={now} push={push} onStart={startTimer} onStop={stopTimer} />
          )}
          {step.expected.length > 0 && <Expected lines={step.expected} className="mx-1 mb-5 shrink-0" />}
          {step.notes.length > 0 && (
            <ul aria-label="From the manual" className="m-0 mb-6 flex shrink-0 list-none flex-col gap-2 px-1">
              {step.notes.map((n, i) => (
                <li key={i} className="text-[15px] leading-[22px] text-text">
                  <b className={cn('font-semibold', n.kind === 'caution' ? 'text-ink' : 'text-text')}>{NOTE_LABEL[n.kind]}</b> · {n.text}
                </li>
              ))}
            </ul>
          )}
          <StepNav
            onBack={at > 0 ? () => goStep(at - 1) : undefined}
            onSkip={() => skipRunStep(steps, at, navigate)}
            next={next ? { title: next.title, go: () => goStep(at + 1) } : undefined}
            last={{ label: 'Finish', go: finish }}
          />

          {pictures.sheet}
        </>
      )}
    </RunFrame>
  );
}

/**
 * Before you start (/run/prep): the manual's reagent prep, ticked off one by one before step 1, for any protocol that
 * has some. Some of it keeps (a reconstituted stock), so nothing has to be ticked to go on; "next" or "ready" goes to
 * step 1, and anything else is a question for Chapp.
 */
export function PrepScreen({ p, proc }: { p: Protocol; proc: Procedure }) {
  const navigate = useNavigate();
  const items = useMemo(() => prepItems(proc), [proc]);
  const done = useRun(s => s.done);
  const ready = items.filter(i => done[i.id]).length;
  const [heard, setHeard] = useState<string | null>(null);
  const toStep1 = (): Handled => {
    navigate('/run/1');
    return { say: '' };
  };
  const handlers = useRef<RunHandlers>(null!);
  handlers.current = {
    command: (actions, said) => {
      if (actions.length === 1 && actions[0]!.type === 'nextStep') return toStep1();
      if (actions.length === 1 && actions[0]!.type === 'previousStep') {
        navigate('/protocol');
        return { say: '' };
      }
      setHeard(said);
      applyActions(actions, navigate);
      return { say: acknowledge(actions) };
    },
    local: c => (c.type === 'advance' ? toStep1() : c.type === 'answer' ? { say: 'There is no pending question on this step.', ok: false } : null),
    // Not a step of the experiment: no step index, the screen says where the user is.
    context: () => converseContext('run-prep', p, { step: undefined }),
    protocol: () => p,
  };
  const { exchange, send } = useRunVoice(handlers);

  return (
    <RunFrame send={send} atKey="prep" header={{ back: { to: '/protocol', label: 'Back to the conversation' }, subtitle: `${shortName(p)} · Before you start` }}>
      {exchange ? <Asked exchange={exchange} /> : heard ? <YouSaid text={heard} /> : null}
      <Answer>Get the reagents ready first. Tick each one as you go; skip any you did before.</Answer>
      <ol aria-label="Reagent prep" className="m-0 mb-6 flex shrink-0 list-none flex-col p-0">
        {items.map(item => (
          <li key={item.id}>
            <button
              type="button"
              aria-pressed={!!done[item.id]}
              onClick={() => useRun.getState().setDone(item.id, !done[item.id])}
              className="grid w-full cursor-pointer grid-cols-[24px_minmax(0,1fr)] gap-3 border-0 border-b border-solid border-line bg-transparent px-1 py-3 text-left font-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-blue"
            >
              <span
                aria-hidden="true"
                className={cn('mt-px flex size-6 items-center justify-center rounded-full', done[item.id] ? 'bg-mark text-ink' : 'shadow-[inset_0_0_0_1.5px_var(--line)]')}
              >
                {done[item.id] && <Check size={11} width={3.2} />}
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-[16px] leading-[21px] font-semibold text-ink">{item.title}</span>
                <span className="text-[14px] leading-[20px] text-text">{item.key}</span>
                {item.notes.map((n, i) => (
                  <span key={i} className="text-[14px] leading-[20px] text-text">
                    <b className={cn('font-semibold', n.kind === 'caution' ? 'text-ink' : 'text-text')}>{NOTE_LABEL[n.kind]}</b> · {n.text}
                  </span>
                ))}
              </span>
            </button>
          </li>
        ))}
      </ol>
      <nav aria-label="Move through the steps" className="mt-auto flex shrink-0 items-center gap-2 px-1 pt-2">
        <button type="button" onClick={toStep1} className={cn(PILL, INK, 'min-w-0')}>
          <span className="truncate">{ready === items.length ? 'All ready · Start step 1' : `Start step 1 · ${ready} of ${items.length} ready`}</span>
        </button>
      </nav>
    </RunFrame>
  );
}

/**
 * A run screen's frame: the page, the bar to speak or type at the bottom, its + menu, and Chapp's header; `taps`, when
 * tapping the page moves through the steps (TapNav), and `corner`, a button at the top right.
 */
function RunFrame({
  send,
  atKey,
  header,
  taps,
  corner,
  children,
}: {
  send: (text: string) => void;
  atKey: string | number;
  header: ChappHeaderProps;
  taps?: ReturnType<typeof useTapNav>;
  corner?: ReactNode;
  children: ReactNode;
}) {
  const [typing, setTyping] = useState(false);
  const [plus, setPlus] = useState(false);
  const plusRef = useRef<HTMLButtonElement>(null);
  // A new step closes the menu.
  useEffect(() => setPlus(false), [atKey]);
  return (
    <div className="relative h-full overflow-hidden bg-bg">
      <div
        onClick={taps?.onClick}
        className="flex h-full touch-manipulation flex-col overflow-y-auto px-5 pt-[calc(196px+var(--screen-top))] pb-[calc(92px+var(--screen-bottom))] [scrollbar-width:none]"
      >
        {children}
      </div>
      {taps?.overlay}

      <div className="absolute inset-x-0 bottom-0 z-[6] px-5 pt-2 pb-[var(--screen-bottom)]">
        {typing ? (
          <TypingBar
            plusOpen={plus}
            plusRef={plusRef}
            onPlus={() => setPlus(o => !o)}
            onSend={send}
            onClose={() => {
              setTyping(false);
              setPlus(false);
            }}
          />
        ) : (
          <BottomBar onPlus={() => setPlus(o => !o)} onKeyboard={() => setTyping(true)} onUtterance={send} />
        )}
      </div>
      <PlusMenu open={plus} onClose={() => setPlus(false)} coverPlus={!typing} plusRef={plusRef} />

      <ChappHeader {...header} />
      {corner}
    </div>
  );
}

/** The step's timer: its length and when it would end, then the time left, then done. */
function StepTimer({
  timer,
  phase,
  ends,
  now,
  push,
  onStart,
  onStop,
}: {
  timer: NonNullable<FollowStep['timer']>;
  phase: TimerPhase;
  ends: number | null;
  now: number;
  push: PushState;
  onStart: () => void;
  onStop: () => void;
}) {
  const length = lengthText(timer.seconds);
  const how = [timer.temperature, timer.covered ? 'covered' : null].filter(Boolean).join(', ');
  if (phase === 'done') {
    return (
      <div className="mb-6 flex shrink-0 items-center gap-2.5 px-1">
        <span aria-hidden="true" className="flex size-[22px] shrink-0 items-center justify-center rounded-full bg-mark text-ink">
          <Check size={11} width={3.2} />
        </span>
        <p className="m-0 text-[17px] leading-[22px] font-semibold text-ink tabular-nums">
          Done · {length}
          {timer.temperature ? ` at ${timer.temperature}` : ''}
        </p>
      </div>
    );
  }
  if (phase === 'running' && ends !== null) {
    return (
      <div className="mb-6 flex shrink-0 flex-col">
        <div className="flex flex-col items-start gap-2 px-1">
          <DotLabel>
            {timer.label}
            {how ? ` · ${how}` : ''}
          </DotLabel>
          <p role="timer" className="m-0 text-[28px] leading-[34px] font-bold text-ink tabular-nums">
            {leftText((ends - now) / 1000)} left
          </p>
          <p className="m-0 mb-3 text-[13px] leading-[18px] font-semibold text-text tabular-nums">
            {length} · ends {endsText(ends, now)}
          </p>
        </div>
        <LockScreenLine push={{ state: push, enable: () => void enablePush() }} after="" />
        <button type="button" onClick={onStop} className={cn(PILL, WHITE, 'ml-1 self-start')}>
          Stop the timer
        </button>
      </div>
    );
  }
  return (
    <div className="mb-6 flex shrink-0 flex-col items-start gap-3 px-1">
      <p className="m-0 text-[15px] leading-[22px] text-text tabular-nums">
        {timer.label}: <b className="font-semibold text-ink">{length}</b>
        {how ? `, ${how}` : ''}. Started now, it ends {endsText(now + timer.seconds * 1000, now)}.
      </p>
      <button type="button" onClick={onStart} className={cn(PILL, INK, 'shrink-0')}>
        Start the timer
      </button>
    </div>
  );
}

/** Every step at once (/run/all), after the reagent prep: done ones ticked, the current one marked; a tap opens it. */
function AllSteps({
  steps,
  at,
  done,
  prep,
  onOpen,
  onPrep,
}: {
  steps: FollowStep[];
  at: number;
  done: Record<string, boolean>;
  prep: FollowStep[];
  onOpen: (i: number) => void;
  onPrep: () => void;
}) {
  const prepped = prep.filter(x => done[x.id]).length;
  return (
    <ol aria-label="All steps" className="m-0 flex list-none flex-col p-0">
      {prep.length > 0 && (
        <li>
          <button
            type="button"
            onClick={onPrep}
            className="grid w-full cursor-pointer grid-cols-[24px_minmax(0,1fr)] gap-3 border-0 border-b border-solid border-line bg-transparent px-1 py-3 text-left font-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-blue"
          >
            <span className={cn('flex size-6 items-center justify-center rounded-full', prepped === prep.length ? 'bg-mark text-ink' : 'bg-sunken text-text')}>
              {prepped === prep.length ? <Check size={11} width={3.2} /> : <span className="size-1.5 rounded-full bg-current" />}
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[16px] leading-[21px] font-semibold text-ink">Reagent prep</span>
              <span className="text-[14px] leading-[20px] text-text">
                Before you start · {prepped} of {prep.length} ready
              </span>
            </span>
          </button>
        </li>
      )}
      {steps.map((s, i) => (
        <li key={s.id}>
          <button
            type="button"
            onClick={() => onOpen(i)}
            aria-current={i === at ? 'step' : undefined}
            className="grid w-full cursor-pointer grid-cols-[24px_minmax(0,1fr)] gap-3 border-0 border-b border-solid border-line bg-transparent px-1 py-3 text-left font-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-blue"
          >
            <span
              className={cn(
                'flex size-6 items-center justify-center rounded-full text-[12px] leading-6 font-bold tabular-nums',
                done[s.id] ? 'bg-mark text-ink' : i === at ? 'bg-ink text-white' : 'bg-sunken text-text',
              )}
            >
              {done[s.id] ? <Check size={11} width={3.2} /> : i + 1}
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[16px] leading-[21px] font-semibold text-ink">{s.title}</span>
              <span className="text-[14px] leading-[20px] text-text">{s.key}</span>
              {s.expected.map((line, j) => (
                <span key={j} className="flex items-start gap-1.5 text-[14px] leading-[20px] text-text">
                  <span className="mt-[3px] shrink-0">
                    <EyeIcon size={14} />
                  </span>
                  {line}
                </span>
              ))}
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}
