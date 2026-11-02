import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { isAssay, type Protocol } from '../../../shared/protocol.ts';
import { unitsProblem } from '../../../shared/calc.ts';
import { amountText, DotLabel, Mark } from '../../components/lab/index.ts';
import { useProtocol } from '../../state/protocol.ts';
import { useRun } from '../../state/run.ts';
import { useSession } from '../../state/session.ts';
import { procedureFor, shortName } from '../protocol/content.ts';
import { RunChoose } from './RunChoose.tsx';
import { Sections, Ways, type Section } from './Sections.tsx';
import { Exchange, Shell, StartPill, turnAnswer, useFace, useFollow } from './Shell.tsx';
import { StandardsPage } from './StandardsPage.tsx';
import { allRepWord, changedKeys, fitPlan, planFor, planKeys, plural, repWord, sentenceOrder, type PlanKey, type PlanNumbers, type PlanView, type Way } from './plan.ts';
import { isPicked, runPlan, usePlanTalk, type Heard } from './usePlanTalk.ts';
import { usePlanView } from './view.ts';

type Review = 'plan' | 'ask' | 'heard' | 'full';

/**
 * The artboards' states, for review by address. Each sets the run's plan as the artboard has it (the user could have
 * said or tapped the same), then the screen is live: ?state=plan (Plan: asks how to make the standards), ask
 * (Plan-Ask: the four ways where the rack will go), heard (Plan-Heard: "Five standards, once. Samples in
 * triplicate."), full (Plan-Full: the kit's 9 chosen).
 */
const REVIEWS: Record<Review, { plan: PlanNumbers; picked: boolean; open: Section | ''; heard?: string; changed?: PlanKey[] }> = {
  plan: { plan: { samples: 12, replicates: 2, standardReplicates: 2, standards: 'kit' }, picked: false, open: '' },
  ask: { plan: { samples: 12, replicates: 2, standardReplicates: 2, standards: 'kit' }, picked: false, open: 'standards' },
  heard: {
    plan: { samples: 12, replicates: 3, standardReplicates: 1, standards: 'five' },
    picked: true,
    open: 'standards',
    heard: 'Five standards, once. Samples in triplicate.',
    changed: ['S', 'sr', 'nr', 'wells'],
  },
  full: { plan: { samples: 12, replicates: 2, standardReplicates: 2, standards: 'kit' }, picked: true, open: 'standards' },
};

/**
 * /plan: start or plan the run (Run-Choose, ?state=choose, from the protocol's right-edge handle), the plan itself
 * (Plan, Plan-Ask, Plan-Heard, Plan-Full) and the Standards page (Standards-2, ?state=standards).
 */
export function PlanScreen() {
  const [params] = useSearchParams();
  const state = params.get('state');
  if (state === 'choose') return <RunChoose />;
  if (state === 'standards') return <StandardsPage />;
  const review = state && state in REVIEWS ? (state as Review) : null;
  return <PlanBody key={review ?? 'live'} review={review} />;
}

function PlanBody({ review }: { review: Review | null }) {
  const seed = review ? REVIEWS[review] : null;
  // A review sets the run before the plan is first drawn, so nothing shows as just changed.
  const [seeded, setSeeded] = useState(!seed);
  useLayoutEffect(() => {
    if (!seed) return;
    useRun.getState().setPlan(seed.plan);
    usePlanView.getState().setPicked(seed.picked);
    if (seed.heard) useSession.getState().setExpression('happy');
    setSeeded(true);
  }, []);

  const protocolId = useRun(s => s.protocolId) ?? 'pierce-bca';
  const procedure = useRun(s => s.procedure);
  const { protocol, error } = useProtocol(protocolId);
  // A cell protocol has no standards, plate or reagent to plan: the screen says so instead.
  // A cell protocol has no standards, plate or reagent to plan; amounts in units Chapp cannot convert, nothing it can
  // work out. Either way the screen says so instead.
  const proc = protocol ? procedureFor(protocol, procedure) : null;
  const unworkable = protocol && proc && isAssay(proc) ? unitsProblem(protocol, proc) : null;
  const assay = !protocol || (isAssay(proc!) && !unworkable);
  const [initial] = useState<Heard | null>(() => (seed?.heard ? { id: 0, text: seed.heard, say: '', standards: true } : null));
  const { hear, heard, turn } = usePlanTalk(assay ? protocol : null, procedure, initial);
  const scroller = useRef<HTMLDivElement>(null);
  useFollow(scroller, turn ? `${turn.id}:${turn.phase}` : null);

  const standards = useRun(s => s.standards);
  const subtitle = protocol ? `${shortName(protocol)} · Plan` : 'Plan';

  return (
    <Shell
      subtitle={subtitle}
      scroller={scroller}
      onUtterance={hear}
      next={assay ? <StartPill protocol={protocol} /> : null}
    >
      {error && (
        <p role="alert" className="mb-6 shrink-0 px-1 text-[17px] leading-6 font-medium text-ink">
          {error}
        </p>
      )}
      {protocol && !assay && (
        <p className="mb-6 shrink-0 px-1 text-[17px] leading-6 font-medium text-ink">
          {unworkable ? (
            <>
              I can’t work out <b className="font-bold">{shortName(protocol)}</b>’s amounts: {unworkable}. Start follows its steps as printed, one at a time.
            </>
          ) : proc?.standardCurve ? (
            <>
              I can’t plan <b className="font-bold">{shortName(protocol)}</b> here: planning works for plate assays with one reagent, like BCA. Start follows its steps one at a time.
            </>
          ) : (
            <>
              <b className="font-bold">{shortName(protocol)}</b> has no standards or plate to plan. Start follows its steps one at a time.
            </>
          )}
        </p>
      )}
      {protocol && seeded && assay && <PlanContent protocol={protocol} procedure={procedure} heard={heard} open0={seed?.open ?? ''} changed0={seed?.changed ?? []} />}
      {turn && (
        <div className="mt-8 flex shrink-0 flex-col gap-5">
          <Exchange text={turn.text} answer={turnAnswer(turn)} thinking={turn.phase === 'thinking'} sources={turn.phase === 'reply' ? turn.sources : undefined} />
        </div>
      )}
    </Shell>
  );
}

type ContentProps = { protocol: Protocol; procedure: string; heard: Heard | null; open0: Section | ''; changed0: PlanKey[] };

/** The plan: what was said, Chapp's sentence (or its question), and the four sections, highlighting what changed. */
function PlanContent({ protocol, procedure, heard, open0, changed0 }: ContentProps) {
  const samples = useRun(s => s.samples);
  const replicates = useRun(s => s.replicates);
  const standardReplicates = useRun(s => s.standardReplicates);
  const standards = useRun(s => s.standards);
  const picked = isPicked(usePlanView(s => s.picked), standards);
  const edits = useRun(s => s.edits);
  const plan = useMemo(() => ({ samples, replicates, standardReplicates, standards, edits }), [samples, replicates, standardReplicates, standards, edits]);
  const v = useMemo(() => planFor(protocol, procedure, plan), [protocol, procedure, plan]);

  const [open, setOpen] = useState<Section | ''>(open0);
  const [changed, setChanged] = useState<PlanKey[]>(changed0);

  // A number wears the highlighter after it changed, whatever changed it (a tap, a plan said, Chapp's reply), until
  // the next change or a section is opened or closed (Plan.dc.html).
  const keys = planKeys(v, picked);
  const last = useRef(keys);
  const signature = JSON.stringify(keys);
  useEffect(() => {
    const diff = changedKeys(last.current, keys);
    last.current = keys;
    if (diff.length) setChanged(diff);
  }, [signature]);

  // Standards said aloud: their section opens, the rack in view (Plan-Heard).
  useEffect(() => {
    if (heard?.standards && heard.id > 0) setOpen('standards');
  }, [heard?.id]);

  // Asking with the four ways where the rack will go, Chapp thinks along (Plan-Ask).
  useFace(!picked && open === 'standards' ? 'thinking' : null);

  const hl = (...ks: PlanKey[]) => ks.some(k => changed.includes(k));
  const apply = (patch: Partial<PlanNumbers>) => useRun.getState().setPlan(fitPlan(protocol, procedure, { ...runPlan(), ...patch }));
  const pick = (way: Way) => {
    usePlanView.getState().setPicked(true);
    apply({ standards: way });
    setOpen('standards');
  };

  return (
    <div className="flex shrink-0 flex-col">
      {heard && (
        <>
          <DotLabel className="mb-1.5 px-1">You said</DotLabel>
          <p className="m-0 mb-5 px-1 text-[20px] leading-[26px] font-bold text-ink">{heard.text}</p>
        </>
      )}
      {picked ? (
        <Sentence v={v} heard={!!heard} hl={hl} still={!!heard && !changed.includes('wr')} />
      ) : (
        <>
          <p aria-label="Chapp's answer" className="m-0 mb-6 px-1 text-[17px] leading-6 font-medium text-ink">
            The kit reads <b className="font-bold whitespace-nowrap">{v.range}</b>. How do you want to make the standards?
          </p>
          {open !== 'standards' && <Ways v={v} value={null} onPick={pick} className="mb-7 px-1" />}
        </>
      )}
      <Sections
        protocol={protocol}
        v={v}
        picked={picked}
        open={open}
        onOpen={o => {
          setOpen(o);
          setChanged([]);
        }}
        hl={hl}
        onPick={pick}
        onSamples={n => apply({ samples: n })}
        onReplicates={k => apply({ replicates: k })}
        onStandardReplicates={k => apply({ standardReplicates: k })}
      />
    </div>
  );
}

/**
 * "12 samples and 9 standards, all in duplicate: 42 wells, 10 mL of working reagent." Standards come first right after
 * the user named them, and "still" says the reagent stayed the same (Plan-Heard).
 */
function Sentence({ v, heard, hl, still }: { v: PlanView; heard: boolean; hl: (...k: PlanKey[]) => boolean; still: boolean }) {
  const { samples: n, replicates: nr, standardReplicates: sr } = v.plan;
  const order = sentenceOrder(v.plan, heard);
  const bold = (text: string, ...ks: PlanKey[]) => (
    <Mark on={hl(...ks)}>
      <b className="font-bold whitespace-nowrap">{text}</b>
    </Mark>
  );
  const ns = bold(plural(n, 'sample'), 'n');
  const ss = bold(plural(v.vials, 'standard'), 'S');
  const nRep = <Mark on={hl('nr')}>{repWord(nr)}</Mark>;
  const sRep = <Mark on={hl('sr')}>{repWord(sr)}</Mark>;
  return (
    <p aria-label="Chapp's answer" className="m-0 mb-6 px-1 text-[17px] leading-6 font-medium text-ink">
      {order === 'same' ? (
        <>
          {ns} and {ss}, <Mark on={hl('nr', 'sr')}>{allRepWord(nr)}</Mark>
        </>
      ) : order === 'differ' ? (
        <>
          {ns} {nRep} and {ss} {sRep}
        </>
      ) : (
        <>
          {ss} {sRep} and {ns} {nRep}
        </>
      )}
      : {bold(plural(v.plate.wells, 'well'), 'wells')}, {still ? 'still ' : ''}
      {bold(amountText(v.reagent.make), 'wr')} of {v.reagent.name.toLowerCase()}.
    </p>
  );
}
