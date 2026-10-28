import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import type { Protocol } from '../../../shared/protocol.ts';
import { cn } from '../../lib/cn.ts';
import { useProtocol } from '../../state/protocol.ts';
import { useRun } from '../../state/run.ts';
import { useSharedLibrary } from './store.ts';

// The protocols this app has; only the BCA kit so far (data/protocols/).
const SAVED = ['pierce-bca'];

/**
 * /library: My-Library ("Library", the protocols saved on this phone; opening one goes to its protocol) and, with
 * ?view=shared, Library ("Shared library", Soon in the sidebar: your setups to upload, and an empty shelf for others').
 * Both come from the sidebar and go back to it.
 */
export function LibraryScreen() {
  const [params] = useSearchParams();
  return params.get('view') === 'shared' ? <SharedLibrary /> : <MyLibrary />;
}

// The design's page: 56 px from the top (under the status bar), 20 at the sides, 34 at the bottom.
const PAGE = 'flex h-full flex-col gap-[18px] overflow-y-auto bg-bg px-5 pt-[calc(56px+var(--screen-top))] pb-[var(--screen-bottom)] text-text [scrollbar-width:none]';
const CARD = 'grid items-center gap-3 rounded-[20px] bg-white py-3 pr-3.5 pl-3 shadow-[0_1px_2px_rgba(17,17,19,0.03),0_4px_14px_rgba(17,17,19,0.05)]';
const CAPTION = 'mx-1 my-0 text-[13px] leading-[18px] font-semibold text-text';
const SIDEBAR = '/?state=sidebar';

function MyLibrary() {
  const [query, setQuery] = useState('');
  const runProtocol = useRun(s => s.protocolId);
  const ids = runProtocol && !SAVED.includes(runProtocol) ? [...SAVED, runProtocol] : SAVED;
  return (
    <div className={PAGE}>
      <Header title="Library">
        <Link to={SIDEBAR} aria-label="Library and history" className={CORNER}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </Link>
      </Header>
      <Search label="Search your protocols" placeholder="Search your protocols" value={query} onChange={setQuery} />
      <section aria-label="Saved" className="flex flex-col gap-2">
        <p className={CAPTION}>Saved</p>
        {ids.map(id => (
          <Saved key={id} id={id} query={query} />
        ))}
      </section>
    </div>
  );
}

/** One saved protocol, as Library's card: opens its protocol screen. Marked "Just saved" while it is the run's. */
function Saved({ id, query }: { id: string; query: string }) {
  const navigate = useNavigate();
  const { protocol, error } = useProtocol(id);
  const runProtocol = useRun(s => s.protocolId);
  const runProcedure = useRun(s => s.procedure);
  if (error) return <p className="mx-1 my-0 text-[15px] leading-5 text-muted">{error}</p>;
  if (!protocol || !matches(protocol, query)) return null;
  const current = runProtocol === id;
  const procedure = protocol.procedures.find(p => p.id === (current ? runProcedure : protocol.defaults.procedure)) ?? protocol.procedures[0]!;
  return (
    <Link
      to="/protocol"
      onClick={e => {
        // Another protocol than the run's: switch the run to it (a fresh start) before opening it.
        if (current) return;
        e.preventDefault();
        useRun.getState().setProtocol(id);
        navigate('/protocol');
      }}
      className={cn(CARD, 'grid-cols-[44px_minmax(0,1fr)_16px] text-ink no-underline outline-none focus-visible:ring-2 focus-visible:ring-blue')}
    >
      <BookIcon />
      <span className="flex min-w-0 flex-col gap-[3px]">
        <span className="text-base leading-5 font-[650] text-ink">{protocol.title}</span>
        <span className="flex items-center gap-1.5 text-[13px] leading-[18px] text-text">
          {current && <span className="rounded-lg bg-sample-bg px-[7px] py-px text-[11px] leading-4 font-bold text-sample-ink">Just saved</span>}
          {procedure.name} · {procedure.steps.length} steps
        </span>
      </span>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#6c6c72" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="m9 6 6 6-6 6" />
      </svg>
    </Link>
  );
}

function SharedLibrary() {
  const [query, setQuery] = useState('');
  return (
    <div className={PAGE}>
      <Header title="Shared library">
        <Link to={SIDEBAR} aria-label="Back to library and history" className={CORNER}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m15 6-6 6 6 6" />
          </svg>
        </Link>
      </Header>
      <Search label="Search kits or protocols" placeholder="Kit name or catalog number" value={query} onChange={setQuery} />
      <section aria-label="Your setups" className="flex flex-col gap-2">
        <p className={CAPTION}>Your setups</p>
        {SAVED.map(id => (
          <Setup key={id} id={id} query={query} />
        ))}
      </section>
      <section aria-label="From others" className="flex flex-col items-center gap-1.5 rounded-card bg-sunken px-6 py-9 text-center">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#6c6c72" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="9" cy="8" r="3" />
          <path d="M3 20a6 6 0 0 1 12 0M16 5a3 3 0 0 1 0 6M21 20a5 5 0 0 0-4-4.9" />
        </svg>
        <p className="m-0 text-base leading-[22px] font-[650] text-ink">Setups others upload show up here</p>
        <p className="m-0 text-sm leading-5 text-text">Search by kit name or catalog number</p>
      </section>
    </div>
  );
}

/**
 * One of this phone's setups in the shared library: "Only on this phone" with Upload, or already in it (Share-QR's
 * Add to library). Uploading only marks it for now; the shared library itself is not built yet.
 */
function Setup({ id, query }: { id: string; query: string }) {
  const { protocol } = useProtocol(id);
  const shared = useSharedLibrary(s => s.ids.includes(id));
  const add = useSharedLibrary(s => s.add);
  if (!protocol || !matches(protocol, query)) return null;
  return (
    <div className={cn(CARD, 'grid-cols-[44px_minmax(0,1fr)_auto]')}>
      <BookIcon />
      <span className="flex min-w-0 flex-col gap-px">
        <span className="text-base leading-5 font-[650] text-ink">{protocol.title}</span>
        <span className="text-[13px] leading-[18px] text-text">{shared ? 'In the shared library' : 'Only on this phone'}</span>
      </span>
      {!shared && (
        <button
          type="button"
          onClick={() => add(id)}
          className="min-h-10 rounded-full bg-ink px-3.5 text-sm leading-[18px] font-[650] text-white outline-none focus-visible:ring-2 focus-visible:ring-blue focus-visible:ring-offset-2"
        >
          Upload
        </button>
      )}
    </div>
  );
}

/** A protocol matches a search by its title, kit name or a catalog number. */
function matches(p: Protocol, query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [p.title, p.kit.name, ...p.kit.variants.map(v => v.catalog)].some(s => s.toLowerCase().includes(q));
}

const CORNER = 'flex size-11 items-center justify-center rounded-full text-ink outline-none focus-visible:ring-2 focus-visible:ring-blue';

function Header({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      {children}
      <h1 className="m-0 text-[22px] leading-7 font-bold text-ink">{title}</h1>
    </div>
  );
}

function Search({ label, placeholder, value, onChange }: { label: string; placeholder: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex min-h-12 items-center gap-2.5 rounded-inner bg-white px-4 text-text shadow-[inset_0_0_0_1.5px_#e6e6e3] focus-within:shadow-[inset_0_0_0_1.5px_#0064e0]">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      <input
        type="search"
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={e => onChange(e.target.value)}
        className="min-w-0 grow border-0 bg-transparent text-base leading-5 text-ink outline-none [&::-webkit-search-cancel-button]:hidden"
      />
    </label>
  );
}

function BookIcon() {
  return (
    <span aria-hidden="true" className="flex size-11 items-center justify-center rounded-xl bg-tip-bg text-blue">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 4h6a4 4 0 0 1 4 4v12a3 3 0 0 0-3-3H2zM22 4h-6a4 4 0 0 0-4 4v12a3 3 0 0 1 3-3h7z" />
      </svg>
    </span>
  );
}
