import { useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { Sheet, SheetClose, SheetContent, SheetTitle } from '../../components/ui/Sheet.tsx';
import { toast } from '../../components/ui/Toaster.tsx';
import { cn } from '../../lib/cn.ts';
import { useRun } from '../../state/run.ts';
import { GLASS_BUTTON, GLASS_FIELD } from './bar.ts';
import { GlobeIcon, HomeIcon, LibraryIcon, PencilIcon, PeopleIcon, SearchIcon, SettingsIcon } from './icons.tsx';

// Names for the protocols the app knows; only the BCA kit so far.
const PROTOCOL_NAMES: Record<string, string> = { 'pierce-bca': 'Pierce BCA' };

type SidebarProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The pencil: a fresh conversation on the home screen. */
  onNewConversation: () => void;
};

/**
 * Library and history (Sidebar.dc.html): the pages, then this phone's experiments, then settings, search and a new
 * conversation. The page itself slides right and stays visible as the thing to tap to close (Home moves it; this
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
      <p className="mx-3 mt-5 mb-2 text-[13px] leading-[18px] font-semibold text-text">Experiments</p>
      <Experiments query={query} onPick={close} />
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
            aria-label="Search experiments"
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
 * The runs on this phone. There is one run at a time (state/run.ts), so this lists it, marked in progress once it
 * has started; past runs and past conversations come when the app keeps them.
 */
function Experiments({ query, onPick }: { query: string; onPick: () => void }) {
  const protocolId = useRun(s => s.protocolId);
  const samples = useRun(s => s.samples);
  const replicates = useRun(s => s.replicates);
  const step = useRun(s => s.step);
  const started = useRun(
    s => s.step > 0 || [s.done, s.timers, s.readings].some(record => Object.keys(record).length > 0),
  );

  const runs = protocolId
    ? [{ id: protocolId, name: `${PROTOCOL_NAMES[protocolId] ?? protocolId} · ${samples} × ${replicates}` }]
    : [];
  const shown = runs.filter(r => r.name.toLowerCase().includes(query.trim().toLowerCase()));

  if (!shown.length) {
    return (
      <p className="mx-3 flex min-h-12 items-center text-[15px] leading-5 font-medium text-muted">
        {runs.length ? 'Nothing matches' : 'No experiments yet'}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-0.5">
      {shown.map(run => (
        <Link
          key={run.id}
          // The run's own screen once it has started (steps count from 1 there), its protocol before.
          to={started ? `/run/${step + 1}` : '/protocol'}
          onClick={() => {
            // Back to this run: Chapp follows it again after a New conversation set it aside.
            useRun.getState().setAside(false);
            onPick();
          }}
          className="flex min-h-12 items-center gap-2.5 rounded-2xl px-3 text-ink outline-none transition-colors duration-100 hover:bg-sunken/60 focus-visible:ring-2 focus-visible:ring-blue active:bg-sunken"
        >
          <span className="min-w-0 truncate text-[16px] leading-[21px] font-semibold">{run.name}</span>
          {started && (
            <span role="img" aria-label="In progress" className="size-2 shrink-0 rounded-full bg-blue" />
          )}
        </Link>
      ))}
    </div>
  );
}
