import * as AccordionPrimitive from '@radix-ui/react-accordion';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { ProtocolIntro } from '../../../shared/ai.ts';
import type { Protocol } from '../../../shared/protocol.ts';
import { cn } from '../../lib/cn.ts';
import { answer, bottles, bottleDetail, kitContents, precautions, principle, sourceLine, splitName, stepLines, type Preview } from './content.ts';
import { BulbIcon, CameraIcon, CheckBadge, DocumentIcon, NudgeIcon, PlusIcon, StepsIcon, WarningIcon } from './icons.tsx';

export type Section = 'kit' | 'steps' | 'principle' | 'precautions';
export const SECTIONS: Section[] = ['kit', 'steps', 'principle', 'precautions'];

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

/** "At a glance": the source's own four-step summary, numbered on yellow. */
export function Glance({ protocol }: { protocol: Preview }) {
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
    </section>
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
 * In the kit, Steps, Principle, Precautions: rows that open in place, a + turning into × (Overview.dc.html). The
 * black tab on "In the kit" goes to the camera; once the bottles are photographed the row shows them.
 */
export function Sections({ protocol, procedure, photos, open, onOpen, sample }: SectionsProps) {
  const kit = kitContents(protocol, procedure);
  const steps = stepLines(protocol, procedure);
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

      <AccordionPrimitive.Item value="steps">
        <AccordionPrimitive.Header className="flex flex-col">
          <Trigger icon={<StepsIcon />} title="Steps" aside={<Aside>{steps.length}</Aside>} />
        </AccordionPrimitive.Header>
        <Content>
          <div className="flex flex-col gap-3 pr-1 pb-[18px] pl-9">
            <ol className="flex flex-col gap-2">
              {steps.map((s, i) => (
                <li key={s.id} className="grid grid-cols-[14px_minmax(0,1fr)] items-baseline gap-2.5 text-[16px] leading-[22px] text-ink">
                  <span className="text-[14px] font-bold text-text tabular-nums">{i + 1}</span>
                  <span>{s.text}</span>
                </li>
              ))}
            </ol>
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
            <ol className="flex flex-col gap-2">
              {steps.map((s, i) => (
                <li key={i} className="grid grid-cols-[14px_minmax(0,1fr)] items-baseline gap-2.5 text-[16px] leading-[22px] text-ink">
                  <span className="text-[14px] font-bold text-text tabular-nums">{i + 1}</span>
                  <span>{s.text}</span>
                </li>
              ))}
            </ol>
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
