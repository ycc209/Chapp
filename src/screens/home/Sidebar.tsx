import { useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { Sheet, SheetClose, SheetContent, SheetTitle } from '../../components/ui/Sheet.tsx';
import { toast } from '../../components/ui/Toaster.tsx';
import { cn } from '../../lib/cn.ts';
import { useChatLog } from '../../state/conversationLog.ts';
import { useProtocolList } from '../../state/protocol.ts';
import { runStarted, useRun } from '../../state/run.ts';
import { openThread, useThreads } from '../../state/threads.ts';
import { runningTimers } from '../../state/alarms.ts';
import { countdownText, useNow } from '../../components/lab/index.ts';
import { KitCover } from '../kit/KitCover.tsx';
import { shortName } from '../protocol/content.ts';
import { GLASS_BUTTON, GLASS_FIELD } from './bar.ts';
import { GlobeIcon, HomeIcon, LibraryIcon, PencilIcon, PeopleIcon, SearchIcon, SettingsIcon } from './icons.tsx';

type SidebarProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The pencil: a fresh conversation on the home screen. */
  onNewConversation: () => void;
};

/**
 * Library and history (Sidebar.dc.html): the pages, then this phone's conversations, one per experiment, then
 * settings, search and a new conversation. The page itself slides right and stays visible as the thing to tap to close (Home moves it; this
 * draws its shadow and catches the tap).
 */
export function Sidebar({ open, onOpenChange, onNewConversation }: SidebarProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="left"
        veil={false}
        // Focus the panel itself, not its first button, so nothing looks picked before the user does anything;
        // Tab then walks the pages from the top.
        onOpenAutoFocus={e => {
          e.preventDefault();
          (e.currentTarget as HTMLElement | null)?.focus({ preventScroll: true });
        }}
        className="w-[318px] px-3.5 pt-[calc(56px+var(--screen-top))] pb-[var(--screen-bottom)]"
      >
        <SheetTitle className="sr-only">Library and history</SheetTitle>
        <Nav onNewConversation={onNewConversation} close={() => onOpenChange(false)} />
        {/* The page pushed aside: its shadow falls on the sidebar, and a tap on it closes. */}
        <SheetClose
          aria-label="Close the sidebar"
          className="absolute top-0 left-full h-full w-[440px] rounded-[44px] shadow-[-10px_0_34px_rgba(17,17,19,0.10),0_0_0_1px_rgba(17,17,19,0.04)] outline-none focus-visible:ring-2 focus-visible:ring-blue focus-visible:ring-inset"
        />
      </SheetContent>
    </Sheet>
  );
}

/**
 * The page the sidebar was opened over, as the link that leads there: Chapp on the home screen, Library or the Shared
 * library on theirs, From the web on the protocol; none on the other screens.
 */
export function currentPage(pathname: string, search: string): string | null {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/') return '/';
  if (path === '/library') return new URLSearchParams(search).get('view') === 'shared' ? '/library?view=shared' : '/library';
  if (path === '/protocol') return '/protocol';
  return null;
}

function Nav({ close, onNewConversation }: { close: () => void; onNewConversation: () => void }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const { pathname, search } = useLocation();
  const current = currentPage(pathname, search);

  return (
    <nav aria-label="Chapp" className="flex grow flex-col">
      <p className="mx-3 mt-1 mb-2 text-[13px] leading-[18px] font-semibold text-text">Pages</p>
      <div className="flex flex-col gap-0.5">
        <Page to="/" icon={<HomeIcon />} current={current === '/'} onPick={close}>
          Chapp
        </Page>
        <Page to="/library" icon={<LibraryIcon />} current={current === '/library'} onPick={close}>
          Library
        </Page>
        <Page to="/protocol" icon={<GlobeIcon />} current={current === '/protocol'} onPick={close}>
          From the web
        </Page>
        <Page to="/library?view=shared" icon={<PeopleIcon />} current={current === '/library?view=shared'} onPick={close}>
          Shared library
          <span className="-ml-1 rounded-[9px] bg-sample-bg px-2 py-0.5 text-[11px] leading-[14px] font-bold text-sample-ink">
            Soon
          </span>
        </Page>
      </div>
      <hr className="mx-3 mt-5 h-px border-0 bg-line" />
      <p className="mx-3 mt-5 mb-2 text-[13px] leading-[18px] font-semibold text-text">History</p>
      <History query={query} onPick={close} />
      <div className="grow" />
      <div className="flex items-center gap-2 px-1">
        <button
          type="button"
          aria-label="Settings"
          onClick={() => toast('Settings are on the way')}
          className={GLASS_BUTTON}
        >
          <SettingsIcon />
        </button>
        <label className={cn(GLASS_FIELD, 'grow gap-2 px-3.5')}>
          <SearchIcon />
          <input
            type="search"
            value={query}
            onChange={e => setQuery(e.target.value)}
            aria-label="Search history"
            placeholder="Search"
            className="min-w-0 grow bg-transparent text-[17px] leading-[22px] text-ink outline-none placeholder:text-muted [&::-webkit-search-cancel-button]:hidden"
          />
        </label>
        <button
          type="button"
          aria-label="New conversation"
          onClick={() => {
            onNewConversation();
            close();
            navigate('/');
          }}
          className={GLASS_BUTTON}
        >
          <PencilIcon />
        </button>
      </div>
    </nav>
  );
}

type PageProps = { to: string; icon: ReactNode; current?: boolean; onPick: () => void; children: ReactNode };

function Page({ to, icon, current, onPick, children }: PageProps) {
  return (
    <Link
      to={to}
      aria-current={current ? 'page' : undefined}
      onClick={onPick}
      className={cn(
        'flex h-12 items-center gap-3.5 rounded-2xl px-3 text-[17px] leading-[22px] font-semibold text-ink outline-none',
        'transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-blue',
        current ? 'bg-sunken' : 'hover:bg-sunken/60 active:bg-sunken',
      )}
    >
      <span className="flex w-6 justify-center text-ink">{icon}</span>
      {children}
    </Link>
  );
}

/**
 * This phone's conversations, newest first (state/threads.ts): an experiment's under its kit and plan, after the
 * kit's cover when the user photographed its packaging, with a dot while its run is under way; a plain one under its
 * first question. Tapping one goes back to it, to the run's step when it has begun.
 */
function History({ query, onPick }: { query: string; onPick: () => void }) {
  const navigate = useNavigate();
  const threads = useThreads(s => s.threads);
  const active = useThreads(s => s.active);
  const runThread = useThreads(s => s.runThread);
  const run = useRun();
  const firstAsk = useChatLog(s => s.exchanges.find(e => !e.event && e.ask)?.ask);
  const { list } = useProtocolList();
  // Each experiment's soonest timer, ticking while one runs: an incubation is seen from any conversation.
  const timers = runningTimers();
  const now = useNow(timers.some(a => a.endsAt > Date.now()) ? 1000 : 30000);
  const timerOf = (id: string, live: boolean) => timers.find(a => (live ? a.live : a.owner === id));
  const title = (id: string) => {
    const found = list?.find(p => p.id === id);
    return found ? shortName(found) : id;
  };

  const rows = threads
    .map(t => {
      const live = t.id === active || t.id === runThread;
      const r = t.id === runThread ? (run.protocolId ? run : null) : t.run;
      const ask = t.id === active ? firstAsk : t.chat.exchanges.find(e => !e.event && e.ask)?.ask;
      const timer = r?.protocolId ? timerOf(t.id, t.id === runThread) : undefined;
      return {
        id: t.id,
        timer: timer ? (timer.endsAt > now ? countdownText(Math.ceil((timer.endsAt - now) / 1000)) : 'Time’s up') : null,
        name: r?.protocolId ? `${title(r.protocolId)} · ${r.samples} × ${r.replicates}` : (ask ?? ''),
        protocolId: r?.protocolId ?? null,
        experiment: Boolean(r?.protocolId),
        started: r ? runStarted(r) : false,
        step: r?.step ?? 0,
        said: Boolean(ask),
        at: live ? Date.now() : t.updatedAt,
        current: t.id === active,
      };
    })
    .filter(row => row.experiment || row.said)
    .sort((a, b) => b.at - a.at);
  const shown = rows.filter(r => r.name.toLowerCase().includes(query.trim().toLowerCase()));

  if (!shown.length) {
    return (
      <p className="mx-3 flex min-h-12 items-center text-[15px] leading-5 font-medium text-muted">
        {rows.length ? 'Nothing matches' : 'No conversations yet'}
      </p>
    );
  }
  const open = (row: (typeof rows)[number]) => {
    openThread(row.id);
    onPick();
    const now = useRun.getState();
    navigate(row.experiment ? (runStarted(now) ? `/run/${now.step + 1}` : '/protocol') : '/chat');
  };
  return (
    <div className="flex min-h-0 flex-col gap-0.5 overflow-y-auto [scrollbar-width:none]">
      {shown.map(row => (
        <button
          key={row.id}
          type="button"
          aria-current={row.current ? 'true' : undefined}
          onClick={() => open(row)}
          className={cn(
            'flex min-h-12 shrink-0 items-center gap-2.5 rounded-2xl px-3 text-left text-ink outline-none transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-blue',
            row.current ? 'bg-sunken' : 'hover:bg-sunken/60 active:bg-sunken',
          )}
        >
          {row.experiment && <KitCover protocolId={row.protocolId} className="size-7 rounded-lg" />}
          <span className={cn('min-w-0 grow truncate text-[16px] leading-[21px]', row.experiment ? 'font-semibold' : 'font-medium')}>{row.name}</span>
          {row.started && <span role="img" aria-label="In progress" className="size-2 shrink-0 rounded-full bg-blue" />}
          {row.timer ? (
            <span aria-label={`Timer ${row.timer}`} className="shrink-0 text-[13px] leading-[18px] font-semibold text-blue tabular-nums">{row.timer}</span>
          ) : (
            <span className="shrink-0 text-[13px] leading-[18px] font-medium text-muted">{day(row.at)}</span>
          )}
        </button>
      ))}
    </div>
  );
}

/** "Today", else "Oct 30". */
function day(at: number): string {
  const d = new Date(at);
  return d.toDateString() === new Date().toDateString() ? 'Today' : d.toLocaleDateString('en', { month: 'short', day: 'numeric' });
}
