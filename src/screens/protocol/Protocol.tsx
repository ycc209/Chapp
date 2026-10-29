import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { useBottomWhileTyping } from '../../app/keyboard.ts';
import { useScreen } from '../../app/screen.ts';
import { A2uiSurface } from '../../components/a2ui/Surface.tsx';
import { Confirm } from '../../components/chapp/Confirm.tsx';
import { ChappHeader } from '../../components/chapp/ChappHeader.tsx';
import { SHEET_DURATION, SHEET_EASE } from '../../components/ui/Sheet.tsx';
import { toast } from '../../components/ui/Toaster.tsx';
import { BottomBar } from '../../components/voice/BottomBar.tsx';
import { isPlannable } from '../../../shared/calc.ts';
import type { Protocol } from '../../../shared/protocol.ts';
import { cn } from '../../lib/cn.ts';
import { saveProtocol, useKits, useMine } from '../../state/library.ts';
import { useProtocol } from '../../state/protocol.ts';
import { runStarted, useRun } from '../../state/run.ts';
import { useSession } from '../../state/session.ts';
import { ERROR_LINE } from '../home/HomeCenter.tsx';
import { PlusMenu } from '../home/PlusMenu.tsx';
import { Sidebar } from '../home/Sidebar.tsx';
import { TypingBar } from '../home/TypingBar.tsx';
import { useConverse } from '../home/useConverse.ts';
import { samplePhotos } from '../kit/sample.ts';
import { Answer, Glance, QuickSections, Sections, type Section } from './Body.tsx';
import { bottles, procedureFor, shortName, startPath } from './content.ts';
import { BookmarkIcon, CheckIcon, DocumentIcon, PlayIcon } from './icons.tsx';
import { useFinding, wasShown, type Stage } from './useFinding.ts';
import { useImporting } from './useImporting.ts';

// The bar's wash (Overview.dc.html): the bar and the Plan / Start pills float over the page as it scrolls under.
const BAR_WASH =
  'radial-gradient(56% 64% at 50% 100%, rgba(121, 185, 243, 0.3) 0%, rgba(111, 211, 198, 0.1) 55%, rgba(255, 255, 255, 0) 80%), linear-gradient(rgba(255, 255, 255, 0), rgba(255, 255, 255, 0.86) 38%, rgba(255, 255, 255, 0.94))';
const PILL = 'flex min-h-10 items-center rounded-[20px] text-[15px] leading-5 font-semibold no-underline outline-none focus-visible:ring-2 focus-visible:ring-blue';
const WHITE_PILL = 'bg-white text-ink shadow-[0_1px_2px_rgba(17,17,19,0.06),0_2px_8px_rgba(17,17,19,0.04)]';
// Where Protocol-Kit.dc.html draws the top of "In the kit", and the content's top padding there.
const KIT_TOP = 474;
// The storyboard's first sentence, for reviewing the Overview by address when nothing was said yet.
const STORY_ASK = 'I just got a Pierce BCA protein assay kit. Help me run it.';
// Under what Chapp read of a new manual first, while the rest is read (the status line says "Turning it into steps"):
// its steps as printed are there already, their amounts not yet checked; or it could not list them.
const STILL_CHECKING = 'Still checking the amounts';
const STILL_READING = 'Still reading the steps';

type Review = 'overview' | 'protocol' | 'kit' | 'full';

/**
 * The protocol (Overview, Protocol, Protocol-Kit, Protocol-Full): what the kit is, at a glance, then In the kit,
 * Steps, Principle and Precautions, all drawn from the protocol document. The first time, after the user asked on
 * Home, it opens with what they said and Chapp finding the manual (Overview). Back from the camera, the kit shows
 * the user's photos (Protocol-Kit).
 *
 * For design review a state opens from the address: ?state=overview (&stage=0–3 holds a stage), protocol, kit
 * (with drawn sample photos if the run has none) or full (every section open).
 */
export function ProtocolScreen() {
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [review] = useState(() => params.get('state') as Review | null);
  const hold = useMemo(() => {
    const s = Number(params.get('stage'));
    return params.has('stage') && s >= 0 && s <= 3 ? (Math.floor(s) as Stage) : null;
  }, []);
  const fromKit = review === 'kit' || (location.state as { from?: string } | null)?.from === 'kit';
  // A manual picked from the + menu (Home-Plus.dc.html's Upload): the Overview follows Chapp reading it.
  const upload = (location.state as { upload?: string } | null)?.upload ?? null;
  const importing = useImporting(upload);

  const exchange = useSession(s => s.exchange);
  const voice = useSession(s => s.voice);
  // The Overview, once per thing said on Home; opened again later it is the protocol on its own.
  const [ask] = useState(() =>
    upload ? null : review === 'overview' ? (exchange?.ask ?? STORY_ASK) : review ? null : exchange && !wasShown(exchange) ? exchange.ask : null,
  );
  const [askedIn] = useState(() => (ask && exchange?.ask === ask ? exchange : null));
  // What to search for: the kit Chapp named (a findProtocol action), or else what the user said.
  const [query] = useState(() => (ask && askedIn?.query) || ask);
  const searching = useFinding(query, hold, askedIn);
  const finding = importing ?? searching;

  // The manual Chapp just found, when it is a protocol on this machine; otherwise the run's own.
  const runProtocolId = useRun(s => s.protocolId);
  const protocolId = finding.protocolId ?? runProtocolId ?? 'pierce-bca';
  const procedure = useRun(s => s.procedure);
  const runPhotos = useRun(s => s.photos);
  const started = useRun(runStarted);
  const { protocol, error } = useProtocol(protocolId);

  const all = protocol ? bottles(protocol) : [];
  const allPhotographed = all.length > 0 && all.every(c => runPhotos[c.id]);
  // Protocol-Kit by address with no photos in the run: drawn samples, labelled as such, never saved.
  const sample = review === 'kit' && protocol !== null && !all.some(c => runPhotos[c.id]);
  const photos = useMemo(
    () => (sample && protocol ? Object.fromEntries(Object.entries(samplePhotos(bottles(protocol)).picks).map(([id, p]) => [id, p.crop])) : runPhotos),
    [sample, protocol, runPhotos],
  );
  const matched = sample || allPhotographed;

  const [open, setOpen] = useState<Section | ''>(fromKit ? 'kit' : '');
  const [sidebar, setSidebar] = useState(false);
  const [plus, setPlus] = useState(false);
  const [typing, setTyping] = useState(false);
  const plusRef = useRef<HTMLButtonElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  // A section opens or closes in place (0.2 s). Once a closing one is gone, bring the scroll back inside the shorter page.
  const openSection = (section: Section | '') => {
    setOpen(section);
    window.setTimeout(() => {
      const el = scroller.current;
      if (!el) return;
      const max = Math.max(0, el.scrollHeight - el.clientHeight);
      if (el.scrollTop > max) el.scrollTop = max;
    }, 260);
  };
  const { turn, send, newConversation } = useConverse('protocol');

  // A found manual for another kit becomes the run's protocol, so Plan and Start run what the Overview shows.
  useEffect(() => {
    if (finding.protocolId && finding.protocolId !== useRun.getState().protocolId) useRun.getState().setProtocol(finding.protocolId);
  }, [finding.protocolId]);

  // Another kit's protocol has its own procedures: the run starts from its default one.
  useEffect(() => {
    if (protocol && protocol.id === useRun.getState().protocolId && !protocol.procedures.some(p => p.id === useRun.getState().procedure)) {
      useRun.getState().setPlan({ procedure: protocol.defaults.procedure });
    }
  }, [protocol]);

  // Back from the camera with every bottle matched: Chapp is pleased (Protocol-Kit.dc.html's happy face).
  useEffect(() => {
    if (!fromKit || !matched) return;
    const session = useSession.getState();
    session.setExpression('happy');
    return () => {
      if (useSession.getState().expression === 'happy') useSession.getState().setExpression('neutral');
    };
  }, [fromKit, matched]);

  // A new question or answer at the bottom of the conversation: bring it into view.
  useEffect(() => {
    if (!turn) return;
    const el = scroller.current;
    el?.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [turn?.id, turn?.phase]);

  const stage = finding.stage;
  const done = stage === 3 && protocol !== null && !finding.notFound;

  // Back from the camera, "In the kit" sits where Protocol-Kit.dc.html has it (474 px down), its photos in view.
  const { scale, keyboard } = useScreen();
  useBottomWhileTyping(scroller, typing, keyboard);
  useEffect(() => {
    const el = scroller.current;
    const kit = el?.querySelector('[data-kit]');
    if (!done || !fromKit || !el || !kit) return;
    const offset = (kit.getBoundingClientRect().top - el.getBoundingClientRect().top) / scale + el.scrollTop;
    el.scrollTop = Math.max(0, offset - (KIT_TOP - 196 + parseFloat(getComputedStyle(el.firstElementChild ?? el).paddingTop)));
  }, [done, fromKit]);
  const overview = ask !== null || importing !== null;
  // A manual new to Chapp: what it read of it first (the intro), until the protocol it becomes is on screen.
  const intro = !finding.notFound && finding.intro && !(protocol && protocol.id === finding.protocolId && stage >= 1) ? finding.intro : null;
  // Plan is for a run with standards and a plate Chapp can work out; any protocol can be started and followed step by
  // step (a cell protocol, or amounts Chapp cannot convert: run/Follow.tsx).
  const plannable = protocol !== null && isPlannable(protocol, procedureFor(protocol, procedure));
  const answer = turn?.phase === 'reply' ? turn.say : turn?.phase === 'error' ? ERROR_LINE : '';

  return (
    <div
      className={cn(
        'relative h-full overflow-hidden bg-bg transition-[translate,border-radius]',
        SHEET_DURATION,
        SHEET_EASE,
        sidebar && 'translate-x-[318px] rounded-[44px]',
      )}
    >
      {/* The scroller only scrolls; the column inside it lays the page out. A flex column that also scrolled could get
          stuck on iPhone Safari (it measured the page as fitting and would not scroll). */}
      <div ref={scroller} className="h-full overflow-y-auto overscroll-contain [scrollbar-width:none] [-webkit-overflow-scrolling:touch]">
        <div className="flex min-h-full flex-col px-5 pt-[calc(196px+var(--screen-top))] pb-[calc(168px+var(--screen-bottom))]">
          {overview && <Bubble>{importing?.name ?? ask ?? ''}</Bubble>}
          {/* How Chapp found the manual, until what it read comes in: then the kit, its glance and steps take the screen. */}
          {overview && stage < 3 && !intro && finding.progress.length > 0 && <Progress lines={finding.progress} searching={stage === 0} />}
          {finding.said && stage >= 1 && <SaidCheck said={finding.said.number} found={finding.said.found} className="mb-5" />}
          {finding.notFound && (
            <p aria-label="Chapp's answer" className="mb-6 shrink-0 px-1 text-[17px] leading-6 font-medium text-ink">
              {finding.notFound}
            </p>
          )}
          {finding.notFound && finding.manual && (
            <a
              href={finding.manual}
              target="_blank"
              rel="noreferrer"
              className="mb-6 flex min-h-11 shrink-0 items-center gap-2 self-start px-1 text-[15px] leading-5 font-semibold text-blue no-underline"
            >
              <DocumentIcon />
              Open the manual
            </a>
          )}
          {error && !finding.notFound && stage >= 1 && (
            <p role="alert" className="mb-6 shrink-0 px-1 text-[17px] leading-6 font-medium text-ink">
              {error}
            </p>
          )}
          {intro ? <Answer protocol={intro} /> : protocol && !finding.notFound && stage >= 1 && <Answer protocol={protocol} />}
          {intro ? <Glance protocol={intro} /> : protocol && !finding.notFound && stage >= 2 && <Glance protocol={protocol} />}
          {intro && intro.procedure.steps.length > 0 && <QuickSections intro={intro} open={open} onOpen={openSection} />}
          {intro && (
            <Progress lines={[intro.procedure.steps.length ? STILL_CHECKING : STILL_READING]} searching label="What Chapp is reading now" className="mt-4" />
          )}
          {done && (
            <Sections
              protocol={protocol}
              procedure={procedure}
              photos={photos}
              open={review === 'full' ? 'all' : open}
              onOpen={openSection}
              sample={sample}
            />
          )}
          {done && fromKit && matched && (
            <p aria-label="Chapp's answer" className="mt-[22px] shrink-0 px-1 text-[17px] leading-6 font-medium text-ink">
              All <b className="font-bold">{all.length} bottles</b> are matched. Plan the run, or start now.
            </p>
          )}
          {done && protocol && !sample && <SaveToLibrary protocol={protocol} />}
          {turn && (
            <div className="mt-6 flex shrink-0 flex-col">
              <Bubble>{turn.text}</Bubble>
              {/* Always mounted, so screen readers announce each answer as it arrives. */}
              <p aria-live="polite" aria-label="Chapp's answer" className="px-1 text-[17px] leading-6 font-medium text-ink">
                {turn.phase === 'thinking' ? <span className="text-muted">…</span> : answer}
              </p>
              {turn.phase === 'reply' && turn.a2ui ? <A2uiSurface messages={turn.a2ui} protocol={protocol} live onAnswer={send} ask={turn.text} /> : null}
              {turn.phase === 'reply' && turn.confirm ? <Confirm actions={turn.confirm} /> : null}
            </div>
          )}
        </div>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[6] flex flex-col pt-7" style={{ background: BAR_WASH }}>
        {done && voice !== 'talking' && (
          <div aria-label="Next" className="pointer-events-none relative flex shrink-0 justify-center gap-2 px-5 pt-2 [&>*]:pointer-events-auto">
            {plannable && (
              <Link to="/plan" className={cn(PILL, WHITE_PILL, 'px-[18px]')}>
                Plan
              </Link>
            )}
            <Link to={protocol ? startPath(protocol, procedure, started) : '/run/1'} className={cn(PILL, 'gap-[7px] bg-ink pr-[18px] pl-[15px] text-white')}>
              <PlayIcon />
              Start
            </Link>
          </div>
        )}
        <div className="pointer-events-auto px-5 pt-2 pb-[var(--screen-bottom)]">
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
            <BottomBar wash={false} onPlus={() => setPlus(o => !o)} onKeyboard={() => setTyping(true)} onUtterance={send} />
          )}
        </div>
      </div>

      {done && plannable && (
        // The handle on the right edge: start or plan the run (Run-Choose).
        <Link
          to="/plan?state=choose"
          aria-label="Start or plan"
          className="absolute top-[calc(404px+var(--screen-top))] right-0 z-[6] flex h-24 w-6 items-center justify-end pr-1"
        >
          <span aria-hidden="true" className="h-14 w-[5px] rounded-[3px] bg-[#c9c9c4]" />
        </Link>
      )}

      <PlusMenu open={plus} onClose={() => setPlus(false)} coverPlus={!typing} plusRef={plusRef} />
      <ChappHeader onMenu={() => setSidebar(true)} subtitle={protocol && !finding.notFound ? shortName(protocol) : undefined} />
      <Sidebar
        open={sidebar}
        onOpenChange={setSidebar}
        onNewConversation={() => {
          newConversation();
          navigate('/');
        }}
      />
    </div>
  );
}

/**
 * Save to library: puts the protocol in Library's Saved. The user's kit photos are kept with it either way
 * (state/library.ts); the toast says how many there are. Once saved, it says so and opens Library.
 */
function SaveToLibrary({ protocol }: { protocol: Protocol }) {
  const navigate = useNavigate();
  const saved = useMine(s => (s.protocols[protocol.id]?.savedAt ?? null) !== null);
  const photos = useKits(s => Object.keys(s.kits[protocol.id] ?? {}).length);
  const save = () => {
    if (!saveProtocol(protocol.id, { title: protocol.title })) return toast('This phone has no room left to save it.');
    toast(photos ? `Saved, with your ${photos} kit ${photos === 1 ? 'photo' : 'photos'}` : 'Saved to your library', { action: { label: 'Open library', onClick: () => navigate('/library') } });
  };
  return (
    <div className="mt-[18px] flex shrink-0 gap-2 px-1">
      {saved ? (
        <Link to="/library" className={cn(PILL, WHITE_PILL, 'gap-1.5 px-3.5')}>
          <CheckIcon size={14} width={3} />
          In your library
        </Link>
      ) : (
        <button type="button" onClick={save} className={cn(PILL, WHITE_PILL, 'gap-1.5 px-3.5')}>
          <BookmarkIcon />
          Save to library
        </button>
      )}
    </div>
  );
}

/** What the user said, on the right in light blue (Overview.dc.html); the conversation (/chat) uses it too. */
/**
 * The catalog number the user said is not the kit found ("EEA 302" said, EEA032 found): a misheard or mistyped number
 * finds a neighbour in the vendor's range, so the user checks the box before following this manual.
 */
export function SaidCheck({ said, found, className }: { said: string; found: string; className?: string }) {
  return (
    <p role="note" className={cn('m-0 flex shrink-0 flex-col gap-0.5 self-start rounded-[16px] bg-caution-bg px-3.5 py-2.5 text-[14px] leading-[19px] text-[#8a4d00]', className)}>
      <b className="font-semibold">You said {said}. This manual is for {found}.</b>
      <span>Check the number on your box before you follow it.</span>
    </p>
  );
}

export function Bubble({ children }: { children: string }) {
  return (
    <div className="mb-5 flex shrink-0 justify-end">
      <p className="max-w-[calc(82%+32px)] rounded-[22px] bg-[#d6e8fc] px-4 py-2.5 text-[17px] leading-[22px] font-medium text-ink [overflow-wrap:anywhere]">{children}</p>
    </div>
  );
}

/** What Chapp did to find the manual, ticked off as it went (FoundProtocol.progress). */
export function Progress({ lines, searching = false, label = 'How Chapp found the manual', className }: { lines: string[]; searching?: boolean; label?: string; className?: string }) {
  return (
    <ul aria-label={label} aria-live="polite" className={cn('mb-5 flex shrink-0 flex-col gap-1.5 px-1 animate-in fade-in duration-300', className)}>
      {lines.map((line, i) => (
        <li key={i} className="grid grid-cols-[16px_minmax(0,1fr)] gap-2 text-[13px] leading-[18px] font-medium text-text animate-in fade-in duration-300">
          {/* While Chapp searches, the line it is on is still under way: a ring until the next one ticks it off. */}
          {searching && i === lines.length - 1 ? (
            <span className="mt-px size-4 animate-pulse rounded-full border-2 border-blue" />
          ) : (
            <span className="mt-px flex size-4 items-center justify-center rounded-full bg-blue text-white">
              <CheckIcon size={10} width={3.4} />
            </span>
          )}
          {line}
        </li>
      ))}
    </ul>
  );
}
