import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { A2uiSurface } from '../../components/a2ui/Surface.tsx';
import { ChappHeader } from '../../components/chapp/ChappHeader.tsx';
import { Confirm } from '../../components/chapp/Confirm.tsx';
import { BottomBar } from '../../components/voice/BottomBar.tsx';
import { cn } from '../../lib/cn.ts';
import { useRun } from '../../state/run.ts';
import { useSession } from '../../state/session.ts';
import { endConversation, startListening } from '../../voice/controller.ts';
import { ERROR_LINE } from '../home/HomeCenter.tsx';
import { PlusMenu } from '../home/PlusMenu.tsx';
import { TypingBar } from '../home/TypingBar.tsx';
import { PILL, WHITE_PILL } from '../plan/Shell.tsx';
import { Bubble, Progress, SaidCheck } from '../protocol/Protocol.tsx';
import { otherCatalog } from '../../../shared/catalog.ts';
import { CheckIcon } from '../protocol/icons.tsx';
import { type Exchange, useChat, useChatLog } from './useChat.ts';

// The bar's wash (Overview.dc.html): the conversation scrolls under the bar.
const BAR_WASH =
  'radial-gradient(56% 64% at 50% 100%, rgba(121, 185, 243, 0.3) 0%, rgba(111, 211, 198, 0.1) 55%, rgba(255, 255, 255, 0) 80%), linear-gradient(rgba(255, 255, 255, 0), rgba(255, 255, 255, 0.86) 38%, rgba(255, 255, 255, 0.94))';
const SAY = 'm-0 px-1 text-[17px] leading-6 font-medium text-ink';
const CARD = 'flex flex-col gap-2 rounded-[20px] bg-card p-4 shadow-[0_0_0_1px_rgba(17,17,19,0.05),0_4px_16px_rgba(17,17,19,0.06)] animate-in fade-in duration-300';

/**
 * Talking with Chapp (tap Chapp on any screen): the whole screen is the conversation. Chapp listens from the moment it
 * opens and keeps listening, so whatever is said is answered without pressing anything; the bar pauses it (and, paused,
 * a tap listens again, a hold says one thing), the keyboard types. Each exchange is the user's bubble, Chapp's answer,
 * what it changed, the card it drew (A2UI, src/components/a2ui/), a button for a screen it points to, and a kit's
 * manual looked up in place. Silent: nothing is read aloud. × closes it, back where it was opened.
 */
export function ChatScreen() {
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/';
  const { send, protocol } = useChat();
  const exchanges = useChatLog(s => s.exchanges);
  const voice = useSession(s => s.voice);
  const heard = useSession(s => s.heard);
  const interim = useSession(s => s.interim);
  const [typing, setTyping] = useState(false);
  const [plus, setPlus] = useState(false);
  const plusRef = useRef<HTMLButtonElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  // Paused by the user: opening again (or the bar) does not start listening by itself.
  const paused = useRef(false);

  // Listening from the start (the tap on Chapp already opened the microphone; opened by address, it opens here), and
  // closed again when the conversation is.
  useEffect(() => {
    if (useSession.getState().voice === 'idle' && !paused.current) startListening('talk');
    return () => {
      if (useSession.getState().voice !== 'idle') endConversation();
    };
  }, []);

  // Each new exchange, answer or line of a search comes into view at the bottom.
  const last = exchanges.at(-1);
  useEffect(() => {
    const el = scroller.current;
    el?.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [exchanges.length, last?.phase, last?.find?.progress.length, last?.find?.state, Boolean(heard || interim)]);

  const listen = (on: boolean) => {
    paused.current = !on;
    if (on) startListening('talk');
    else endConversation();
  };
  const talking = voice === 'talking';
  const open = (to: string) => {
    // The conversation already looked the kit up: the protocol opens as it is, without searching again.
    useSession.getState().setExchange(null);
    navigate(to);
  };

  return (
    <div className="relative h-full overflow-hidden bg-bg">
      <div
        ref={scroller}
        className="flex h-full flex-col overflow-y-auto px-5 pt-[calc(196px+var(--screen-top))] pb-[calc(150px+var(--screen-bottom))] [scrollbar-width:none]"
      >
        {exchanges.length === 0 && (
          <div className="flex flex-col gap-2 px-1 pt-6 animate-in fade-in duration-300">
            <p className="m-0 text-[15px] leading-5 font-semibold text-text">{talking ? 'I’m listening' : 'Tap to listen, or type'}</p>
            <h1 className="m-0 text-[30px] leading-[38px] font-bold tracking-[-0.02em] text-ink">Ask me anything about your run.</h1>
          </div>
        )}
        {exchanges.map(e => (
          <ExchangeView key={e.id} e={e} protocolReady={protocol} onGo={open} live={e.id === last?.id} onAnswer={send} />
        ))}
        {/* The words of the turn being said, as they are recognized (the browser's recognizer; the server's has none). */}
        {talking && (heard || interim) && (
          <div className="mt-6 flex shrink-0 justify-end">
            <p className="max-w-[calc(82%+32px)] rounded-[22px] bg-[#d6e8fc] px-4 py-2.5 text-[17px] leading-[22px] font-medium text-ink [overflow-wrap:anywhere]">
              {heard}
              {interim && <span className="text-muted">{heard && !heard.endsWith(' ') ? ' ' : ''}{interim}</span>}
            </p>
          </div>
        )}
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
            <BottomBar
              wash={false}
              tapTalks
              onPlus={() => setPlus(o => !o)}
              onKeyboard={() => {
                listen(false);
                setTyping(true);
              }}
              onUtterance={send}
            />
          )}
        </div>
      </div>
      <PlusMenu open={plus} onClose={() => setPlus(false)} coverPlus={!typing} plusRef={plusRef} />

      <ChappHeader
        back={{ to: from, label: 'Close the conversation', close: true }}
        subtitle={talking ? undefined : 'Paused'}
        onAvatar={() => listen(!talking)}
        avatarLabel={talking ? 'Pause listening' : 'Listen'}
      />
    </div>
  );
}

/** One exchange: the user's bubble, then Chapp's answer and everything that came with it. */
function ExchangeView({ e, protocolReady: protocol, onGo, live, onAnswer }: { e: Exchange; protocolReady: ReturnType<typeof useChat>['protocol']; onGo: (to: string) => void; live: boolean; onAnswer: (text: string) => void }) {
  const answer = e.phase === 'reply' ? e.say : e.phase === 'error' ? ERROR_LINE : '';
  return (
    <section aria-label="Exchange" className="mt-6 flex shrink-0 flex-col first:mt-0">
      <Bubble>{e.ask}</Bubble>
      <p aria-live="polite" aria-label="Chapp's answer" className={SAY}>
        {e.phase === 'thinking' ? <span className="text-muted">…</span> : answer}
      </p>
      {e.done.length > 0 && (
        <ul aria-label="What Chapp changed" className="mt-3 flex flex-col gap-1.5 px-1">
          {e.done.map((line, i) => (
            <li key={i} className="grid grid-cols-[16px_minmax(0,1fr)] gap-2 text-[13px] leading-[18px] font-medium text-text animate-in fade-in duration-300">
              <span className="mt-px flex size-4 items-center justify-center rounded-full bg-blue text-white">
                <CheckIcon size={10} width={3.4} />
              </span>
              {line}
            </li>
          ))}
        </ul>
      )}
      {e.phase === 'reply' && e.a2ui && <A2uiSurface messages={e.a2ui} protocol={protocol} live={live} onAnswer={onAnswer} ask={e.ask} />}
      {e.phase === 'reply' && e.confirm && <Confirm actions={e.confirm} />}
      {e.find && <Found find={e.find} ask={e.ask} onGo={onGo} />}
      {e.go.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2 px-1">
          {e.go.map(g => (
            <button key={g.to} type="button" onClick={() => onGo(g.to)} className={cn(PILL, WHITE_PILL, 'gap-1.5 pr-3.5 pl-[18px]')}>
              {g.label}
              <Arrow />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

/** A kit's manual looked up from the conversation: its progress as it comes, then the kit with a button to open it. */
function Found({ find, ask, onGo }: { find: NonNullable<Exchange['find']>; ask: string; onGo: (to: string) => void }) {
  const found = find.found;
  const said = find.state === 'found' ? otherCatalog(`${ask} ${find.query}`, found?.kit?.catalog) : null;
  return (
    <div className="mt-4 flex flex-col">
      {find.progress.length > 0 && <Progress lines={find.progress} searching={find.state === 'searching'} className="mb-0" />}
      {find.state === 'searching' && find.progress.length === 0 && (
        <p className="m-0 px-1 text-[13px] leading-[18px] font-medium text-muted">Searching the web…</p>
      )}
      {said && found?.kit && <SaidCheck said={said} found={found.kit.catalog} className="mt-4" />}
      {find.state === 'found' && found && (
        <Card label="Found the manual">
          <span className="text-[17px] leading-[22px] font-semibold text-ink">{found.kit?.name ?? found.document?.title ?? 'The kit’s manual'}</span>
          {found.document && (
            <span className="text-[14px] leading-[19px] text-text">
              {found.document.title}
              {found.document.version ? ` · ${found.document.version}` : ''}
            </span>
          )}
          {found.protocolId ? (
            <button
              type="button"
              onClick={() => {
                if (found.protocolId !== useRun.getState().protocolId) useRun.getState().setProtocol(found.protocolId!);
                onGo('/protocol');
              }}
              className={cn(PILL, 'mt-1 gap-1.5 self-start bg-ink pr-3.5 pl-[18px] text-white')}
            >
              Open
              <Arrow />
            </button>
          ) : (
            found.document && (
              <a href={found.document.url} target="_blank" rel="noreferrer" className={cn(PILL, WHITE_PILL, 'mt-1 self-start px-[18px]')}>
                Open the PDF
              </a>
            )
          )}
        </Card>
      )}
      {find.state === 'notFound' && <p className={cn(SAY, 'mt-1')}>{found?.answer || 'I couldn’t find that kit’s manual.'}</p>}
      {find.state === 'failed' && <p className={cn(SAY, 'mt-1')}>I couldn’t search the web just now. Try again in a moment?</p>}
    </div>
  );
}

function Card({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className={cn(CARD, 'mt-4')}>
      <h3 className="m-0 text-[13px] leading-[18px] font-semibold text-text">{label}</h3>
      {children}
    </section>
  );
}

const Arrow = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);
