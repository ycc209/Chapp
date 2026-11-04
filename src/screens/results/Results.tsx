import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { unitOf } from '../../../shared/calc.ts';
import { sampleReadings } from '../../../shared/fit.ts';
import { analysisOf } from '../../../shared/protocol.ts';
import { ChappHeader } from '../../components/chapp/ChappHeader.tsx';
import { MarkChips, ResultRows, SampleDataTag, SectionHead, StandardCurve, benchSteps, curveLabels } from '../../components/lab/index.ts';
import { BottomBar } from '../../components/voice/BottomBar.tsx';
import { cn } from '../../lib/cn.ts';
import { useProtocol } from '../../state/protocol.ts';
import { useRun } from '../../state/run.ts';
import { useSession } from '../../state/session.ts';
import { speak } from '../../voice/speak.ts';
import { ERROR_LINE } from '../home/HomeCenter.tsx';
import { PlusMenu } from '../home/PlusMenu.tsx';
import { TypingBar } from '../home/TypingBar.tsx';
import { SCREEN_WASH } from '../home/bar.ts';
import { useConverse } from '../home/useConverse.ts';
import { shortName } from '../protocol/content.ts';
import { useFace } from '../share/parts.tsx';
import {
  PAGES,
  analyzeRun,
  concentrationList,
  concentrationSay,
  curveSay,
  parseHeard,
  rerunLabel,
  reruns,
  runPlate,
  sameWells,
  sayText,
  tabLabels,
  type Say,
} from './analysis.ts';
import { Pager } from './Pager.tsx';

const PILL = 'flex min-h-10 cursor-pointer items-center rounded-[20px] px-[18px] text-[15px] leading-5 font-semibold no-underline outline-none focus-visible:ring-2 focus-visible:ring-blue';
const WHITE_PILL = cn(PILL, 'bg-white text-ink shadow-[0_1px_2px_rgba(17,17,19,0.06),0_2px_8px_rgba(17,17,19,0.04)]');
const INK_PILL = cn(PILL, 'gap-[7px] bg-ink text-white');

const pageFrom = (asked: string | null) => {
  const i = PAGES.indexOf(asked as (typeof PAGES)[number]);
  if (i >= 0) return i;
  const n = Number(asked);
  return Number.isInteger(n) && n >= 1 && n <= PAGES.length ? n - 1 : 0;
};

/** A sentence with its bold parts, as the artboards set Chapp's answers. */
function Said({ say }: { say: Say }) {
  return say.map((part, i) =>
    typeof part === 'string' ? (
      part
    ) : (
      <b key={i} className="font-bold">
        {part.b}
      </b>
    ),
  );
}

/**
 * Results (Results-Swipe-Curve, Results-Swipe): the plate read back two ways, swiped or picked from the tabs — the
 * standard curve (the straight regression line the concentrations are read from, dashed, with its R² beside it and
 * its equation below, and no other line) and the samples' protein concentration (µg/mL with each sample's CV). Every
 * number is analyzePlate() over the
 * run's readings in the wells plateMap() gave them; Chapp's sentence above says what matters on that page. Chapp's
 * example readings carry the "Sample data" tag in the corner the whole time (STORYBOARD ⑦). With no readings yet, the
 * reader's export is asked for, and the example plate is one tap (or "here's a sample plate-reader export") away.
 *
 * For design review a page opens from the address: ?page=curve|conc.
 */
export function ResultsScreen() {
  useFace('excited');
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [page, setPage] = useState(() => pageFrom(params.get('page')));
  /** An answer worked out here for one page ("0.6 mg/mL is too high…"), until the page changes. */
  const [note, setNote] = useState<{ page: number; say: Say } | null>(null);
  const [talked, setTalked] = useState(false);
  const [typing, setTyping] = useState(false);
  const [plus, setPlus] = useState(false);
  const plusRef = useRef<HTMLButtonElement>(null);

  const protocolId = useRun(s => s.protocolId);
  const procedure = useRun(s => s.procedure);
  const samples = useRun(s => s.samples);
  const replicates = useRun(s => s.replicates);
  const standardReplicates = useRun(s => s.standardReplicates);
  const standards = useRun(s => s.standards);
  const edits = useRun(s => s.edits);
  const readings = useRun(s => s.readings);
  const from = useRun(s => s.readingsFrom);
  const setReadings = useRun(s => s.setReadings);
  const { protocol, error } = useProtocol(protocolId);
  const voice = useSession(s => s.voice);
  const heardSoFar = useSession(s => s.heard);
  const interim = useSession(s => s.interim);
  const { turn, send } = useConverse('results');

  const plate = useMemo(() => {
    if (!protocol) return null;
    try {
      return runPlate(protocol, { procedure, samples, replicates, standardReplicates, standards, edits });
    } catch {
      return null;
    }
  }, [protocol, procedure, samples, replicates, standardReplicates, standards, edits]);
  const hasReadings = Object.keys(readings).length > 0;
  const analysis = useMemo(
    () => (protocol && plate && hasReadings ? analyzeRun(protocol, plate.roles, readings) : null),
    [protocol, plate, readings, hasReadings],
  );
  const sample = from === 'sample' && hasReadings;
  const labels = useMemo(() => (protocol ? curveLabels(protocol, procedure) : null), [protocol, procedure]);
  // The unit the standards and results are in: the kit's own (nmol/well), or µg/mL.
  const unit = useMemo(() => {
    try {
      return protocol ? unitOf(protocol, procedure) : 'µg/mL';
    } catch {
      return 'µg/mL';
    }
  }, [protocol, procedure]);
  // Back goes to the run's Read step (Run-Read: Step 6 of 6 for the BCA plate); /run/:step counts from 1.
  const readStep = useMemo(() => {
    if (!protocol) return null;
    try {
      const steps = benchSteps(protocol, procedure);
      const i = steps.findIndex(s => s.stage === 'read');
      return i >= 0 ? i + 1 : steps.length;
    } catch {
      return null;
    }
  }, [protocol, procedure]);

  // The example plate follows the plan: changed since it was loaded (five standards once, samples ×3…), it is drawn
  // again for the new wells, so the analysis always reads the plate the plan lays out.
  useEffect(() => {
    if (protocol && plate && from === 'sample' && hasReadings && !sameWells(readings, plate.roles)) {
      setReadings(sampleReadings(plate.roles, analysisOf(protocol).fit), 'sample');
    }
  }, [protocol, plate, from, readings, hasReadings, setReadings]);

  // The page in the address, so each one can be opened (and reloaded) on its own.
  useEffect(() => {
    const id = PAGES[page]!;
    if ((params.get('page') ?? PAGES[0]) === id) return;
    setParams(
      prev => {
        const next = new URLSearchParams(prev);
        if (page) next.set('page', id);
        else next.delete('page');
        return next;
      },
      { replace: true },
    );
  }, [page]);

  const loadSample = () => {
    if (!protocol || !plate) return;
    setReadings(sampleReadings(plate.roles, analysisOf(protocol).fit), 'sample');
    setTalked(false);
    setNote(null);
  };

  /** A page picked by tab or swipe: its own sentence comes back. */
  const turnTo = (p: number) => {
    setPage(p);
    setTalked(false);
    setNote(n => (n?.page === p ? n : null));
  };

  // What was said or typed: a page, the example plate or Share are answered here, read aloud; the rest goes to Chapp.
  const heard = (text: string) => {
    const h = parseHeard(text);
    if (!h || (!analysis && h.kind !== 'sample' && h.kind !== 'share')) {
      setTalked(true);
      setNote(null);
      void send(text);
      return;
    }
    setTalked(false);
    setNote(null);
    let say: Say = [];
    // A sentence that is not the page's own stays on that page until the page changes.
    let hold: number | null = null;
    switch (h.kind) {
      case 'share':
        navigate('/share');
        return;
      case 'sample':
        if (from !== 'plate' || !analysis) return loadSample();
        say = ['These are your plate’s readings; I’ll keep them.'];
        hold = page;
        break;
      case 'page': {
        const p = PAGES.indexOf(h.page);
        setPage(p);
        say = pageSay(p);
        break;
      }
    }
    if (hold !== null) setNote({ page: hold, say });
    void speak(sayText(say)).catch(() => {});
  };

  const pageSay = (p: number): Say => (!analysis ? [] : PAGES[p] === 'curve' ? curveSay(analysis, unit) : concentrationSay(analysis, unit));

  // Held, the words show in the bar's own bubble.
  const hearing = voice !== 'idle' && voice !== 'holding' && (heardSoFar || interim);
  const answer: ReactNode = hearing ? (
    <>
      {heardSoFar}
      {interim && <span className="text-faint">{heardSoFar && !heardSoFar.endsWith(' ') ? ' ' : ''}{interim}</span>}
    </>
  ) : talked && turn ? (
    turn.phase === 'thinking' ? <span className="text-muted">…</span> : turn.phase === 'reply' ? turn.say : ERROR_LINE
  ) : note && note.page === page ? (
    <Said say={note.say} />
  ) : !protocolId ? (
    'There is no run yet. Find a protocol first.'
  ) : error ? (
    error
  ) : !protocol ? (
    ''
  ) : !hasReadings ? (
    'No readings yet. Give me the plate reader’s export, or try my sample plate.'
  ) : !analysis ? (
    'These readings don’t make a curve: the plan’s standard wells were not read. Check the plan, or try my sample plate.'
  ) : (
    <Said say={pageSay(page)} />
  );

  const rerun = analysis ? rerunLabel(analysis) : null;
  const tabs = analysis ? tabLabels(unit) : null;

  // In PAGES' order: the curve, then the concentrations.
  const pages = analysis
    ? [
        {
          label: 'Standard curve',
          content: (
            <>
              <SectionHead>Standard curve</SectionHead>
              <StandardCurve analysis={analysis} xLabel={labels?.x} yLabel={labels?.y} caption={false} regression />
            </>
          ),
        },
        {
          label: 'Protein concentration',
          content: (
            <>
              <SectionHead aside={`${unit} · CV`}>Your samples</SectionHead>
              <ResultRows rows={concentrationList(analysis)} side="cv" />
            </>
          ),
        },
      ]
    : null;

  return (
    <div className="relative h-full overflow-hidden bg-bg">
      <div className="flex h-full flex-col overflow-y-auto px-5 pt-[calc(196px+var(--screen-top))] pb-[calc(168px+var(--screen-bottom))] [scrollbar-width:none]">
        <div className="flex shrink-0 flex-col">
          <div aria-live="polite" className="mb-[18px] min-h-[72px]">
            <p aria-label="Chapp's answer" className="m-0 px-1 text-[17px] leading-6 font-medium text-ink">
              {answer}
            </p>
          </div>
          {pages && tabs && (
            <>
              <MarkChips
                variant="tabs"
                aria-label="Show the results as"
                options={tabs.map((t, i) => ({ value: i, label: t }))}
                value={page}
                onChange={turnTo}
                className="mb-3"
              />
              <Pager pages={pages} page={page} onPage={turnTo} />
            </>
          )}
        </div>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[6] flex flex-col pt-7" style={{ background: SCREEN_WASH }}>
        {voice !== 'talking' && protocol && (
          <div aria-label="Next" className="pointer-events-none relative flex shrink-0 justify-center gap-2 px-5 pt-2 [&>*]:pointer-events-auto">
            {analysis ? (
              <>
                {rerun && (
                  <Link to="/plan" state={{ from: 'results', rerun: reruns(analysis) }} className={WHITE_PILL}>
                    <span>{rerun}</span>
                  </Link>
                )}
                <Link to="/share" className={INK_PILL}>
                  Share
                </Link>
              </>
            ) : (
              <>
                {readStep && (
                  <Link to={`/run/${readStep}`} className={WHITE_PILL}>
                    Back to the run
                  </Link>
                )}
                {plate && (
                  <button type="button" onClick={loadSample} className={cn(INK_PILL, 'border-0')}>
                    Use the sample export
                  </button>
                )}
              </>
            )}
          </div>
        )}
        <div className="pointer-events-auto px-5 pt-2 pb-[var(--screen-bottom)]">
          {typing ? (
            <TypingBar
              wash={false}
              plusOpen={plus}
              plusRef={plusRef}
              onPlus={() => setPlus(o => !o)}
              onSend={heard}
              onClose={() => {
                setTyping(false);
                setPlus(false);
              }}
            />
          ) : (
            <BottomBar wash={false} onPlus={() => setPlus(o => !o)} onKeyboard={() => setTyping(true)} onUtterance={heard} />
          )}
        </div>
      </div>

      {sample && <SampleDataTag className="absolute top-[calc(66px+var(--screen-top))] right-5 z-[6]" />}
      <PlusMenu open={plus} onClose={() => setPlus(false)} coverPlus={!typing} plusRef={plusRef} />
      <ChappHeader
        subtitle={protocol ? `${shortName(protocol)} · Results` : 'Results'}
        back={{ to: readStep ? `/run/${readStep}` : '/', label: 'Back to the run' }}
      />
    </div>
  );
}
