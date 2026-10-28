import { useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { standardSeries, toMicroliters } from '../../../shared/calc.ts';
import { analyzePlate, sampleReadings } from '../../../shared/fit.ts';
import type { Protocol } from '../../../shared/protocol.ts';
import { useProtocol } from '../../state/protocol.ts';
import { AmountCard, StepPill, TimerNotice } from './Cards.tsx';
import { NumberedList, StepList, type StepItem } from './Lists.tsx';
import { MarkChips } from './MarkChips.tsx';
import {
  amountText,
  benchSteps,
  commonRows,
  concentrationRows,
  concentrationText,
  curveLabels,
  halvingSeries,
  massRows,
  plateMap,
  r2Text,
  reagentPlan,
  shadeLevels,
  stepDetail,
  wellRoles,
} from './model.ts';
import { PlateMap } from './PlateMap.tsx';
import { ReagentParts } from './Reagent.tsx';
import { ResultRows } from './Results.tsx';
import { StandardCurve } from './StandardCurve.tsx';
import { StandardsTable } from './StandardsTable.tsx';
import { BenchLine, DotLabel, Mark, SampleDataTag, SectionHead } from './Text.tsx';
import { DoneAt, Timer } from './Timer.tsx';
import { VialDot, VialNow, VialRack } from './Vials.tsx';

/**
 * /lab: every bench part in each of its states, drawn from the real BCA protocol for the storyboard's run (12 samples
 * in duplicate) and Plan-Heard's (five standards once, samples ×3). For review, and for the Plan, Run and Results
 * screens to copy from. `?part=<id>&top=<px>` shows one part alone, `top` px from the top of the screen and 20 px in,
 * where its artboard puts it, so a screenshot lines up with the artboard's (`&w=346` narrows it as on Results; `&left=56&w=322` puts it in a Plan panel).
 */
export function LabGallery() {
  const { protocol, error } = useProtocol('pierce-bca');
  const [params] = useSearchParams();
  if (error) return <Message>{error}</Message>;
  if (!protocol) return <Message>Loading the BCA protocol…</Message>;
  return <Parts p={protocol} only={params.get('part')} top={Number(params.get('top') ?? 196)} left={Number(params.get('left') ?? 20)} width={params.get('w')} />;
}

function Message({ children }: { children: ReactNode }) {
  return <p className="px-6 pt-28 text-[17px] leading-6 text-text">{children}</p>;
}

// A fixed moment for the frozen timers, so the gallery's shots compare: 24:37 left of 30 min, as drawn.
const LEFT = 1477;

function Parts({ p, only, top, left, width }: { p: Protocol; only: string | null; top: number; left: number; width: string | null }) {
  const proc = 'microplate';
  const perWell = toMicroliters(p.procedures.find(x => x.id === proc)!.sample!);
  // The storyboard's run: the kit's 9 in duplicate, 12 samples in duplicate.
  const series = useMemo(() => standardSeries(p, proc, 2), [p]);
  const plan = useMemo(() => plateMap({ standards: series.vials, standardReplicates: 2, samples: 12, sampleReplicates: 2 }), [series]);
  // Plan-Heard: five standards once, samples in triplicate.
  const heard = useMemo(() => halvingSeries(2000, 4, 1, perWell), [perWell]);
  const heardPlan = useMemo(() => plateMap({ standards: heard.vials, standardReplicates: 1, samples: 12, sampleReplicates: 3 }), [heard]);
  const reagent = reagentPlan(p, proc, plan.wells);
  const heardReagent = reagentPlan(p, proc, heardPlan.wells);
  const triplicate = reagentPlan(p, proc, plateMap({ standards: series.vials, standardReplicates: 3, samples: 12, sampleReplicates: 3 }).wells);
  const analysis = useMemo(() => {
    const roles = wellRoles(plan);
    return analyzePlate(roles, sampleReadings(roles, p.analysis!.fit), p.analysis!.fit);
  }, [p, plan]);
  const labels = curveLabels(p, proc);
  const steps = benchSteps(p, proc);
  const levels = shadeLevels(series.vials);

  // Interactive states, so the parts can be tried here.
  const [done, setDone] = useState<Record<string, boolean>>({ A: true, B: true, C: true });
  const [loading, setLoading] = useState(9);
  const [minutes, setMinutes] = useState(30);
  const [tab, setTab] = useState(0);
  const now = useMemo(() => Date.now(), []);

  const tickVial = (id: string) => {
    const i = series.vials.findIndex(v => v.id === id);
    const on = !done[id];
    // As on Run-Standards: ticking one ticks everything before it; unticking one unticks everything after it.
    setDone(Object.fromEntries(series.vials.map((v, j) => [v.id, on ? j <= i || !!done[v.id] : j < i && !!done[v.id]])));
  };
  const D = series.vials[3]!;
  const allDone = Object.fromEntries(series.vials.map(v => [v.id, true]));
  const mass = massRows(analysis, 20);
  const same = commonRows(analysis);
  const runSteps: StepItem[] = steps.map((s, i) => ({
    title: s.title,
    detail: stepDetail(p, s, { vials: series.vials.length, reagent: reagent.make, tubes: plan.tubes.length, loaded: i === 2 ? 9 : undefined }),
    state: i < 2 ? 'done' : i === 2 ? 'now' : 'next',
    to: `/run/${i + 1}`,
  }));
  const bsa = p.components.find(c => c.role === 'standard')!;

  const parts: Part[] = [
    { group: 'Standard vials', id: 'rack-plan', title: 'The rack, as planned', boards: 'Plan · Plan-Full · Standards-2', node: <VialRack vials={series.vials} /> },
    {
      id: 'rack-run',
      title: 'Making them: 3 of 9 done, D now (tap a vial)',
      boards: 'Run-Standards',
      node: <VialRack vials={series.vials} done={done} onVial={tickVial} />,
    },
    { id: 'rack-done', title: 'All 9 made', boards: 'Run-Standards · all done', node: <VialRack vials={series.vials} done={allDone} /> },
    { id: 'rack-ready', title: 'Already made: ready, and what the plate takes', boards: 'Plan · Already made', node: <VialRack vials={series.vials} ready={{ need: 2 * perWell }} /> },
    { id: 'rack-heard', title: 'Five standards once: halved from 2,000', boards: 'Plan-Heard', node: <VialRack vials={heard.vials} /> },
    {
      id: 'vial-now',
      title: 'The vial now, gloves on',
      boards: 'Gloves-Standards',
      node: <VialNow vial={D} level={levels[3]!} />,
    },
    {
      id: 'vial-dots',
      title: 'Vial dots: plain, blank, done, now',
      boards: 'Gloves-Standards',
      node: (
        <div className="flex items-center gap-4 px-1">
          <VialDot id="E" level={4} />
          <VialDot id="H" level={1} />
          <VialDot id="I" level={0} blank />
          <VialDot id="A" level={8} state="done" />
          <VialDot id="D" level={5} state="now" />
          <VialDot id="D" level={5} state="now" size={56} />
        </div>
      ),
    },
    { group: 'Dilution table', id: 'table-run', title: 'Making them, gloves on: D is the yellow row', boards: 'Gloves-Standards', node: <StandardsTable vials={series.vials} done={{ A: true, B: true, C: true }} /> },
    { id: 'table-done', title: 'All done', boards: 'Gloves-Standards · all done', node: <StandardsTable vials={series.vials} done={allDone} /> },
    { id: 'table-heard', title: 'Five standards once', boards: 'Plan-Heard', node: <StandardsTable vials={heard.vials} /> },
    { group: '96-well plate', id: 'plate-plan', title: `The whole plan: ${plan.wells} of 96`, boards: 'Plan · Plate', node: <PlateMap plan={plan} /> },
    {
      id: 'plate-load',
      title: `Loading: tube ${loading + 1} of ${plan.tubes.length}, ${plan.tubes[loading]?.name ?? 'all loaded'} → ${plan.tubes[loading]?.wells.join(' · ') ?? ''} (tap the yellow wells)`,
      boards: 'Run-Load',
      node: <PlateMap plan={plan} now={loading} onTube={t => setLoading(t === loading ? Math.min(plan.tubes.length, t + 1) : t)} />,
    },
    { id: 'plate-gloves', title: 'Loading, gloves on (3 px gaps)', boards: 'Gloves-Load', node: <PlateMap plan={plan} now={9} dense /> },
    { id: 'plate-loaded', title: 'All 42 wells loaded', boards: 'Run-Load · all done', node: <PlateMap plan={plan} now={plan.tubes.length} /> },
    { id: 'plate-heard', title: `Five standards once, 12 samples ×3: ${heardPlan.wells} wells`, boards: 'Plan-Heard · Plate', node: <PlateMap plan={heardPlan} /> },
    {
      group: 'Working reagent',
      id: 'reagent-plan',
      title: `${plan.wells} wells × ${amountText(reagent.perWell)} = ${amountText(reagent.need)} → make ${amountText(reagent.make)} (A : B = ${reagent.ratio})`,
      boards: 'Plan · Working reagent',
      node: <ReagentParts plan={reagent} />,
    },
    { id: 'reagent-heard', title: `Plan-Heard: ${heardPlan.wells} wells, still ${amountText(heardReagent.make)} (marked: just changed)`, boards: 'Plan-Heard', node: <ReagentParts plan={heardReagent} marked /> },
    { id: 'reagent-triplicate', title: `“Make it triplicates”: 63 wells → ${amountText(triplicate.make)}`, boards: 'Storyboard ④', node: <ReagentParts plan={triplicate} marked /> },
    {
      id: 'reagent-run',
      title: 'Mixing it',
      boards: 'Run-Mix',
      node: <ReagentParts plan={reagent} size="run" then={['Swirl until it is clear green']} note="Add B last. Cloudy, then green." />,
    },
    { id: 'reagent-gloves', title: 'Mixing it, gloves on', boards: 'Gloves-Mix', node: <ReagentParts plan={reagent} size="gloves" note="Add B last. Swirl until it is clear green." /> },
    {
      group: 'Steps',
      id: 'list-plan',
      title: 'Numbered lines',
      boards: 'Run-Choose · Run-Add · Run-Read · Protocol-Full',
      node: (
        <NumberedList
          title="This plan"
          items={[
            <><b className="font-bold">12 samples</b>, in duplicate</>,
            <><b className="font-bold">Kit’s 9</b> standards, in duplicate</>,
            <><b className="font-bold">{plan.wells} wells</b> · <b className="font-bold">{amountText(reagent.make)}</b> working reagent</>,
          ]}
        />
      ),
    },
    { id: 'steps', title: 'All the steps, at step 3', boards: 'Run-List', node: <StepList steps={runSteps} /> },
    {
      id: 'pill',
      title: 'The step pill: a link to all steps; plain with gloves on',
      boards: 'Run-* · Gloves-*',
      node: (
        <div className="flex flex-col items-center gap-3">
          <StepPill index={0} total={steps.length} title={steps[0]!.title} to="/lab" />
          <StepPill index={2} total={steps.length} title={steps[2]!.title} to="/lab" />
          <StepPill index={4} total={steps.length} title="Incubating" />
        </div>
      ),
    },
    {
      group: 'Timer',
      id: 'incubate',
      title: 'Choose before the clock starts',
      boards: 'Run-Incubate · Gloves-Incubate',
      node: (
        <div className="flex flex-col gap-3">
          <MarkChips aria-label="How long to incubate" options={[{ value: 30, label: '30 min' }, { value: 120, label: '2 h' }]} value={minutes} onChange={setMinutes} />
          <DoneAt seconds={minutes * 60} marked={minutes !== 30} />
          <div className="mt-2 px-1">
            <p className="m-0 mb-1 text-[15px] leading-5 font-semibold text-text">Incubate at</p>
            <BenchLine size="xl">37 °C · 30 min</BenchLine>
            <DoneAt seconds={1800} size="gloves" className="mt-2" />
          </div>
        </div>
      ),
    },
    { id: 'timer-run', title: 'Running: 24:37 left', boards: 'Run-Timer', node: <Timer total={1800} endsAt={now + LEFT * 1000} now={now} temperature="37 °C" /> },
    { id: 'timer-run-live', title: 'Running, live: 2 minutes from when this page opened', boards: 'Run-Timer', node: <Timer total={120} endsAt={now + 120000} temperature="37 °C" /> },
    { id: 'timer-run-stopped', title: 'Stopped', boards: 'Run-Timer · stopped', node: <Timer total={1800} left={LEFT} now={now} temperature="37 °C" /> },
    { id: 'timer-run-done', title: 'Done', boards: 'Run-Timer · done', node: <Timer total={1800} endsAt={now - 1000} now={now} temperature="37 °C" /> },
    { id: 'timer-gloves', title: 'Running, gloves on', boards: 'Gloves-Timer', node: <Timer size="gloves" label="Incubating · 37 °C" total={1800} endsAt={now + LEFT * 1000} now={now} /> },
    { id: 'timer-gloves-stopped', title: 'Stopped, gloves on', boards: 'Gloves-Timer · stopped', node: <Timer size="gloves" label="Incubating · 37 °C" total={1800} left={LEFT} now={now} /> },
    { id: 'timer-gloves-done', title: 'Done, gloves on', boards: 'Gloves-Timer · done', node: <Timer size="gloves" total={1800} left={0} now={now} /> },
    {
      id: 'notice',
      title: 'Time’s up, on the lock screen',
      boards: 'Timer-Done',
      node: (
        <div className="rounded-[28px] bg-[#101114] px-3 py-6">
          <TimerNotice title="Incubation done · 30 min at 37 °C" body="Cool the plate to room temperature, then read at 562 nm." />
        </div>
      ),
    },
    {
      group: 'Results',
      id: 'tabs',
      title: 'Example readings carry the tag; the four pages',
      boards: 'Results-Swipe*',
      node: (
        <div className="flex flex-col gap-3">
          <SampleDataTag className="self-start" />
          <MarkChips
            variant="tabs"
            aria-label="Show the results as"
            options={['µg/mL', '20 µg', `${(same?.target ?? 0) / 1000} mg/mL`, 'Curve'].map((label, value) => ({ value, label }))}
            value={tab}
            onChange={setTab}
          />
        </div>
      ),
    },
    {
      id: 'rows-conc',
      title: 'µg/mL and CV: Sample 7 above the top standard',
      boards: 'Results-Swipe',
      node: (
        <div>
          <SectionHead aside="µg/mL · CV">Your samples</SectionHead>
          <ResultRows rows={concentrationRows(analysis)} side="cv" />
        </div>
      ),
    },
    {
      id: 'rows-mass',
      title: `µL for 20 µg: Sample ${mass.most?.ref} needs the most, ${mass.most?.volume.toFixed(1)} µL; lanes of ${mass.lane} µL`,
      boards: 'Results-Swipe-Volume',
      node: (
        <div>
          <SectionHead aside="µL for 20 µg">Your samples</SectionHead>
          <ResultRows rows={mass.rows} />
        </div>
      ),
    },
    {
      id: 'rows-same',
      title: `All at ${(same?.target ?? 0) / 1000} mg/mL: take, then buffer`,
      boards: 'Results-Swipe-Same',
      node: same && (
        <div>
          <SectionHead aside="take · buffer, µL">Per 100 µL</SectionHead>
          <ResultRows rows={same.rows} side="buffer" />
        </div>
      ),
    },
    {
      id: 'curve',
      title: `The curve: ${analysis.fit.kind}, blank ${analysis.blank.mean.toFixed(3)}`,
      boards: 'Results-Swipe-Curve',
      node: (
        <div>
          <SectionHead aside={`R² ${r2Text(analysis.fit.r2)}`}>Standard curve</SectionHead>
          <StandardCurve analysis={analysis} xLabel={labels.x} yLabel={labels.y} />
        </div>
      ),
    },
    {
      id: 'curve-samples',
      title: 'With the samples on it',
      boards: '(not drawn in the design)',
      node: <StandardCurve analysis={analysis} xLabel={labels.x} yLabel={labels.y} samples caption={false} />,
    },
    {
      group: 'Type and cards',
      id: 'labels',
      title: 'Labels and the highlighter',
      boards: 'Plan-Heard · Run-Timer · Gloves-*',
      node: (
        <div className="flex flex-col gap-3 px-1">
          <DotLabel>You said</DotLabel>
          <DotLabel size="md">Heard “C is OK”</DotLabel>
          <p className="m-0 text-[17px] leading-6 font-medium text-ink">
            <b className="font-bold"><Mark>5 standards</Mark></b> <Mark>once</Mark> and <b className="font-bold">12 samples</b> <Mark>in triplicate</Mark>:{' '}
            <b className="font-bold"><Mark>{heardPlan.wells} wells</Mark></b>, still <b className="font-bold">{amountText(heardReagent.make)}</b> of working reagent.
          </p>
        </div>
      ),
    },
    {
      id: 'bench',
      title: 'Gloves-on lines',
      boards: 'Gloves-Load · Gloves-Add · Gloves-Read',
      node: (
        <div className="flex flex-col px-1">
          <p className="m-0 mb-1 text-[15px] leading-5 font-semibold text-text">Tube 10 of 21 · {amountText(perWell)} in each</p>
          <BenchLine>Sample 1</BenchLine>
          <BenchLine size="xl" className="mt-0.5">
            <Mark className="-mx-1.5 rounded-[8px] px-1.5">{plan.tubes[9]!.wells.join(' · ')}</Mark>
          </BenchLine>
          <BenchLine className="mt-4 font-medium">
            <b className="font-[750]">{amountText(reagent.perWell)}</b> into all <b className="font-[750]">{plan.wells}&nbsp;wells</b>
          </BenchLine>
          <BenchLine size="xxl" className="mt-4">{p.analysis?.readout.value} nm</BenchLine>
        </div>
      ),
    },
    {
      id: 'amounts',
      title: `What goes into the vials: ${amountText(series.stock)} BSA, ${amountText(series.diluent)} diluent`,
      boards: 'Standards-2',
      node: (
        <div className="flex flex-col gap-2.5">
          <AmountCard name="Albumin Standard" detail={`Stock · ${concentrationText(bsa.concentration!.value)} ${bsa.concentration!.unit}`} amount={amountText(series.stock)} />
          <AmountCard name="PBS" detail="Diluent · you named it" amount={amountText(series.diluent)} />
        </div>
      ),
    },
  ];

  const one = only ? parts.find(x => x.id === only) : null;
  if (one) {
    return (
      <div className="h-full overflow-y-auto pr-5" style={{ paddingTop: `calc(${top}px + var(--screen-top))`, paddingLeft: left }}>
        <div style={width ? { width: Number(width) } : undefined}>{one.node}</div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto [scrollbar-width:none]">
      <div className="flex flex-col px-5 pt-[calc(56px+var(--screen-top))] pb-24">
        <Link to="/" className="mb-3 self-start text-[15px] leading-5 font-semibold text-blue">← Home</Link>
        <h1 className="m-0 text-[30px] leading-9 font-bold tracking-[-0.02em] text-ink">Lab parts</h1>
        <p className="m-0 mt-1 text-[15px] leading-[22px] text-text">
          From the Pierce BCA protocol: 9 standards and 12 samples in duplicate ({plan.wells} wells), and Plan-Heard’s five standards once with samples ×3 ({heardPlan.wells} wells). Results use the built-in sample data.
        </p>
        {parts.map(part => (
          <section key={part.id} id={part.id} className="flex flex-col">
            {part.group && <h2 className="m-0 mt-10 mb-1 border-t border-line pt-4 text-[22px] leading-7 font-[650] text-ink">{part.group}</h2>}
            <div className="mt-5 mb-3 flex flex-col gap-0.5 px-1">
              <p className="m-0 text-[13px] leading-[18px] font-semibold text-ink">{part.title}</p>
              <p className="m-0 text-[12px] leading-4 text-muted">
                {part.boards} · <code className="text-[11px]">?part={part.id}</code>
              </p>
            </div>
            {part.node}
          </section>
        ))}
      </div>
    </div>
  );
}

type Part = { id: string; title: string; boards: string; node: ReactNode; group?: string };
