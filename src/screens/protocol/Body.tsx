import * as AccordionPrimitive from '@radix-ui/react-accordion';
import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { ProtocolIntro } from '../../../shared/ai.ts';
import type { Protocol } from '../../../shared/protocol.ts';
import { cn } from '../../lib/cn.ts';
import { useKits } from '../../state/library.ts';
import { answer, bottles, bottleDetail, kitContents, precautions, prepLines, principle, sourceLine, splitName, stepLines, type Preview } from './content.ts';
import { BulbIcon, CameraIcon, CheckBadge, DocumentIcon, EyeIcon, FlaskIcon, NudgeIcon, PlusIcon, StageIcon, StepsIcon, WarningIcon } from './icons.tsx';
import { BenchSheet } from './BenchSheet.tsx';
import { scenesFor, StepPicture } from './StepPicture.tsx';

export type Section = 'kit' | 'prep' | 'steps' | 'principle' | 'precautions';
export const SECTIONS: Section[] = ['kit', 'prep', 'steps', 'principle', 'precautions'];

/** Chapp's answer about the kit (Overview.dc.html, Protocol.dc.html): what it is and what happens in the well. */
export function Answer({ protocol }: { protocol: Pick<Protocol, 'title' | 'summary'> }) {
  const { lead, text } = answer(protocol);
  return (
    <p aria-label="Chapp's answer" className="mb-6 shrink-0 px-1 text-[17px] leading-6 font-medium text-ink animate-in fade-in duration-300">
      <b className="font-bold">{lead}</b>
      {text}
    </p>
  );
}

/** Where a line comes from: the vendor's document, opened on its own site at the page. */
export function SourceLink({ protocol, page, className }: { protocol: Pick<Preview, 'source'>; page?: number; className?: string }) {
  const s = protocol.source;
  return (
    <a
      // An upload still being read has no copy to open yet.
      href={!s.url ? undefined : page ? `${s.url}#page=${page}` : s.url}
      target="_blank"
      rel="noreferrer"
      aria-label={`Source: ${s.title}, ${s.publisher}, ${s.docId} revision ${s.revision}${page ? `, page ${page}` : ''}`}
      className={cn('flex items-center gap-1 text-[13px] leading-[18px] font-medium text-text no-underline', className)}
    >
      <DocumentIcon size={13} />
      {sourceLine(protocol, page)}
    </a>
  );
}

/**
 * "At a glance": the source's own four-step summary, numbered on yellow; what it says the user will see comes after,
 * apart from the steps.
 */
export function Glance({ protocol }: { protocol: Preview }) {
  const expected = protocol.overview.expected ?? [];
  return (
    <section aria-label="At a glance" className="mb-7 flex shrink-0 flex-col gap-2.5 px-1 animate-in fade-in duration-300">
      {/* The summary is the source's own (its Fig. 1): the heading says whose, and opens that page. */}
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[13px] leading-[18px] font-semibold text-text">At a glance</h2>
        <SourceLink protocol={protocol} page={protocol.overview.cite.page} />
      </div>
      <ol className="flex flex-col gap-2.5">
        {protocol.overview.steps.map((line, i) => (
          <li key={i} className="grid grid-cols-[22px_minmax(0,1fr)] items-center gap-3 text-[17px] leading-6 font-medium text-ink">
            <span className="size-[22px] rounded-full bg-mark text-center text-[12px] leading-[22px] font-bold text-ink">{i + 1}</span>
            <span>{line}</span>
          </li>
        ))}
      </ol>
      {expected.length > 0 && <Expected lines={expected} className="mt-1" />}
    </section>
  );
}

/** What the user should see when it works: a result to look for, set apart from the steps. */
export function Expected({ lines, className }: { lines: string[]; className?: string }) {
  return (
    <div role="note" aria-label="What you should see" className={cn('flex flex-col gap-1 rounded-[14px] bg-sunken px-3 py-2.5', className)}>
      <span className="flex items-center gap-1.5 text-[13px] leading-[18px] font-semibold text-text">
        <EyeIcon size={14} />
        What you should see
      </span>
      {lines.map((line, i) => (
        <p key={i} className="m-0 text-[16px] leading-[22px] font-medium text-ink">
          {line}
        </p>
      ))}
    </div>
  );
}

type SectionsProps = {
  protocol: Protocol;
  procedure: string | null;
  /** The user's photo of each bottle, by component id. */
  photos: Record<string, string>;
  /** One section open at a time (Protocol), or every one open (Protocol-Full). */
  open: Section | '' | 'all';
  onOpen: (open: Section | '') => void;
  /** Says the bottle photos are drawn samples (review by address), not the user's. */
  sample?: boolean;
};

/**
 * In the kit, Reagent prep (when the manual has some), Steps, Principle, Precautions: rows that open in place, a +
 * turning into × (Overview.dc.html). The black tab on "In the kit" goes to the camera; once the bottles are
 * photographed the row shows them. Steps are the experiment itself; getting the reagents ready comes before it.
 */
export function Sections({ protocol, procedure, photos, open, onOpen, sample }: SectionsProps) {
  const kit = kitContents(protocol, procedure);
  const steps = stepLines(protocol, procedure);
  const prep = prepLines(protocol, procedure);
  const why = principle(protocol);
  const care = precautions(protocol);
  const all = bottles(protocol);
  const photographed = all.some(c => photos[c.id]);
  const pdfPage = steps[0]?.page ?? 1;

  const items = (
    <>
      <AccordionPrimitive.Item value="kit">
        <AccordionPrimitive.Header data-kit="" className="relative flex flex-col">
          <Link
            to="/kit"
            aria-label="Photograph your kit"
            className="absolute top-2 -left-5 z-[1] flex h-10 w-11 items-center justify-end gap-px rounded-r-[20px] bg-ink pr-[5px] text-white shadow-[4px_0_14px_rgba(17,17,19,0.18)] outline-none focus-visible:ring-2 focus-visible:ring-blue"
          >
            <CameraIcon />
            <NudgeIcon />
          </Link>
          <Trigger
            className="pl-9"
            title="In the kit"
            aside={
              photographed ? (
                <span aria-hidden="true" className="flex pl-1.5">
                  {all.map(c => (
                    <Thumb key={c.id} src={photos[c.id]} className="-ml-1.5 size-6 rounded-[7px] shadow-[0_0_0_2px_#ffffff]" />
                  ))}
                </span>
              ) : (
                <Aside>{kit.items.length} items</Aside>
              )
            }
          />
        </AccordionPrimitive.Header>
        <Content>
          {photographed ? (
            <div className="flex flex-col gap-3 pt-0.5 pr-1 pb-[18px] pl-9">
              <ul className="flex flex-col gap-2.5">
                {all.map(c => (
                  <li key={c.id} className="grid grid-cols-[48px_minmax(0,1fr)] items-center gap-3">
                    <span aria-hidden="true" className="relative size-12">
                      <Thumb src={photos[c.id]} className="size-12 rounded-[12px]" />
                      {photos[c.id] && <CheckBadge stroke={3.2} />}
                    </span>
                    <span className="flex min-w-0 flex-col gap-px">
                      <span className="text-[16px] leading-[21px] font-semibold text-ink">{splitName(c.name).name}</span>
                      <span className="text-[13px] leading-[18px] text-text">{photos[c.id] ? bottleDetail(c) : `${bottleDetail(c)} · no photo yet`}</span>
                    </span>
                  </li>
                ))}
              </ul>
              {sample && <SampleBadge>Sample photos, drawn for review</SampleBadge>}
              <p className="text-[15px] leading-[22px] text-text">{kit.need(true)}</p>
            </div>
          ) : (
            <div className="flex flex-col gap-3 pr-1 pb-[18px] pl-9">
              <ul className="flex flex-col gap-2 text-[16px] leading-[22px] font-semibold text-ink">
                {kit.items.map(item => (
                  <li key={item.id} className="flex justify-between gap-3">
                    {item.name}
                    {item.detail && <span className="font-medium text-text">{item.detail}</span>}
                  </li>
                ))}
              </ul>
              <p className="text-[15px] leading-[22px] text-text">{[kit.store, kit.need(false)].filter(Boolean).join(' ')}</p>
            </div>
          )}
        </Content>
      </AccordionPrimitive.Item>

      {prep.length > 0 && (
        <AccordionPrimitive.Item value="prep">
          <AccordionPrimitive.Header className="flex flex-col">
            <Trigger icon={<FlaskIcon />} title="Reagent prep" aside={<Aside>{prep.length}</Aside>} />
          </AccordionPrimitive.Header>
          <Content>
            <div className="flex flex-col gap-3 pr-1 pb-[18px] pl-9">
              <p className="m-0 text-[15px] leading-[22px] text-text">Before the experiment. Some of it keeps, so you may have done it already.</p>
              <ol aria-label="Reagent prep" className="m-0 flex list-none flex-col gap-3 p-0">
                {prep.map(item => (
                  <li key={item.id} className="flex flex-col gap-0.5">
                    <span className="text-[16px] leading-[21px] font-semibold text-ink">{item.title}</span>
                    <span className="text-[14px] leading-[20px] text-text">{keepUnits(item.text)}</span>
                  </li>
                ))}
              </ol>
            </div>
          </Content>
        </AccordionPrimitive.Item>
      )}

      <AccordionPrimitive.Item value="steps">
        <AccordionPrimitive.Header className="flex flex-col">
          <Trigger icon={<StepsIcon />} title="Steps" aside={<Aside>{steps.length}</Aside>} />
        </AccordionPrimitive.Header>
        <Content>
          <div className="flex flex-col gap-3 pr-1 pb-[18px] pl-9">
            <StepCards steps={steps} protocol={protocol} procedureId={procedure} />
            {/* Fix-Steps (comparing each step with its page) is not built; until then the PDF opens at the steps. */}
            <a
              href={`${protocol.source.url}#page=${pdfPage}`}
              target="_blank"
              rel="noreferrer"
              className="flex min-h-11 items-center gap-2 self-start text-[15px] leading-5 font-semibold text-blue no-underline"
            >
              <DocumentIcon />
              Steps look wrong? Show me in the PDF
            </a>
          </div>
        </Content>
      </AccordionPrimitive.Item>

      <AccordionPrimitive.Item value="principle">
        <AccordionPrimitive.Header className="flex flex-col">
          <Trigger icon={<BulbIcon />} title="Principle" aside={<Aside>{why.aside}</Aside>} />
        </AccordionPrimitive.Header>
        <Content>
          <div className="flex flex-col gap-2.5 pr-1 pb-[18px] pl-9">
            {why.paragraphs.map((text, i) => (
              <p key={i} className="text-[15px] leading-[22px] text-text">
                {text}
              </p>
            ))}
          </div>
        </Content>
      </AccordionPrimitive.Item>

      <AccordionPrimitive.Item value="precautions">
        <AccordionPrimitive.Header className="flex flex-col">
          <Trigger icon={<WarningIcon />} title="Precautions" aside={<Aside>{care.length}</Aside>} />
        </AccordionPrimitive.Header>
        <Content>
          <div className="pr-1 pb-[18px] pl-9">
            <ul className="flex list-disc flex-col gap-2 pl-[18px] text-[15px] leading-[22px] text-text">
              {care.map((note, i) => (
                <li key={i}>{note.text}</li>
              ))}
            </ul>
          </div>
        </Content>
      </AccordionPrimitive.Item>
    </>
  );

  const root = 'flex shrink-0 flex-col border-b border-line animate-in fade-in duration-300';
  return open === 'all' ? (
    <AccordionPrimitive.Root type="multiple" value={SECTIONS} onValueChange={() => {}} className={root}>
      {items}
    </AccordionPrimitive.Root>
  ) : (
    <AccordionPrimitive.Root type="single" collapsible value={open} onValueChange={v => onOpen(v as Section | '')} className={root}>
      {items}
    </AccordionPrimitive.Root>
  );
}

type QuickSectionsProps = {
  intro: Pick<ProtocolIntro, 'procedure' | 'contents' | 'source'>;
  open: Section | '' | 'all';
  onOpen: (open: Section | '') => void;
};

/**
 * In the kit and Steps from what Chapp read of a new manual first (ProtocolIntro): the bottles and the main procedure's
 * steps as the manual words them, in the same rows as Sections. The checked protocol replaces them when it is read;
 * until then there is no camera tab (matching bottles needs it), and Principle and Precautions wait.
 */
export function QuickSections({ intro, open, onOpen }: QuickSectionsProps) {
  const { steps, others } = intro.procedure;
  const pdfPage = steps[0]?.page ?? 1;
  const value = open === 'kit' || open === 'steps' ? open : '';
  return (
    <AccordionPrimitive.Root
      type="single"
      collapsible
      value={value}
      onValueChange={v => onOpen(v as Section | '')}
      className="flex shrink-0 flex-col border-b border-line animate-in fade-in duration-300"
    >
      {intro.contents.length > 0 && (
        <AccordionPrimitive.Item value="kit">
          <AccordionPrimitive.Header className="flex flex-col">
            <Trigger className="pl-9" title="In the kit" aside={<Aside>{intro.contents.length} items</Aside>} />
          </AccordionPrimitive.Header>
          <Content>
            <ul className="flex flex-col gap-2 pr-1 pb-[18px] pl-9 text-[16px] leading-[22px] font-semibold text-ink">
              {intro.contents.map((item, i) => (
                <li key={i} className="flex justify-between gap-3">
                  {item.name}
                  {item.amount && <span className="font-medium text-text">{item.amount}</span>}
                </li>
              ))}
            </ul>
          </Content>
        </AccordionPrimitive.Item>
      )}
      <AccordionPrimitive.Item value="steps">
        <AccordionPrimitive.Header className="flex flex-col">
          <Trigger icon={<StepsIcon />} title="Steps" aside={<Aside>{steps.length}</Aside>} />
        </AccordionPrimitive.Header>
        <Content>
          <div className="flex flex-col gap-3 pr-1 pb-[18px] pl-9">
            <StepCards steps={steps} />
            {others.length > 0 && <p className="text-[15px] leading-[22px] text-text">Also in the manual: {others.join(', ')}.</p>}
            {intro.source.url && (
              <a
                href={`${intro.source.url}#page=${pdfPage}`}
                target="_blank"
                rel="noreferrer"
                className="flex min-h-11 items-center gap-2 self-start text-[15px] leading-5 font-semibold text-blue no-underline"
              >
                <DocumentIcon />
                Steps look wrong? Show me in the PDF
              </a>
            )}
          </div>
        </Content>
      </AccordionPrimitive.Item>
    </AccordionPrimitive.Root>
  );
}

type CardStep = { id?: string; title?: string; text: string; stage?: string; facts?: string[]; original?: string; expected?: string[] };

// Steps done with the hands (making, mixing, loading, washing) get a picture; waiting, reading and working out the
// result are said in a line. A step without a stage (the quick read's) is judged by its words.
const HANDS_ON = new Set(['standards', 'prepare', 'mix', 'load', 'treat', 'wash']);
const needsPicture = (s: CardStep) =>
  s.stage ? HANDS_ON.has(s.stage) : !/\b(?:incubat|wait|cool|equilibrat|read|measur|subtract|plot|calculat|analy[sz])/i.test(s.text);

type Card = { picture: boolean; steps: { step: CardStep; n: number }[] };

/** One card per step that needs a picture; steps that don't, two to a card. */
function cardsOf(steps: CardStep[]) {
  const cards: Card[] = [];
  steps.forEach((step, i) => {
    const last = cards[cards.length - 1];
    if (needsPicture(step)) cards.push({ picture: true, steps: [{ step, n: i + 1 }] });
    else if (last && !last.picture && last.steps.length < 2) last.steps.push({ step, n: i + 1 });
    else cards.push({ picture: false, steps: [{ step, n: i + 1 }] });
  });
  return cards;
}

const CARD =
  'flex flex-col overflow-hidden rounded-[20px] bg-card shadow-[0_0_0_1px_rgba(17,17,19,0.05),0_6px_24px_rgba(17,17,19,0.07)] [-webkit-backface-visibility:hidden] [backface-visibility:hidden]';

/**
 * The steps as cards side by side, swiped through, under a row of the steps that follows them: "Step 1" … with a picture
 * of each kind of step on a line, the card's steps in ink and the others grey; tapping one brings its card. A step done
 * with the hands has its own card with its picture (StepPicture, drawn from the protocol; empty while only the quick
 * read is there); short steps share a card, one above the
 * other. Each card says the step, its numbers in a line ("37 °C · 30 min · Covered") and what to do in Chapp's words; a
 * tap turns the card in view to the manual's own words. Cards beside it are faded. All cards are as tall as the tallest.
 */
function StepCards({ steps, protocol, procedureId }: { steps: CardStep[]; protocol?: Protocol; procedureId?: string | null }) {
  const cards = cardsOf(steps);
  // The user's own photos of this kit's bottles (never the drawn samples): they stand on the bench in the pictures.
  const photos = useKits(s => (protocol ? s.kits[protocol.id] : undefined));
  const [at, setAt] = useState(0);
  // Every step with a bench scene, in order, for the enlarged picture (BenchSheet) to step through.
  const enlarged = useMemo(() => {
    const scenes = protocol ? scenesFor(protocol, procedureId) : new Map();
    return steps.flatMap((s, i) => (s.id && scenes.get(s.id)?.items.length ? [{ n: i + 1, id: s.id, scene: scenes.get(s.id)! }] : []));
  }, [steps, protocol, procedureId]);
  const [open, setOpen] = useState<number | null>(null);
  const row = useRef<HTMLOListElement>(null);
  const progress = useRef<HTMLOListElement>(null);

  // The card in view is the one whose start is nearest the row's start (where cards snap).
  const onScroll = () => {
    const el = row.current;
    if (!el) return;
    const items = [...el.children] as HTMLElement[];
    const base = items[0]?.offsetLeft ?? 0;
    let best = 0;
    items.forEach((item, i) => {
      if (Math.abs(item.offsetLeft - base - el.scrollLeft) < Math.abs((items[best]!.offsetLeft - base) - el.scrollLeft)) best = i;
    });
    setAt(best);
  };
  // Bring card i to where the first one sits, its outline clear of the row's edge (the padding the cards snap to).
  const show = (i: number) => {
    const el = row.current;
    const item = el?.children[i] as HTMLElement | undefined;
    if (!el || !item) return;
    const pad = parseFloat(getComputedStyle(el).paddingLeft);
    el.scrollTo({ left: item.getBoundingClientRect().left - el.getBoundingClientRect().left + el.scrollLeft - pad, behavior: 'smooth' });
  };
  // Keep the card's steps in view in the progress row.
  const current = new Set(cards[at]?.steps.map(s => s.n));
  useEffect(() => {
    const first = progress.current?.querySelector('[data-current]');
    first?.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }, [at]);

  return (
    <div className="-mr-1 -ml-9 flex flex-col gap-5">
      <ol ref={progress} aria-label="Step by step" className="flex overflow-x-auto pt-1 [scrollbar-width:none]">
        {steps.map((s, i) => {
          const on = current.has(i + 1);
          const card = cards.findIndex(c => c.steps.some(x => x.n === i + 1));
          return (
            <li key={i} className="flex shrink-0 flex-col gap-2" data-current={on && !current.has(i) ? '' : undefined}>
              <button
                type="button"
                onClick={() => show(card)}
                aria-current={on ? 'step' : undefined}
                className={cn('flex flex-col gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-blue', on ? 'text-ink' : 'text-faint')}
              >
                <span className="text-[15px] leading-5 font-semibold tabular-nums">Step {i + 1}</span>
                <span className="flex items-center">
                  <StageIcon stage={s.stage} />
                  {i < steps.length - 1 && <span aria-hidden="true" className="mx-2 h-0.5 w-12 rounded-full bg-line" />}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      {/* A little room above and to the left, so the cards' outline and shadow are not cut off by the scrolling row. */}
      <ol
        ref={row}
        onScroll={onScroll}
        aria-label="Steps"
        className="flex snap-x snap-mandatory gap-3 overflow-x-auto overscroll-x-contain px-1.5 pt-2 pb-3 [scrollbar-width:none]"
      >
        {cards.map((card, i) => (
          <li
            key={card.steps[0]!.n}
            className="flex w-[72%] shrink-0 scroll-ml-1.5 snap-start [perspective:1200px]"
          >
            <StepCard
              card={card}
              total={steps.length}
              inView={i === at}
              onBring={() => show(i)}
              onEnlarge={enlarged.some(e => e.id === card.steps[0]!.step.id) ? () => setOpen(enlarged.findIndex(e => e.id === card.steps[0]!.step.id)) : undefined}
              protocol={protocol}
              procedureId={procedureId}
              photos={photos}
            />
          </li>
        ))}
      </ol>
      <BenchSheet scenes={enlarged} at={open} onAt={setOpen} onClose={() => setOpen(null)} photos={photos} />
    </div>
  );
}

function StepCard({ card, total, inView, onBring, onEnlarge, protocol, procedureId, photos }: { card: Card; total: number; inView: boolean; onBring: () => void; onEnlarge?: () => void; protocol?: Protocol; procedureId?: string | null; photos?: Record<string, string> }) {
  const [turned, setTurned] = useState(false);
  useEffect(() => {
    if (!inView) setTurned(false);
  }, [inView]);
  const front = (
    <div className={cn(CARD, 'grow gap-3 p-4')} aria-hidden={turned}>
      {card.picture && (
        <div aria-hidden="true" data-picture className="relative flex aspect-square w-[44%] items-center justify-center overflow-hidden rounded-[14px] bg-sunken text-faint">
          {protocol && card.steps[0]!.step.id ? <StepPicture protocol={protocol} procedureId={procedureId} stepId={card.steps[0]!.step.id} photos={photos} /> : <PictureIcon />}
          {onEnlarge && (
            <span className="absolute right-1.5 bottom-1.5 flex size-6 items-center justify-center rounded-full bg-card/90 text-ink shadow-[0_1px_3px_rgba(17,17,19,0.15)]">
              <EnlargeIcon />
            </span>
          )}
        </div>
      )}
      {card.steps.map(({ step, n }, i) => (
        <div key={n} className={cn('flex flex-col gap-1', i > 0 && 'border-t border-line pt-3')}>
          {(card.steps.length > 1 || !card.picture) && (
            <span className="text-[13px] leading-[18px] font-semibold text-text tabular-nums">
              Step {n} of {total}
            </span>
          )}
          {step.title && <span className="text-[17px] leading-[22px] font-semibold text-ink">{step.title}</span>}
          {step.facts && step.facts.length > 0 && <span className="text-[14px] leading-[19px] text-ink">{keepUnits(step.facts.join(' · '))}</span>}
          {/* A card without a picture is the short version: its title and numbers say the step ("Incubate", "37 °C ·
              30 min · Covered"); the line in Chapp's words shows only when there are no numbers. */}
          {(card.picture || !step.facts?.length) && <span className="text-[14px] leading-[20px] text-text">{keepUnits(step.text)}</span>}
          {/* What to look for after the step: not part of what to do. */}
          {step.expected?.map((line, j) => (
            <span key={j} aria-label={`What you should see: ${line}`} className="flex items-start gap-1.5 text-[14px] leading-[20px] text-text">
              <span className="mt-[3px] shrink-0">
                <EyeIcon size={14} />
              </span>
              {keepUnits(line)}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
  // A card beside the one in view comes into view when tapped; the one in view turns to the manual's words. Steps with
  // nothing more to show (the quick read's are already the manual's words) don't turn.
  const turns = card.steps.some(({ step }) => step.original);
  return (
    <button
      type="button"
      aria-pressed={turns && inView ? turned : undefined}
      aria-label={!inView ? `Show step ${card.steps[0]!.n}` : turns ? (turned ? 'Show Chapp\'s words' : 'Show the manual\'s words') : undefined}
      onClick={(e: MouseEvent) => {
        if (!inView) return onBring();
        // The picture opens enlarged; the rest of the card turns.
        if (onEnlarge && (e.target as Element).closest('[data-picture]')) return onEnlarge();
        if (turns) setTurned(t => !t);
      }}
      className={cn(
        'grid h-full w-full text-left outline-none [transform-style:preserve-3d] transition-[transform,scale,opacity] duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] focus-visible:ring-2 focus-visible:ring-blue',
        // Cards beside the one in view are faded and a little smaller. On the card, not its slot: the slot's size is
        // what the row snaps to, and a shrunken slot left the card's edge under the row's edge once it grew back.
        !inView && 'scale-[0.96] opacity-45',
      )}
      style={{ transform: turned ? 'rotateY(180deg)' : 'none' }}
    >
      <div className="flex [grid-area:1/1]">{front}</div>
      {turns && (
        <div className={cn(CARD, 'gap-3 p-4 [grid-area:1/1] [transform:rotateY(180deg)]')} aria-hidden={!turned}>
          {card.steps.map(({ step, n }, i) => (
            <div key={n} className={cn('flex flex-col gap-1', i > 0 && 'border-t border-line pt-3')}>
              <span className="flex items-center gap-1.5 text-[13px] leading-[18px] font-semibold text-text">
                <DocumentIcon size={13} />
                Step {n} · the manual
              </span>
              <span className="text-[14px] leading-[21px] text-ink">{step.original ?? step.text}</span>
            </div>
          ))}
        </div>
      )}
    </button>
  );
}

/** A number and its unit stay on one line ("2 mg/mL", "37 °C", "30 min"): the space between them doesn't break. */
const keepUnits = (text: string) =>
  text.replace(/(\d) (?=(?:[pnµum]?(?:L|g|M)\b|[pnµum]?g\/m?L|°C|nm|min|h\b|s\b|%|parts?\b|wells?\b|tubes?\b))/g, '$1\u00a0');

const EnlargeIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
  </svg>
);

/** Where a step's picture will go. */
function PictureIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="m21 16-5-5-9 9" />
    </svg>
  );
}

function Trigger({ icon, title, aside, className }: { icon?: ReactNode; title: string; aside: ReactNode; className?: string }) {
  return (
    <AccordionPrimitive.Trigger
      className={cn(
        'group flex min-h-14 items-center gap-3 border-t border-line px-1 text-left text-ink outline-none focus-visible:bg-sunken',
        className,
      )}
    >
      {icon}
      <span className="grow text-[17px] leading-[22px] font-semibold">{title}</span>
      {aside}
      <PlusIcon className="shrink-0 transition-transform duration-200 group-data-[state=open]:rotate-45" />
    </AccordionPrimitive.Trigger>
  );
}

function Aside({ children }: { children: ReactNode }) {
  return <span className="text-[15px] leading-5 text-text">{children}</span>;
}

function Content({ children }: { children: ReactNode }) {
  return (
    <AccordionPrimitive.Content className="overflow-hidden data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down">
      {children}
    </AccordionPrimitive.Content>
  );
}

/** A bottle's photo, or the dark square the design shows before there is one. */
function Thumb({ src, className }: { src?: string; className?: string }) {
  return src ? (
    <img src={src} alt="" draggable={false} className={cn('block bg-[#1b1b1d] object-cover', className)} />
  ) : (
    <span className={cn('block bg-[#1b1b1d]', className)} />
  );
}

/** The orange "Sample data" pill (Style.dc.html), for anything on screen that is not the user's own. */
export function SampleBadge({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'self-start rounded-full bg-caution-bg px-2.5 py-1 text-[12px] leading-4 font-bold tracking-[0.02em] text-[#8a4d00] shadow-[inset_0_0_0_1px_rgba(161,92,0,0.25)]',
        className,
      )}
    >
      {children}
    </span>
  );
}
