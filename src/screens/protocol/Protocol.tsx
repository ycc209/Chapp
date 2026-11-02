import { ReplyText, ReplySources } from '../../components/chapp/ReplyText.tsx';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { useBottomWhileTyping } from '../../app/keyboard.ts';
import { useScreen } from '../../app/screen.ts';
import { A2uiSurface } from '../../components/a2ui/Surface.tsx';
import { benchCut, keepAsIs, keptAsIs, useCutouts } from '../../components/bench/cutout.ts';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '../../components/ui/Dialog.tsx';
import { Confirm } from '../../components/chapp/Confirm.tsx';
import { ChappHeader } from '../../components/chapp/ChappHeader.tsx';
import { SHEET_DURATION, SHEET_EASE } from '../../components/ui/Sheet.tsx';
import { toast } from '../../components/ui/Toaster.tsx';
import { BottomBar } from '../../components/voice/BottomBar.tsx';
import { isPlannable } from '../../../shared/calc.ts';
import type { Protocol } from '../../../shared/protocol.ts';
import { cn } from '../../lib/cn.ts';
import { saveProtocol, useKits, useMine } from '../../state/library.ts';
import { executeAssistantAction } from '../../state/assistantActions.ts';
import { useProtocolPreviews } from '../../state/protocolPreview.ts';
import { useChatLog } from '../../state/conversationLog.ts';
import { useProtocol } from '../../state/protocol.ts';
import { runStarted, useRun } from '../../state/run.ts';
import { noteEvent } from '../../state/runEvents.ts';
import { beginRun } from '../../state/start.ts';
import { useSession } from '../../state/session.ts';
import { ERROR_LINE } from '../home/HomeCenter.tsx';
import { PlusMenu } from '../home/PlusMenu.tsx';
import { Sidebar } from '../home/Sidebar.tsx';
import { TypingBar } from '../home/TypingBar.tsx';
import { converseContext, useConverse } from '../home/useConverse.ts';
import { claimCover } from '../kit/cover.ts';
import { samplePhotos } from '../kit/sample.ts';
import { Answer, Glance, ProgressiveOverview, QuickSections, Sections, type Section } from './Body.tsx';
import { KitAsk } from '../kit/Ask.tsx';
import { ModelTag } from '../kit/ModelTag.tsx';
import { kitProgress } from '../kit/progress.ts';
import { addedTo, forgetAdded, useAdded, useKit } from '../kit/store.ts';
import { bottles, procedureFor, shortName, splitName } from './content.ts';
import { BookmarkIcon, CheckIcon, DocumentIcon, PlayIcon } from './icons.tsx';
import { useFinding, wasShown, type Stage } from './useFinding.ts';
import { useImporting } from './useImporting.ts';

// The bar's wash (Overview.dc.html): the bar and the Plan / Start pills float over the page as it scrolls under.
const BAR_WASH =
  'radial-gradient(56% 64% at 50% 100%, rgba(121, 185, 243, 0.3) 0%, rgba(111, 211, 198, 0.1) 55%, rgba(255, 255, 255, 0) 80%), linear-gradient(rgba(255, 255, 255, 0), rgba(255, 255, 255, 0.86) 38%, rgba(255, 255, 255, 0.94))';
const PILL = 'flex min-h-9 items-center rounded-[18px] text-[15px] leading-5 font-semibold no-underline outline-none focus-visible:ring-2 focus-visible:ring-blue';
const WHITE_PILL = 'bg-white text-ink shadow-[0_1px_2px_rgba(17,17,19,0.06),0_2px_8px_rgba(17,17,19,0.04)]';
// Where Protocol-Kit.dc.html draws the top of "In the kit", and the content's top padding there.
const KIT_TOP = 474;
// The storyboard's first sentence, for reviewing the Overview by address when nothing was said yet.
const STORY_ASK = 'I just got a Pierce BCA protein assay kit. Help me run it.';
// Under what Chapp read of a new manual first, while the rest is read (the status line says "Turning it into steps"):
// its steps as printed are there already, their amounts not yet checked; or it could not list them.

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
  const previewId = params.get('preview');
  return previewId ? <ProtocolPreviewScreen key={previewId} id={previewId} /> : <CurrentProtocolScreen />;
}

function CurrentProtocolScreen() {
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
  // An explicit legacy lookup may open the Overview. Ordinary conversation history
  // must never become a new search merely because the user opened their protocol.
  const [ask] = useState(() =>
    upload ? null : review === 'overview' ? (exchange?.ask ?? STORY_ASK) : review ? null : exchange?.query && !wasShown(exchange) ? exchange.ask : null,
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
  const { protocol, error } = useProtocol(protocolId);

  const all = protocol ? bottles(protocol) : [];
  // Every bottle in the kit's box or bag photographed (the user's own are theirs to show or not); a protocol whose
  // bottles are all the user's, every one.
  const inKit = all.some(c => c.suppliedBy === 'kit') ? all.filter(c => c.suppliedBy === 'kit') : all;
  const allPhotographed = inKit.length > 0 && inKit.every(c => runPhotos[c.id]);
  // Protocol-Kit by address with no photos in the run: drawn samples, labelled as such, never saved.
  const sample = review === 'kit' && protocol !== null && !all.some(c => runPhotos[c.id]);
  const photos = useMemo(
    () => (sample && protocol ? Object.fromEntries(Object.entries(samplePhotos(bottles(protocol)).picks).map(([id, p]) => [id, p.crop])) : runPhotos),
    [sample, protocol, runPhotos],
  );
  const matched = sample || allPhotographed;
  // Bottles photographed before (or on another visit) are made ready for the step pictures as the protocol opens,
  // not when a step first shows them; each is made once and kept (bench/cutout.ts).
  useEffect(() => {
    if (!sample) for (const src of Object.values(runPhotos)) void benchCut(src);
  }, [runPhotos, sample]);
  // A bottle whose cut-out did not come out whole. After a video the kit screen that asks about it is skipped, so Chapp
  // asks here as the kit screen would: a photo of just that bottle, or keep it (asked once; the bench draws it then).
  const cuts = useCutouts(
    useMemo(() => (sample || !protocol ? {} : Object.fromEntries(bottles(protocol).flatMap(c => (runPhotos[c.id] ? [[c.id, runPhotos[c.id]!]] : [])))), [protocol, runPhotos, sample]),
  );
  const [keptHere, setKeptHere] = useState<Record<string, true>>({});
  const poor = all.find(c => cuts[c.id] && !cuts[c.id]!.ok && !keptHere[c.id] && !keptAsIs(runPhotos[c.id]!)) ?? null;
  const poorFrom = useKit(s => {
    const shot = poor ? s.shots.find(sh => sh.id === s.picks[poor.id]?.shot) : undefined;
    return shot?.video ? 'your video' : shot?.sweep ? 'your sweep' : 'your photo';
  });
  const retakePhoto = (id: string, name: string) => {
    useKit.getState().retake(id, `Take a photo of just the ${name}.`);
    navigate('/kit', { state: { camera: true } });
  };
  const keepPhoto = (id: string) => {
    keepAsIs(runPhotos[id]!);
    setKeptHere(k => ({ ...k, [id]: true }));
  };
  // Not doing this protocol after all: × takes back what was just photographed or uploaded for it (its bottles'
  // photos, the cover, a video still being looked at) and leaves it, before the run has begun.
  const added = useAdded();
  const roundShots = useKit(s => (s.sample ? 0 : s.shots.length));
  // What the models are doing with the round's photos behind this page (a video's bottles followed, found and read).
  const kitShots = useKit(s => s.shots);
  const kitSeen = useKit(s => s.seen);
  const kitPicks = useKit(s => s.picks);
  const kitFollowing = useKit(s => s.following);
  // Of which bottles: the kit's, or a new kit's contents as its manual lists them until its protocol is read.
  const kitContents = useKit(s => s.contents);
  const counted = useMemo(
    () => (finding.protocolId || runProtocolId ? inKit.map(c => c.id) : (kitContents ?? []).map(c => c.id)),
    [finding.protocolId, runProtocolId, inKit, kitContents],
  );
  const kitWork = useMemo(
    () => kitProgress({ shots: kitShots, seen: kitSeen, picks: kitPicks, following: kitFollowing, sample }, counted),
    [kitShots, kitSeen, kitPicks, kitFollowing, sample, counted],
  );
  const begun = useRun(s => runStarted(s));
  const closable = !sample && !begun && addedTo(added, protocol?.id, roundShots);
  const [closing, setClosing] = useState(false);
  const close = () => {
    setClosing(false);
    forgetAdded();
    useRun.getState().setProtocol(null);
    navigate('/', { replace: true });
  };
  // Packaging photographed before Chapp had this kit (Home's +, then its manual found) is its cover now (kit/cover.ts).
  useEffect(() => {
    if (protocol && !sample) claimCover(protocol);
  }, [protocol, sample]);

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

  // The kit's photos still being worked on behind the page (a video's bottles found and read): Chapp thinks, and the
  // line under its name says what it is on; once they are done it is pleased for a moment. Its search's own face and
  // line (useFinding) come first.
  const kitBusy = kitWork.busy && !begun;
  const lookingUp = finding.stage < 3 && !finding.notFound;
  const wasBusy = useRef(false);
  useEffect(() => {
    if (lookingUp) return;
    const session = useSession.getState();
    if (kitBusy) {
      wasBusy.current = true;
      if (session.expression === 'neutral') session.setExpression('thinking');
      return;
    }
    if (!wasBusy.current) return;
    wasBusy.current = false;
    if (session.expression !== 'thinking') return;
    session.setExpression('happy');
    const t = window.setTimeout(() => useSession.getState().expression === 'happy' && useSession.getState().setExpression('neutral'), 1600);
    return () => clearTimeout(t);
  }, [kitBusy, lookingUp]);
  useEffect(
    () => () => {
      const s = useSession.getState();
      if (wasBusy.current && s.expression === 'thinking') s.setExpression('neutral');
    },
    [],
  );

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
    // (KIT_TOP is under the full header; the compact one is 80 px shorter, and "In the kit" moves up with it.)
  }, [done, fromKit]);
  const overview = ask !== null || importing !== null;
  // A manual new to Chapp: what it read of it first (the intro), until the protocol it becomes is on screen.
  const intro = !finding.notFound && finding.intro && !(protocol && protocol.id === finding.protocolId && stage >= 1) ? finding.intro : null;
  // Plan is for a run with standards and a plate Chapp can work out; any protocol can be started and followed step by
  // step (a cell protocol, or amounts Chapp cannot convert: run/Follow.tsx).
  const plannable = protocol !== null && isPlannable(protocol, procedureFor(protocol, procedure));
  const answer = turn?.phase === 'reply' || turn?.phase === 'thinking' ? turn.say || '' : turn?.phase === 'error' ? turn.error || ERROR_LINE : '';

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
        <div className="flex min-h-full flex-col px-5 pt-[calc(116px+var(--screen-top))] pb-[calc(124px+var(--screen-bottom))]">
          {overview && <Bubble>{importing?.name ?? ask ?? ''}</Bubble>}
          {/* How Chapp found the manual, until what it read comes in: then the kit, its glance and steps take the screen. */}
          {overview && stage < 3 && !intro && finding.progress.length > 0 && <Progress lines={finding.progress} searching={stage === 0} />}
          {finding.said && stage >= 1 && <SaidCheck said={finding.said.number} found={finding.said.found} className="mb-5" />}
          {finding.notFound && (
            <p aria-label="Chapp's answer" className="mb-6 shrink-0 px-1 text-[17px] leading-6 font-medium text-ink">
              {finding.notFound}
            </p>
          )}
          {finding.notFound && (finding.manual || finding.page) && (
            <a
              href={finding.manual ?? finding.page}
              target="_blank"
              rel="noreferrer"
              className="mb-6 flex min-h-11 shrink-0 items-center gap-2 self-start px-1 text-[15px] leading-5 font-semibold text-blue no-underline"
            >
              <DocumentIcon />
              {finding.manual ? 'Open the manual' : 'Open the product page'}
            </a>
          )}
          {error && !finding.notFound && stage >= 1 && (
            <p role="alert" className="mb-6 shrink-0 px-1 text-[17px] leading-6 font-medium text-ink">
              {error}
            </p>
          )}
          {intro ? <Answer protocol={intro} /> : protocol && !finding.notFound && stage >= 1 && <Answer protocol={protocol} cover={sample ? undefined : protocol.id} />}
          {intro ? <Glance protocol={intro} /> : protocol && !finding.notFound && stage >= 2 && <Glance protocol={protocol} />}
          {/* Where the kit's bottles stand, above the kit itself, until every bottle is matched (then the line below says so). */}
          {kitWork.lines.length > 0 && !begun && !matched && <Progress lines={kitWork.lines} by={kitWork.by} searching={kitWork.busy} label="What Chapp is doing with your kit" className="mt-1" />}
          {intro && <QuickSections intro={intro} open={open} onOpen={openSection} />}
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
          {done && poor && (
            <div className="mt-[22px] flex shrink-0 flex-col gap-3">
              <p aria-label="Chapp's answer" className="px-1 text-[17px] leading-6 font-medium text-ink">
                I couldn’t cut the <b className="font-bold">{splitName(poor.name).name}</b> out of {poorFrom} cleanly: {cuts[poor.id]!.why}. Take a photo of just that
                bottle?
              </p>
              <div className="flex gap-2 px-1">
                <button type="button" onClick={() => retakePhoto(poor.id, splitName(poor.name).name)} className={cn(PILL, 'bg-ink px-4 text-white')}>
                  Take a photo
                </button>
                <button type="button" onClick={() => keepPhoto(poor.id)} className={cn(PILL, WHITE_PILL, 'px-4')}>
                  Keep it
                </button>
              </div>
            </div>
          )}
          {done && protocol && !sample && !begun && !poor && <KitAsk protocol={protocol} />}
          {done && protocol && !sample && <SaveToLibrary protocol={protocol} />}
          {turn && (
            <div className="mt-6 flex shrink-0 flex-col">
              <Bubble>{turn.text}</Bubble>
              {/* Always mounted, so screen readers announce each answer as it arrives. */}
              <div aria-live="polite" aria-label="Chapp's answer" className="px-1 text-[17px] leading-6 font-medium text-ink">
                {answer ? <ReplyText text={answer} /> : <span className="text-muted">{turn.phase === 'thinking' ? turn.progress || '…' : ''}</span>}
              </div>
              {turn.phase === 'reply' && <ReplySources sources={turn.sources} className="px-1" />}
              {turn.phase === 'reply' && turn.a2ui ? <A2uiSurface messages={turn.a2ui} protocol={protocol} live onAnswer={send} ask={turn.text} /> : null}
              {turn.phase === 'reply' && turn.confirm ? <Confirm actions={turn.confirm} onAnswer={send} /> : null}
            </div>
          )}
        </div>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[6] flex flex-col pt-7" style={{ background: BAR_WASH }}>
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
      {/* Anything still being worked on (the manual searched for or read, the kit's photos): a light running under the header. */}
      {(lookingUp || intro !== null || kitBusy) && <WorkingBar />}
      <ChappHeader
        compact
        onMenu={() => setSidebar(true)}
        // While a manual is being searched for, no kit's name: the one on screen is only the fallback until it is found.
        // While the kit's photos are worked on, what Chapp is on.
        subtitle={kitBusy ? kitWork.lines.at(-1) : protocol && !finding.notFound && (!query || stage >= 1) ? shortName(protocol) : undefined}
        actions={
          (done || closable) && (
            <>
              {done && (
                // Next: plan the run (when Chapp can work out its amounts) or start it.
                <nav aria-label="Next" className="contents">
                  {plannable && (
                    <Link to="/plan" className={cn(PILL, WHITE_PILL, 'px-3.5')}>
                      Plan
                    </Link>
                  )}
                  <button type="button" onClick={() => navigate(protocol ? beginRun(protocol) : '/run/1')} className={cn(PILL, 'gap-1.5 bg-ink pr-3.5 pl-3 text-white')}>
                    <PlayIcon />
                    Start
                  </button>
                </nav>
              )}
              {closable && (
                <button
                  type="button"
                  aria-label="Close and delete what you just added"
                  onClick={() => setClosing(true)}
                  className="flex size-9 shrink-0 items-center justify-center rounded-full bg-sunken text-ink outline-none focus-visible:ring-2 focus-visible:ring-blue"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                    <path d="M6 6l12 12M18 6 6 18" />
                  </svg>
                </button>
              )}
            </>
          )
        }
      />
      {/* ×: the one question before what was just added goes. */}
      <Dialog open={closing} onOpenChange={setClosing}>
        <DialogContent
          footer={
            <div className="flex gap-2">
              <DialogClose asChild>
                <button type="button" className="min-h-11 grow rounded-full bg-sunken text-[15px] leading-5 font-[650] text-ink outline-none active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-blue">
                  Keep it
                </button>
              </DialogClose>
              <button
                type="button"
                onClick={close}
                className="min-h-11 grow rounded-full bg-[#e5484d] text-[15px] leading-5 font-[650] text-white outline-none active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-blue focus-visible:ring-offset-2"
              >
                Delete
              </button>
            </div>
          }
        >
          <DialogTitle>Delete what you just added?</DialogTitle>
          <DialogDescription>
            This deletes what you just photographed or uploaded: the bottles’ photos and the kit’s cover from them, and a video still being looked at. The
            protocol stays in your library; there is no undo.
          </DialogDescription>
        </DialogContent>
      </Dialog>
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

/** A conversation's confirmed document is a preview until the user explicitly chooses Plan or Start. */
function ProtocolPreviewScreen({ id }: { id: string }) {
  const navigate = useNavigate();
  // Opened from Library, back is Library; from the conversation, the conversation.
  const fromLibrary = (useLocation().state as { from?: string } | null)?.from === '/library';
  const preview = useProtocolPreviews(s => s.previews[id]);
  const exchange = useChatLog(s => s.exchanges.find(e => e.protocolPreviewId === id));
  const { protocol, error } = useProtocol(preview?.state === 'ready' ? preview.protocolId ?? null : null);
  const [open, setOpen] = useState<Section | ''>('');
  const [typing, setTyping] = useState(false);
  const [plus, setPlus] = useState(false);
  const [adopting, setAdopting] = useState(false);
  const adoptingRef = useRef(false);
  const plusRef = useRef<HTMLButtonElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  useBottomWhileTyping(scroller, typing, useScreen().keyboard);
  const { turn, send } = useConverse('protocol-preview', {
    protocol: () => null,
    context: () => converseContext('protocol-preview', null, { ...(preview?.protocolId ? { previewProtocolId: preview.protocolId } : {}), pending: `Viewing manual preview ${id}. Not adopted. ${preview?.state ?? 'unavailable'}.`.slice(0, 200) }),
    executePage: () => ({ ok: false, message: 'This is a manual preview. Open the current experiment to change its setup.' }),
  });
  const ready = preview?.state === 'ready' && protocol !== null;
  const failed = preview?.state === 'error' || Boolean(error);
  const status = failed ? 'Reading stopped' : ready ? shortName(protocol) : preview?.progress?.at(-1) || 'Reading the manual';
  const adopt = async (plan: boolean) => {
    if (!ready || !protocol || adoptingRef.current) return;
    adoptingRef.current = true; setAdopting(true);
    try {
      const receipt = await executeAssistantAction({ type: 'openProtocol', protocolId: protocol.id }, {
        callId: `preview:${id}:${Date.now()}`, navigate, protocol: null,
        context: converseContext('protocol', null), loadProtocol: async () => protocol,
      });
      if (!receipt.ok) { toast(receipt.message); return; }
      noteEvent(`Opened ${shortName(protocol)}${plan ? ' to plan it' : ''}`);
      navigate(plan ? '/plan' : beginRun(protocol));
    } catch (failure) {
      toast(failure instanceof Error ? failure.message : 'The protocol could not be opened.');
    } finally { adoptingRef.current = false; setAdopting(false); }
  };
  const answer = turn?.phase === 'error' ? turn.error : turn?.say;
  return (
    <div className="relative h-full overflow-hidden bg-bg">
      <div ref={scroller} className="h-full overflow-y-auto overscroll-contain [scrollbar-width:none]">
        <div className="flex min-h-full flex-col px-5 pt-[calc(116px+var(--screen-top))] pb-[calc(124px+var(--screen-bottom))]">
          {exchange?.ask && <Bubble>{exchange.ask}</Bubble>}
          {!preview ? <p role="alert" className="mb-6 px-1 text-[17px] leading-6 text-ink">This preview is no longer available. Return to the conversation to open the manual again.</p> : <>
            {preview.progress?.length ? <Progress lines={preview.progress} searching={!ready && !failed} label="Reading the manual" /> : null}
            {failed && <p role="alert" className="mb-5 px-1 text-[15px] leading-[22px] text-text">{preview.error || error || 'Reading the manual stopped.'} {preview.intro ? 'The overview already read is kept below.' : ''}</p>}
            {ready ? <>
              <Answer protocol={protocol} />
              <Glance protocol={protocol} />
              <Sections protocol={protocol} procedure={protocol.defaults.procedure} photos={{}} open={open} onOpen={setOpen} preview />
              <SaveToLibrary protocol={protocol} />
            </> : <ProgressiveOverview preview={failed ? { ...preview, state: 'error' } : preview} open={open} onOpen={setOpen} />}
            {preview.source && <ReplySources sources={[preview.source]} className="px-1" />}
          </>}
          <Link to={fromLibrary ? '/library' : '/chat'} className={cn(PILL, WHITE_PILL, 'mt-5 self-start px-3.5')}>{fromLibrary ? 'Back to the library' : 'Back to conversation'}</Link>
          {turn && <div className="mt-6 flex flex-col">
            <Bubble>{turn.text}</Bubble>
            <div aria-live="polite" aria-label="Chapp's answer" className="px-1 text-[17px] leading-6 text-ink">{answer ? <ReplyText text={answer} /> : <span className="text-muted">{turn.phase === 'thinking' ? turn.progress || '…' : ERROR_LINE}</span>}</div>
            {turn.phase === 'reply' && <ReplySources sources={turn.sources} className="px-1" />}
            {turn.phase === 'reply' && turn.confirm && <Confirm actions={turn.confirm} onAnswer={send} />}
          </div>}
        </div>
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[6] flex flex-col pt-7" style={{ background: BAR_WASH }}>
        <div className="pointer-events-auto px-5 pt-2 pb-[var(--screen-bottom)]">
          {typing ? <TypingBar plusOpen={plus} plusRef={plusRef} onPlus={() => setPlus(value => !value)} onSend={send} onClose={() => { setTyping(false); setPlus(false); }} /> : <BottomBar wash={false} onPlus={() => setPlus(value => !value)} onKeyboard={() => setTyping(true)} onUtterance={send} />}
        </div>
      </div>
      <PlusMenu open={plus} onClose={() => setPlus(false)} coverPlus={!typing} plusRef={plusRef} />
      <ChappHeader compact back={fromLibrary ? { to: '/library', label: 'Back to the library' } : { to: '/chat', label: 'Back to conversation' }} subtitle={preview ? status : 'Preview unavailable'} actions={ready && <nav aria-label="Next" className="contents">
        {isPlannable(protocol, procedureFor(protocol, protocol.defaults.procedure)) && <button disabled={adopting} type="button" className={cn(PILL, WHITE_PILL, 'px-3.5 disabled:opacity-50')} onClick={() => void adopt(true)}>Plan</button>}
        <button disabled={adopting} type="button" className={cn(PILL, 'gap-1.5 bg-ink pr-3.5 pl-3 text-white disabled:opacity-50')} onClick={() => void adopt(false)}><PlayIcon />Start</button>
      </nav>} />
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
/** A light running under the compact header while something on the page is still being worked on. */
export function WorkingBar() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-x-5 top-[calc(106px+var(--screen-top))] z-[6] h-[3px] overflow-hidden rounded-full bg-blue/10">
      <span className="chapp-anim block h-full w-2/5 rounded-full bg-[linear-gradient(90deg,transparent,var(--color-blue),transparent)]" style={{ animation: 'chapp-progress 1.5s ease-in-out infinite' }} />
    </div>
  );
}

/** `by`: which model did each line ("SAM 3.1", "Muse Spark"), line for line, as a tag after it. */
export function Progress({ lines, by, searching = false, label = 'How Chapp found the manual', className }: { lines: string[]; by?: string[]; searching?: boolean; label?: string; className?: string }) {
  return (
    <ul aria-label={label} aria-live="polite" className={cn('mb-5 flex shrink-0 flex-col gap-1.5 px-1 animate-in fade-in duration-300', className)}>
      {lines.map((line, i) => (
        <li key={i} className={cn('grid gap-2 text-[13px] leading-[18px] font-medium text-text animate-in fade-in duration-300', by ? 'grid-cols-[16px_minmax(0,1fr)_auto]' : 'grid-cols-[16px_minmax(0,1fr)]')}>
          {/* While Chapp searches, the line it is on is still under way: a spinner until the next one ticks it off. */}
          {searching && i === lines.length - 1 ? (
            <span aria-label="Under way" className="chapp-anim mt-px size-4 animate-spin rounded-full border-2 border-blue/20 border-t-blue" />
          ) : (
            <span className="mt-px flex size-4 items-center justify-center rounded-full bg-blue text-white">
              <CheckIcon size={10} width={3.4} />
            </span>
          )}
          <span>{line}</span>
          {by && (by[i] ? <ModelTag>{by[i]}</ModelTag> : <span />)}
        </li>
      ))}
    </ul>
  );
}
