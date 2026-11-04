import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import type { Action } from '../../../shared/ai.ts';
import type { Sized } from '../../../shared/benchScenes.ts';
import { sampleReadings } from '../../../shared/fit.ts';
import { decodeText, fitToPlan, parsePlateText } from '../../../shared/plate.ts';
import { api } from '../../api/client.ts';
import type { Protocol } from '../../../shared/protocol.ts';
import { isPlannable } from '../../../shared/calc.ts';
import { ChappHeader } from '../../components/chapp/ChappHeader.tsx';
import { DotLabel, StepPill, amountText, clockText, countdownText, lengthText, useNow, wellRoles } from '../../components/lab/index.ts';
import { toast } from '../../components/ui/Toaster.tsx';
import { BottomBar } from '../../components/voice/BottomBar.tsx';
import { cn } from '../../lib/cn.ts';
import { applyActions } from '../../state/actions.ts';
import { moveWells, redo } from '../../state/benchEdits.ts';
import { useProtocol } from '../../state/protocol.ts';
import { useRun } from '../../state/run.ts';
import { useSession } from '../../state/session.ts';
import { speak } from '../../voice/speak.ts';
import { useVoice } from '../../voice/useVoice.ts';
import { PlusMenu } from '../home/PlusMenu.tsx';
import { TypingBar } from '../home/TypingBar.tsx';
import { acknowledge, converseContext } from '../home/useConverse.ts';
import { procedureFor, shortName } from '../protocol/content.ts';
import { useBench } from './bench.ts';
import { FollowScreen, PrepScreen } from './Follow.tsx';
import { GlovesAdd, GlovesBar, GlovesIncubate, GlovesLoad, GlovesMix, GlovesRead, GlovesStandards, GlovesToggle } from './Gloves.tsx';
import {
  benchFor,
  checkIsClean,
  currentTube,
  editCheck,
  listText,
  loadUpTo,
  readableText,
  spoken,
  standardsLine,
  standardsText,
  stepFromParam,
  tickUpTo,
  timerPhase,
  tubeKey,
  tubeText,
  type Bench,
  type PlateCheck,
  type TimerPhase,
} from './model.ts';
import { PhotoView, type PhotoStatus } from './Photo.tsx';
import { useStepPictures } from './Picture.tsx';
import { checkSpoken } from './PlateCheck.tsx';
import { enablePush, usePush } from './push.ts';
import { EXPORT_TYPES, ReadMenu } from './ReadMenu.tsx';
import { AddStep, AllSteps, Asked, IncubateStep, LoadStep, MixStep, ReadStep, StandardsStep, StepNav, YouSaid, nextPhrase } from './Steps.tsx';
import { TimeUp } from './TimeUp.tsx';
import type { View } from './view.ts';
import { useRunVoice, type Handled, type RunHandlers } from './voice.ts';
import { useDock } from '../../state/dock.ts';
import { MinimizeRun } from './Minimize.tsx';
import { goToRunStep, skipRunStep } from './navigation.ts';
import { useTapNav } from './TapNav.tsx';

/** The artboards' timer: 24:37 left of 30 min (Run-Timer, Gloves-Timer), for review by address. */
const REVIEW_LEFT = 1477;
const TIMER_STATES = ['choose', 'timer', 'running', 'stopped', 'confirm', 'done', 'timeup'];

/**
 * Following the protocol at the bench, step by step (/run/1 … /run/6, and /run/all for every step): Run-Standards,
 * Run-Mix, Run-Load, Run-Add, Run-Incubate → Run-Timer → Timer-Done, Run-Read, Run-List.
 *
 * Gloves on (Gloves-*, "Run, mic on") is a mode of the same screen, ?gloves=1: the gloves button at the top right, and
 * the step turns into its big-type layout while Chapp keeps listening; a tap on Listening (or the button again) ends
 * it and brings the buttons back. Under each step, gloves off, Back, Skip and Next move through the steps (StepNav); so
 * does a tap on the page, gloves or not: its right side Next, its left Back, twice Skip (TapNav). The button beside the
 * gloves makes the run small, floating over Home until it is opened again (src/app/RunDock.tsx).
 * Either way the voice does everything: "next", "back", "C is OK", "start the timer", "stop", "two hours",
 * "photo", "use the sample export"; anything else is a question for Chapp, answered from the manual.
 *
 * Progress lives in useRun() (ticked vials and tubes, finished steps, the timer's end, the readings), so a reload in
 * the middle of a run picks up where it was. For design review a state opens from the address and is not saved:
 * /run/1?state=3 (three vials made) &heard=C%20is%20OK, /run/3?state=9 (tube 10 now), /run/5?state=choose | timer |
 * stopped | confirm | done | timeup, /run/6?state=photo | taken, each with &gloves=1 for the gloves layout.
 */
export function RunScreen() {
  const { step: param } = useParams();
  // On its own screen the run is whole, no longer floating.
  useEffect(() => useDock.getState().restore(), []);
  const protocolId = useRun(s => s.protocolId) ?? 'pierce-bca';
  const procedure = useRun(s => s.procedure);
  const samples = useRun(s => s.samples);
  const replicates = useRun(s => s.replicates);
  const standardReplicates = useRun(s => s.standardReplicates);
  const standards = useRun(s => s.standards);
  const edits = useRun(s => s.edits);
  const { protocol, error } = useProtocol(protocolId);
  const bench = useMemo(() => {
    if (!protocol) return null;
    try {
      return benchFor(protocol, { procedure, samples, replicates, standardReplicates, standards, edits });
    } catch {
      return null;
    }
  }, [protocol, procedure, samples, replicates, standardReplicates, standards, edits]);

  // A protocol Chapp cannot plan (cells, or amounts it cannot convert) is followed step by step instead.
  const proc = protocol && procedureFor(protocol, procedure);
  // Reagent prep comes before step 1, whichever way the run is followed.
  if (protocol && proc && param === 'prep' && (proc.prep ?? []).length) return <PrepScreen p={protocol} proc={proc} />;
  if (protocol && proc && !isPlannable(protocol, proc)) return <FollowScreen p={protocol} proc={proc} />;

  if (!protocol || !bench) {
    return (
      <div className="relative h-full overflow-hidden bg-bg">
        <p role={error ? 'alert' : undefined} className="px-6 pt-[calc(196px+var(--screen-top))] text-[17px] leading-6 font-medium text-ink">
          {error ??
            (!protocol ? 'Opening the protocol…'
            : !protocol.analysis ? 'This kit has no plate to run here. Its steps are on the protocol.'
            : 'This plan does not fit the protocol’s steps. Check the plan first.')}
        </p>
        <ChappHeader back={{ to: '/protocol', label: 'Back to the conversation' }} />
      </div>
    );
  }
  return <RunBench p={protocol} bench={bench} />;
}

function RunBench({ p, bench }: { p: Protocol; bench: Bench }) {
  const { step: param } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const run = useRun();
  const lengths = useBench(s => s.lengths);
  const pausedAt = useBench(s => s.paused);
  const voice = useSession(s => s.voice);

  const total = bench.steps.length;
  const where = stepFromParam(param, total);
  const list = where === 'all';
  const at = list ? Math.min(Math.max(run.step, 0), total - 1) : where;
  const gloves = !list && params.get('gloves') === '1';
  const keep = gloves ? '?gloves=1' : '';
  const review = list ? null : params.get('state');
  const reviewHeard = list ? null : params.get('heard');
  const [mountedAt] = useState(() => Date.now());

  const vials = bench.series.vials;
  const plate = bench.plate;
  const inc = bench.incubation;
  const idx = useMemo(
    () => ({
      standards: bench.steps.findIndex(s => s.stage === 'standards'),
      load: bench.steps.findIndex(s => s.step.add?.some(a => a.what === 'standards-and-samples')),
      incubate: bench.steps.findIndex(s => s.id === bench.incubation?.id),
      read: bench.steps.findIndex(s => s.stage === 'read'),
    }),
    [bench],
  );

  const [heard, setHeard] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [photo, setPhoto] = useState<{ heard: string | null } | null>(null);
  const [photoStatus, setPhotoStatus] = useState<PhotoStatus | null>(null);
  /** The export file being read, by name. */
  const [reading, setReading] = useState<string | null>(null);
  const plateCall = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const check = useBench(s => s.check);
  const push = usePush(s => s.state);
  const [typing, setTyping] = useState(false);
  const [plus, setPlus] = useState(false);
  const plusRef = useRef<HTMLButtonElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  // ─── What is on screen: the run, or a state asked for by address ──────────────────────────────────────────────
  const reviewCount = review !== null && /^\d+$/.test(review) ? Number(review) : null;
  const done = useMemo(() => {
    if (reviewCount === null) return run.done;
    if (at === idx.standards) return { ...run.done, ...Object.fromEntries(vials.map((v, i) => [v.id, i < reviewCount])) };
    if (at === idx.load) return { ...run.done, ...Object.fromEntries(plate.tubes.map(t => [tubeKey(t.index), t.index < reviewCount])) };
    return run.done;
  }, [run.done, reviewCount, at, idx, vials, plate]);

  const liveEnds = inc ? run.timers[inc.id] : undefined;
  const livePaused = inc ? pausedAt[inc.id] : undefined;
  const choice = inc ? (lengths[inc.id] ?? inc.options[0]!.seconds) : 0;
  const now = useNow(liveEnds !== undefined && liveEnds > Date.now() ? 1000 : 30000);
  const timerReview = at === idx.incubate && review !== null && TIMER_STATES.includes(review) ? review : null;
  const timer: View['timer'] = (() => {
    if (timerReview) {
      const phase: TimerPhase =
        timerReview === 'choose' ? 'choose' : timerReview === 'stopped' ? 'stopped' : timerReview === 'done' || timerReview === 'timeup' ? 'done' : 'running';
      const length = inc?.options[0]?.seconds ?? 0;
      return {
        phase,
        total: length,
        endsAt: phase === 'running' ? mountedAt + REVIEW_LEFT * 1000 : phase === 'done' ? mountedAt - 1000 : null,
        left: phase === 'stopped' ? REVIEW_LEFT : null,
        confirm: timerReview === 'confirm',
      };
    }
    const phase = timerPhase(liveEnds, livePaused, now);
    return { phase, total: choice, endsAt: liveEnds ?? null, left: livePaused ?? null, confirm: confirm && phase === 'running' };
  })();
  const readings = { count: Object.keys(run.readings).length, sample: run.readingsFrom === 'sample' };

  // ─── The address and the run agree on the step ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!list && useRun.getState().step !== at) useRun.getState().goTo(at);
  }, [at, list]);
  // Chapp moved the run on (a reply's nextStep, say): follow it.
  useEffect(() => {
    if (list) return;
    const s = useRun.getState().step;
    if (s === at) return;
    if (s >= total) {
      useRun.getState().goTo(total - 1);
      return;
    }
    if (s === at + 1) useRun.getState().setDone(bench.steps[at]!.id);
    navigate(`/run/${s + 1}${keep}`);
  }, [run.step]);

  // ─── Doing things ──────────────────────────────────────────────────────────────────────────────────────────────
  /** Leaves a state opened by address: from the first thing done, the screen shows the run itself. */
  const leaveReview = () => {
    if (review === null && reviewHeard === null) return;
    setParams(
      prev => {
        const n = new URLSearchParams(prev);
        n.delete('state');
        n.delete('heard');
        return n;
      },
      { replace: true },
    );
  };
  /** Writes ticks into the run, only the ones that change. */
  const setMany = (patch: Record<string, boolean>) => {
    const r = useRun.getState();
    for (const [k, on] of Object.entries(patch)) if (!!r.done[k] !== on) r.setDone(k, on);
  };
  const goStep = (i: number) => {
    goToRunStep(bench.steps, i, navigate, keep);
  };
  const setGloves = (on: boolean) =>
    setParams(
      prev => {
        const n = new URLSearchParams(prev);
        if (on) n.set('gloves', '1');
        else n.delete('gloves');
        n.delete('state');
        n.delete('heard');
        return n;
      },
      { replace: true },
    );

  const tickVial = (id: string) => {
    leaveReview();
    setHeard(null);
    setMany(tickUpTo(vials, done, id, !done[id]));
  };
  const tapTube = (index: number) => {
    const cur = currentTube(plate, done);
    leaveReview();
    setHeard(null);
    if (index === cur) {
      setMany(loadUpTo(plate, done, index, true));
      setFlash(true);
    } else if (index < cur) {
      setMany(loadUpTo(plate, done, index, false));
      setFlash(false);
    }
  };
  const choose = (seconds: number) => {
    if (!inc) return;
    leaveReview();
    setFlash(seconds !== choice);
    useBench.getState().setLength(inc.id, seconds);
  };
  const livePhase = () => (inc ? timerPhase(useRun.getState().timers[inc.id], useBench.getState().paused[inc.id], Date.now()) : 'choose');
  const startTimer = () => {
    if (!inc) return;
    useRun.getState().startTimer(inc.id, choice);
    useBench.getState().unpause(inc.id);
    setConfirm(false);
  };
  const stopTimer = () => {
    const ends = inc && useRun.getState().timers[inc.id];
    if (!inc || !ends) return;
    useRun.getState().stopTimer(inc.id);
    useBench.getState().pause(inc.id, Math.max(1, Math.ceil((ends - Date.now()) / 1000)));
    setConfirm(false);
  };
  const resumeTimer = () => {
    const left = inc && useBench.getState().paused[inc.id];
    if (!inc || !left) return;
    useRun.getState().startTimer(inc.id, left);
    useBench.getState().unpause(inc.id);
  };
  /** Tap the time: the incubation ends now, and Time's up follows as if it had run out. */
  const finish = () => {
    if (!inc) return;
    leaveReview();
    useRun.getState().startTimer(inc.id, 0);
    useBench.getState().unpause(inc.id);
  };
  /**
   * Reset: the clock cleared, running, stopped or done, back to choosing the length (Run-Incubate), the one chosen
   * kept. Its alarm and lock-screen push go with it (state/alarms.ts calls off a timer the run no longer has).
   */
  const resetTimer = () => {
    if (!inc) return;
    leaveReview();
    useRun.getState().stopTimer(inc.id);
    useBench.getState().unpause(inc.id);
    setConfirm(false);
    setHeard(null);
  };
  /** Chapp's example readings for this plate (labeled Sample data wherever they show); real ones are kept unless asked. */
  const sampleIn = (force: boolean) => {
    const r = useRun.getState();
    if (force || r.readingsFrom !== 'plate' || !Object.keys(r.readings).length) r.setReadings(sampleReadings(wellRoles(plate)), 'sample');
  };
  const takeSample = () => {
    useBench.getState().setCheck(null);
    sampleIn(true);
    navigate('/results');
  };
  // ─── The readings: the reader's export, a photo of it, or the sample ──────────────────────────────────────────
  const wells = useMemo(() => plate.cells.map(c => c.well), [plate]);
  const hints = { rows: plate.rows, cols: plate.cols, ...(/^nm$/i.test(bench.readout.unit) ? { wavelength: bench.readout.value } : {}) };
  const fit = useMemo(() => (check ? fitToPlan(check, wells) : null), [check, wells]);
  /** The readings are the user's from here on: Results analyzes them as theirs, no Sample data tag. */
  const takeReadings = (readings: Record<string, number>) => {
    useRun.getState().setReadings(readings, 'plate');
    useBench.getState().setCheck(null);
    navigate('/results');
  };
  /** Readings from a file or a model: a clean file goes straight to Results; anything else is checked first. */
  const offer = (c: PlateCheck, say?: boolean) => {
    const f = fitToPlan(c, wells);
    if (!Object.keys(f.readings).length) {
      toast(c.name ? `No readings for your plate in ${c.name}.` : 'No readings for your plate in the photo.', {
        description: c.name ? 'Try the reader’s CSV, TXT or XLSX export, or a photo of its screen.' : (c.note ?? 'Try again closer, with the whole table in the frame.'),
      });
      return false;
    }
    if (checkIsClean(c, f)) {
      if (c.note) toast(`${c.name}: used “${c.note}”`);
      takeReadings(f.readings);
      return true;
    }
    useBench.getState().setCheck(c);
    if (say && gloves) void speak(spoken(checkSpoken(f))).catch(() => {});
    return true;
  };
  const askServer = (body: Parameters<typeof api.readPlate>[0]) => {
    plateCall.current?.abort();
    const call = (plateCall.current = new AbortController());
    return api.readPlate({ ...body, ...hints }, call.signal).finally(() => {
      if (plateCall.current === call) plateCall.current = null;
    });
  };
  /** The reader's export: read here when it is text the parser knows, else by the server (.xlsx, then Muse Spark). */
  const onFile = (file: File) => {
    leaveReview();
    setReading(file.name);
    const local = (async () => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes[0] === 0x50 && bytes[1] === 0x4b) return { bytes, read: null };
      return { bytes, read: parsePlateText(decodeText(bytes), hints) };
    })();
    void local
      .then(async ({ bytes, read }) => {
        if (read) return offer({ by: 'file', name: file.name, values: read.values, odd: read.odd, unsure: [], note: read.reads > 1 ? read.label : null });
        if (bytes.length > 8 * 1024 * 1024) throw new Error(`${file.name} is too large to read.`);
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        const r = await askServer({ file: { name: file.name, base64: btoa(binary) } });
        return offer({ by: r.by === 'model' ? 'model' : 'file', name: file.name, values: r.readings, odd: r.odd ?? {}, unsure: r.unsure ?? [], note: r.note ?? null });
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === 'AbortError') return;
        toast(`${file.name} could not be read.`, { description: error instanceof Error ? error.message : undefined });
      })
      .finally(() => setReading(r => (r === file.name ? null : r)));
  };
  const chooseFile = () => fileInput.current?.click();
  /** The photo of the reader's screen: Muse Spark reads it; the mock AI hands back the sample readings instead. */
  const onPhoto = (shot: { src: string; big: string }) => {
    useBench.getState().setPlatePhoto(shot.src);
    setPhotoStatus({ phase: 'reading' });
    askServer({ photo: shot.big }).then(
      r => {
        if (r.sampleData) {
          sampleIn(false);
          setPhotoStatus({ phase: 'sample' });
          if (gloves) void speak(spoken('Got the photo. These results use the sample plate-reader export. Say “results” to see them.')).catch(() => {});
          return;
        }
        const c: PlateCheck = { by: 'model', name: null, values: r.readings, odd: r.odd ?? {}, unsure: r.unsure ?? [], note: r.note ?? null };
        const f = fitToPlan(c, wells);
        if (!Object.keys(f.readings).length) {
          setPhotoStatus({ phase: 'failed', line: r.note ?? 'No plate table in the photo.' });
          if (gloves) void speak('I couldn’t read the wells. Say “photo” to take it again.').catch(() => {});
          return;
        }
        useBench.getState().setCheck(c);
        setPhotoStatus({ phase: 'read', line: readableText(f) });
        if (gloves) void speak(spoken(`Got it. ${checkSpoken(f)}`)).catch(() => {});
      },
      (error: unknown) => {
        if (error instanceof Error && error.name === 'AbortError') return;
        setPhotoStatus({ phase: 'failed', line: error instanceof Error ? error.message : 'Something went wrong.' });
      },
    );
  };
  const checkView: View['check'] =
    check && fit
      ? {
          check,
          fit,
          wells,
          edit: (well, value) => {
            const c = useBench.getState().check;
            if (c) useBench.getState().setCheck(editCheck(c, well, value));
          },
          confirm: () => takeReadings(fit.readings),
          again: () => {
            useBench.getState().setCheck(null);
            if (check.name) chooseFile();
            else setPhoto({ heard: null });
          },
        }
      : null;

  // ─── What Chapp says ───────────────────────────────────────────────────────────────────────────────────────────
  const tempText = inc?.temperature ?? null;
  const started = (seconds: number) =>
    `Timer started: ${lengthText(seconds)}${tempText ? ` at ${tempText}` : ''}. It ends at ${clockText(Date.now() + seconds * 1000)}.`;
  const nextAfter = (i: number) => nextPhrase(bench.steps[i + 1]);
  /** The step's instruction, read aloud when the voice brings it on screen. */
  const intro = (i: number): string => {
    const s = bench.steps[i];
    const d = useRun.getState().done;
    if (!s) return '';
    if (i === idx.standards)
      return bench.ready ? `Your standards are already made. Next, ${nextAfter(i)}.` : standardsText(standardsLine(vials, d), nextAfter(i));
    if (s.stage === 'mix') {
      const r = bench.reagent;
      return `Make ${amountText(r.make)} of ${r.name.toLowerCase()}: ${r.parts.map(x => `${amountText(x.volume)} ${x.name}`).join(', then ')}. Swirl until it is clear green.`;
    }
    if (i === idx.load) return tubeText(plate, currentTube(plate, d), bench.load);
    if (s.step.add?.some(a => a.what === 'mix'))
      return `${amountText(bench.add.volume)} of ${bench.reagent.name.toLowerCase()} into all ${plate.wells} wells, in the order you loaded them.${bench.add.shake ? ` Then shake ${bench.add.shake}${inc?.covered ? ' and cover the plate' : ''}.` : ''}`;
    if (i === idx.incubate && inc) {
      const phase = livePhase();
      const ends = useRun.getState().timers[inc.id];
      if (phase === 'running' && ends) return `Incubating: ${countdownText(Math.ceil((ends - Date.now()) / 1000))} left.`;
      if (phase === 'done') return 'The incubation is done. Cool the plate, then read it.';
      return `${tempText ? `${tempText}, ` : ''}${lengthText(choice)}. Say “start” when the plate is in.`;
    }
    if (i === idx.read) return `Cool the plate to room temperature, then read every well at ${bench.readout.value} ${bench.readout.unit}. Then show me the reader’s screen.`;
    return s.title;
  };

  /** "Next", "done", "mixed": the next vial or tube while there are some, else the next step. */
  const advance = (said: string): Handled => {
    const { step: at, done } = useRun.getState();
    if (at === idx.standards && !bench.ready) {
      const line = standardsLine(vials, done);
      if (line.kind !== 'all') {
        const patch = tickUpTo(vials, done, line.vial.id, true);
        leaveReview();
        setMany(patch);
        setHeard(said);
        return { say: standardsText(standardsLine(vials, { ...done, ...patch }), nextAfter(at)) };
      }
    }
    if (at === idx.load) {
      const cur = currentTube(plate, done);
      if (cur < plate.tubes.length) {
        leaveReview();
        setMany(loadUpTo(plate, done, cur, true));
        setFlash(true);
        setHeard(said);
        return { say: tubeText(plate, cur + 1, bench.load) };
      }
    }
    if (at === idx.incubate && inc && livePhase() === 'choose') {
      leaveReview();
      startTimer();
      setHeard(said);
      return { say: started(choice) };
    }
    if (at === total - 1) {
      if (checkView) {
        setPhoto(null);
        return { say: spoken(checkSpoken(checkView.fit)) };
      }
      if (Object.keys(useRun.getState().readings).length) {
        navigate('/results');
        return { say: '' };
      }
      return { say: 'No readings are loaded yet. Show the reader’s screen or use the sample export.', ok: false };
    }
    goStep(at + 1);
    return { say: intro(at + 1) };
  };

  /** "Back": the tube or vial before, while there is one on this step, else the step before. */
  const back = (said: string): Handled => {
    const { step: at, done } = useRun.getState();
    if (at === idx.load) {
      const cur = currentTube(plate, done);
      if (cur > 0) {
        leaveReview();
        setMany(loadUpTo(plate, done, cur - 1, false));
        setHeard(said);
        return { say: tubeText(plate, cur - 1, bench.load) };
      }
    }
    if (at === idx.standards && !bench.ready) {
      const last = vials.filter(v => done[v.id]).at(-1);
      if (last) {
        const patch = tickUpTo(vials, done, last.id, false);
        leaveReview();
        setMany(patch);
        setHeard(said);
        return { say: standardsText(standardsLine(vials, { ...done, ...patch }), nextAfter(at)) };
      }
    }
    if (at === 0) return { say: 'This is the first step.', ok: false };
    goStep(at - 1);
    return { say: intro(at - 1) };
  };

  const handlers = useRef<RunHandlers>(null!);
  handlers.current = {
    command: (actions: Action[], said: string) => {
      const marks = actions.flatMap(a => (a.type === 'markDone' ? [a.id] : []));
      if (marks.length && marks.length === actions.length) {
        const at_ = marks.map(id => vials.findIndex(v => v.id === id));
        if (bench.ready || at_.some(i => i < 0)) return null;
        const patch = tickUpTo(vials, done, vials[Math.max(...at_)]!.id, true);
        leaveReview();
        setMany(patch);
        setHeard(said);
        return { say: at === idx.standards ? standardsText(standardsLine(vials, { ...done, ...patch }), nextAfter(at)) : `${listText(marks)} done.` };
      }
      if (actions.length === 1 && actions[0]!.type === 'nextStep') return advance(said);
      if (actions.length === 1 && actions[0]!.type === 'previousStep') return back(said);
      applyActions(actions, navigate);
      return { say: acknowledge(actions) };
    },
    local: (c, said) => {
      switch (c.type) {
        case 'advance':
          return advance(said);
        case 'timer': {
          if (!inc) return null;
          const phase = livePhase();
          leaveReview();
          if (c.what === 'start' || (c.what === 'resume' && phase === 'stopped')) {
            if (phase === 'choose') {
              startTimer();
              if (at !== idx.incubate) goStep(idx.incubate);
              else setHeard(said);
              return { say: started(choice) };
            }
            if (phase === 'stopped') {
              const left = useBench.getState().paused[inc.id] ?? 0;
              resumeTimer();
              setHeard(said);
              return { say: `Resumed. It ends at ${clockText(Date.now() + left * 1000)}.` };
            }
            const ends = useRun.getState().timers[inc.id];
            return { say: phase === 'running' && ends ? `It’s running: ${countdownText(Math.ceil((ends - Date.now()) / 1000))} left.` : 'The incubation is done.' };
          }
          if (c.what === 'stop') {
            if (phase !== 'running') return { say: 'No timer is running.' };
            setHeard(said);
            // Gloves on, Chapp is always listening: it asks before stopping (Gloves-Timer).
            if (gloves) {
              setConfirm(true);
              return { say: 'Stop the timer?' };
            }
            stopTimer();
            return { say: 'Stopped. Put it back, or read it as it is.' };
          }
          return { say: phase === 'running' ? 'It’s still running.' : 'Say “start” when the plate is in.' };
        }
        case 'length': {
          if (!inc) return null;
          const o = inc.options.find(x => x.seconds === c.seconds);
          if (!o) return { say: `The manual gives ${inc.options.map(x => x.label).join(' or ')}.` };
          if (livePhase() !== 'choose') return { say: 'The timer is already running.' };
          choose(o.seconds);
          if (at !== idx.incubate) goStep(idx.incubate);
          else setHeard(said);
          return { say: `${o.label}. Done at ${clockText(Date.now() + o.seconds * 1000)}.` };
        }
        case 'photo':
          if (at !== idx.read) return null;
          leaveReview();
          setPhoto({ heard: said });
          return { say: '' };
        case 'sample':
          if (at < idx.incubate) return null;
          takeSample();
          return { say: 'Here’s the sample plate-reader export.' };
        case 'answer':
          // Readings to check on Run-Read: "yes" takes them.
          if (at === idx.read && checkView && !confirm) {
            if (!c.yes) return { say: 'Tap a well to fix it, or say “photo” to take it again.' };
            setPhoto(null);
            checkView.confirm();
            return { say: '' };
          }
          if (!confirm) return { say: 'There is no pending question to answer.', ok: false };
          setHeard(said);
          if (c.yes) {
            stopTimer();
            return { say: `Stopped. Put the plate back${tempText ? ` at ${tempText}` : ''}, or read it as it is.` };
          }
          setConfirm(false);
          return { say: 'It’s still running.' };
        case 'done': {
          // Several vials or tubes at once: just those, ticked.
          if (at === idx.standards && !bench.ready) {
            if (!c.refs.every(r => vials.some(v => v.id === r))) return null;
            const patch = Object.fromEntries(c.refs.map(r => [r, true]));
            leaveReview();
            setMany(patch);
            setHeard(said);
            return { say: standardsText(standardsLine(vials, { ...done, ...patch }), nextAfter(at)) };
          }
          if (at === idx.load) {
            const tubes = c.refs.map(r => plate.tubes.find(t => t.ref.toUpperCase() === r));
            if (tubes.some(t => !t)) return null;
            const patch = Object.fromEntries(tubes.map(t => [tubeKey(t!.index), true]));
            leaveReview();
            setMany(patch);
            setFlash(true);
            setHeard(said);
            return { say: tubeText(plate, currentTube(plate, { ...done, ...patch }), bench.load) };
          }
          return null;
        }
        case 'redo': {
          // A vial again, with every vial made from it; or a tube to load again (src/state/benchEdits.ts).
          const vialsOnly = c.refs.every(r => vials.some(v => v.id === r));
          if (vialsOnly ? bench.ready || at > idx.standards : at !== idx.load) return null;
          leaveReview();
          setHeard(said);
          // The step's own line says which vial is next.
          return { say: redo(p, c.refs), show: true };
        }
        case 'badWell':
          // A well gone wrong: what it held into the well named, or the next free one.
          setHeard(said);
          return { say: moveWells(p, c.wells, c.to), show: true };
        case 'results':
          if (at === idx.read && checkView) {
            setPhoto(null);
            return { say: spoken(checkSpoken(checkView.fit)) };
          }
          if (Object.keys(useRun.getState().readings).length) {
            navigate('/results');
            return { say: '' };
          }
          return at === idx.read ? { say: 'No readings yet. Show me the reader’s screen, or say “use the sample export”.' } : null;
      }
    },
    context: () => converseContext('run', p, { step: useRun.getState().step, ...(bench.steps[useRun.getState().step] ? { stepTitle: bench.steps[useRun.getState().step].title } : {}), ...(confirm ? { pending: 'Stop the incubation timer?' } : checkView ? { pending: 'Do the plate readings match the reader?' } : {}) }),
    protocol: () => p,
  };
  const { exchange, send, clear } = useRunVoice(handlers);
  const mic = useVoice(send);

  // A new step starts clean: no "You said", no question, nothing marked, no menu.
  useEffect(() => {
    setHeard(null);
    setFlash(false);
    setConfirm(false);
    setPlus(false);
    setPhoto(null);
    clear();
  }, [at, list, clear]);

  // A question comes in at the top of the step: bring it into view.
  useEffect(() => {
    if (exchange) scroller.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }, [exchange?.id]);

  // ─── Gloves on and off ─────────────────────────────────────────────────────────────────────────────────────────
  // The gloves button turns them on: Chapp listens for good (inside the tap, so the microphone may open). When the
  // conversation ends (a tap on Listening, the button again, or the microphone stopped), the buttons come back.
  const before = useRef(voice);
  useEffect(() => {
    const was = before.current;
    before.current = voice;
    if (list) return;
    if (voice === 'idle' && was === 'talking' && gloves) setGloves(false);
  }, [voice]);
  const glovesTap = () => (voice === 'idle' ? mic.talk() : mic.end());
  const glovesOn = (on: boolean) => {
    setGloves(on);
    if (on) mic.talk();
    else mic.end();
  };

  // Gloves on, "the screen stays on" (Gloves-Timer), where the browser can keep it on.
  useEffect(() => {
    if (!gloves || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let live = true;
    const hold = () =>
      navigator.wakeLock.request('screen').then(
        l => (live ? (lock = l) : void l.release()),
        () => {},
      );
    void hold();
    const again = () => document.visibilityState === 'visible' && void hold();
    document.addEventListener('visibilitychange', again);
    return () => {
      live = false;
      document.removeEventListener('visibilitychange', again);
      void lock?.release().catch(() => {});
    };
  }, [gloves]);

  // ─── Time's up ─────────────────────────────────────────────────────────────────────────────────────────────────
  const timeUpTitle = `Incubation done · ${lengthText(timer.total)}${tempText ? ` at ${tempText}` : ''}`;
  const timeUpBody = `Cool the plate to room temperature, then read at ${bench.readout.value} ${bench.readout.unit}.`;
  // Time's up rings from state/alarms.ts for every experiment, on any screen; this screen only draws it for review.

  // While the plate incubates, Chapp dozes (Run-Timer's sleepy face), whenever it has no other face to show.
  const expression = useSession(s => s.expression);
  const dozing = !gloves && !list && voice === 'idle' && at === idx.incubate && timer.phase === 'running';
  useEffect(() => {
    if (!dozing) return;
    if (expression === 'neutral') useSession.getState().setExpression('sleepy');
  }, [dozing, expression]);
  useEffect(() => {
    if (dozing) return;
    if (useSession.getState().expression === 'sleepy') useSession.getState().setExpression('neutral');
  }, [dozing]);
  useEffect(
    () => () => {
      if (useSession.getState().expression === 'sleepy') useSession.getState().setExpression('neutral');
    },
    [],
  );

  // ─── Drawing it ────────────────────────────────────────────────────────────────────────────────────────────────
  // The pictures say the run's numbers: the parts of the working reagent as sized, the plan's wells (less any that went
  // wrong), the incubation as chosen.
  const sized = useMemo<Sized>(
    () => ({
      mix: { parts: Object.fromEntries(bench.reagent.parts.map(x => [x.component, amountText(x.volume)])), make: amountText(bench.reagent.make) },
      wells: bench.plate.cells.filter(c => !bench.plate.bad.includes(c.well)).sort((a, b) => a.col - b.col || a.row - b.row).map(c => c.well),
      incubation: lengthText(timer.total),
      big: true,
    }),
    [bench, timer.total],
  );
  const words = useBench(s => s.words);
  const pictures = useStepPictures(p, run.procedure, bench.steps.map(s => s.id), run.photos, sized, { on: words, set: useBench.getState().setWords });
  const view: View = {
    p,
    bench,
    at,
    done,
    heard: heard ?? reviewHeard,
    timer,
    readings,
    photos: run.photos,
    picture: list ? null : pictures.pictureOf(at),
    words,
    flash,
    tickVial,
    tapTube,
    choose,
    finish,
    reset: resetTimer,
    toResults: () => navigate('/results'),
    check: at === idx.read ? checkView : null,
    reading,
    push: { state: push, enable: () => void enablePush() },
  };
  const step = bench.steps[at]!;
  const title = at === idx.incubate && timer.phase !== 'choose' ? 'Incubating' : step.title;
  const backLabel = (i: number) => {
    const s = bench.steps[i];
    if (!s) return 'Back';
    if (s.stage === 'standards') return 'Back to the standards';
    if (s.stage === 'mix') return 'Back to the working reagent';
    if (i === idx.load) return 'Back to loading the plate';
    if (s.step.add?.some(a => a.what === 'mix')) return 'Back to adding the reagent';
    if (i === idx.incubate) return timer.phase === 'choose' ? 'Back to the incubation' : 'Back to the timer';
    return `Back to ${s.title.toLowerCase()}`;
  };
  const backTo = list
    ? { to: `/run/${at + 1}`, label: 'Back to the current step' }
    : at === 0
      ? (procedureFor(p, run.procedure).prep ?? []).length
        ? { to: '/run/prep', label: 'Back to reagent prep' }
        : { to: '/protocol', label: 'Back to the conversation' }
      : { to: `/run/${at}${keep}`, label: backLabel(at - 1) };

  const stage = step.stage;
  const isAdd = step.step.add?.some(a => a.what === 'mix');
  const body = list ? (
    <AllSteps v={view} search="" />
  ) : gloves ? (
    at === idx.standards ? <GlovesStandards v={view} />
    : stage === 'mix' ? <GlovesMix v={view} />
    : at === idx.load ? <GlovesLoad v={view} />
    : isAdd ? <GlovesAdd v={view} />
    : at === idx.incubate ? <GlovesIncubate v={view} />
    : <GlovesRead v={view} />
  ) : at === idx.standards ? (
    <StandardsStep v={view} />
  ) : stage === 'mix' ? (
    <MixStep v={view} />
  ) : at === idx.load ? (
    <LoadStep v={view} />
  ) : isAdd ? (
    <AddStep v={view} />
  ) : at === idx.incubate ? (
    <IncubateStep v={view} />
  ) : (
    <ReadStep v={view} />
  );

  const taps = useTapNav({
    onNext: at < total - 1 ? () => goStep(at + 1) : undefined,
    onBack: at > 0 ? () => goStep(at - 1) : undefined,
    onSkip: at < total - 1 ? () => skipRunStep(bench.steps, at, navigate, keep) : undefined,
  });
  const said = view.heard;
  const photoReview = at === idx.read && (review === 'photo' || review === 'taken') ? review : null;
  const photoOpen = photo !== null || photoReview !== null;
  const timeUpOpen = timerReview === 'timeup';

  return (
    <div className="relative h-full overflow-hidden bg-bg">
      <div
        ref={scroller}
        onClick={list ? undefined : taps.onClick}
        className={cn(
          'flex h-full touch-manipulation flex-col overflow-y-auto px-5 pt-[calc(196px+var(--screen-top))] [scrollbar-width:none]',
          gloves ? 'pb-[calc(126px+var(--screen-bottom))]' : 'pb-[calc(92px+var(--screen-bottom))]',
        )}
      >
        {exchange ? (
          <Asked exchange={exchange} gloves={gloves} />
        ) : said && !photoOpen ? (
          gloves ? (
            <DotLabel size="md" className="mb-3.5 shrink-0 px-1">
              Heard “{said}”
            </DotLabel>
          ) : (
            <YouSaid text={said} />
          )
        ) : null}
        {body}
        {!list && !gloves && (
          <StepNav
            onBack={at > 0 ? () => goStep(at - 1) : undefined}
            onSkip={() => skipRunStep(bench.steps, at, navigate, keep)}
            next={at < total - 1 ? { title: bench.steps[at + 1]!.title, go: () => goStep(at + 1) } : undefined}
          />
        )}
      </div>

      {gloves ? (
        <GlovesBar listening={voice === 'talking'} onTap={glovesTap} />
      ) : (
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
      )}
      {!gloves &&
        (!list && at === idx.read ? (
          <ReadMenu
            open={plus}
            onClose={() => setPlus(false)}
            coverPlus={!typing}
            plusRef={plusRef}
            onPhoto={() => setPhoto({ heard: null })}
            onFile={onFile}
            onSample={takeSample}
          />
        ) : (
          <PlusMenu open={plus} onClose={() => setPlus(false)} coverPlus={!typing} plusRef={plusRef} />
        ))}

      <ChappHeader
        back={backTo}
        subtitle={list ? `${shortName(p)} · All ${total} steps` : undefined}
        pill={list ? undefined : <StepPill index={at} total={total} title={title} to={gloves ? undefined : '/run/all'} className="-mt-4" />}
      />
      {!list && <GlovesToggle on={gloves} onChange={glovesOn} />}
      {!list && <MinimizeRun titles={bench.steps.map(s => s.title)} className="right-[68px]" />}
      {!list && taps.overlay}

      <input
        ref={fileInput}
        type="file"
        accept={EXPORT_TYPES}
        hidden
        tabIndex={-1}
        onChange={e => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) onFile(f);
        }}
      />
      {photoOpen && (
        <PhotoView
          heard={photo?.heard ?? (photoReview ? 'photo' : null)}
          review={photoReview}
          status={photoReview === 'taken' ? { phase: 'read', line: `All ${plate.wells} wells are readable.` } : photoStatus}
          onPhoto={onPhoto}
          onResults={() => {
            setPhoto(null);
            setPhotoStatus(null);
            if (photoStatus?.phase === 'sample' || photoReview) {
              sampleIn(false);
              navigate('/results');
            }
          }}
          onRetake={() => {
            plateCall.current?.abort();
            setPhotoStatus(null);
          }}
          onClose={() => {
            leaveReview();
            plateCall.current?.abort();
            setPhoto(null);
            setPhotoStatus(null);
          }}
        >
          {gloves && <GlovesBar dark listening={voice === 'talking'} onTap={glovesTap} />}
        </PhotoView>
      )}
      {pictures.sheet}
      {timeUpOpen && (
        <TimeUp
          title={timeUpTitle}
          body={timeUpBody}
          onOpen={() => {
            leaveReview();
            if (idx.read >= 0 && at !== idx.read) goStep(idx.read);
          }}
        />
      )}
    </div>
  );
}
