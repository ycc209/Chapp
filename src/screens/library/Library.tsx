import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { toast } from '../../components/ui/Toaster.tsx';
import { cn } from '../../lib/cn.ts';
import { librarySections, saveProtocol, unsaveProtocol, useKits, useMine, useRoom, type LibraryRow } from '../../state/library.ts';
import { useProtocol, useProtocolList } from '../../state/protocol.ts';
import { runStarted, useRun } from '../../state/run.ts';
import { useSharedLibrary } from './store.ts';

/**
 * /library: My-Library ("Library", this phone's protocols: Saved, Recent, and the other kits Chapp has read on this
 * computer; opening one makes it the run, asking first when another run is under way) and, with ?view=shared, Library
 * ("Shared library", Soon in the sidebar: your setups to upload, and an empty shelf for others'). Both come from the
 * sidebar and go back to it. What is mine and each kit's photos: state/library.ts.
 */
export function LibraryScreen() {
  const [params] = useSearchParams();
  return params.get('view') === 'shared' ? <SharedLibrary /> : <MyLibrary />;
}

// The design's page: 56 px from the top (under the status bar), 20 at the sides, 34 at the bottom.
const PAGE = 'flex h-full flex-col gap-[18px] overflow-y-auto bg-bg px-5 pt-[calc(56px+var(--screen-top))] pb-[var(--screen-bottom)] text-text [scrollbar-width:none]';
const CARD = 'grid items-center gap-3 rounded-[20px] bg-white py-3 pr-3.5 pl-3 shadow-[0_1px_2px_rgba(17,17,19,0.03),0_4px_14px_rgba(17,17,19,0.05)]';
const SHADOW = 'rounded-[20px] bg-white shadow-[0_1px_2px_rgba(17,17,19,0.03),0_4px_14px_rgba(17,17,19,0.05)]';
const CAPTION = 'mx-1 my-0 text-[13px] leading-[18px] font-semibold text-text';
const NOTE = 'mx-1 my-0 text-[15px] leading-5 text-muted';
const SIDEBAR = '/?state=sidebar';
/** Kit photos shown on a card; the rest are counted. */
const THUMBS = 4;

function MyLibrary() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const { list, error } = useProtocolList();
  const mine = useMine(s => s.protocols);
  const full = useRoom(s => s.full);
  const runId = useRun(s => s.protocolId);
  const started = useRun(runStarted);
  // The protocol the user tapped while another run is under way: its card asks before the run is replaced.
  const [asking, setAsking] = useState<string | null>(null);
  const { saved, recent, others } = librarySections(list ?? [], mine, query);
  const rows = [...saved, ...recent, ...others];
  const runTitle = rows.find(r => r.id === runId)?.title ?? 'current';

  const go = (id: string) => {
    if (id !== useRun.getState().protocolId) useRun.getState().setProtocol(id);
    navigate('/protocol');
  };
  const open = (id: string) => (id !== runId && runId && started ? setAsking(id) : go(id));
  const toggle = (row: LibraryRow) => {
    if (row.savedAt === null) {
      if (!saveProtocol(row.id, { title: row.title })) toast('This phone has no room left to save it.');
      return;
    }
    const was = unsaveProtocol(row.id);
    toast(`Removed ${row.title} from Saved`, { action: { label: 'Undo', onClick: () => saveProtocol(row.id, { title: row.title, at: was ?? Date.now() }) } });
  };
  const card = (row: LibraryRow) => (
    <Card
      key={row.id}
      row={row}
      current={row.id === runId}
      onOpen={() => open(row.id)}
      onToggle={() => toggle(row)}
      asking={asking === row.id ? { run: runTitle, onOpen: () => go(row.id), onKeep: () => setAsking(null) } : null}
    />
  );

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
      {full && (
        <p role="alert" className={NOTE}>
          This phone is out of room: new kit photos may not be kept.
        </p>
      )}
      {error && <p className={NOTE}>{error}</p>}
      {(list || error) && (
        <>
          <section aria-label="Saved" className="flex flex-col gap-2">
            <p className={CAPTION}>Saved</p>
            {saved.length === 0 && !query && <p className={NOTE}>Nothing saved yet. Tap the bookmark on a protocol to keep it here.</p>}
            {saved.map(card)}
          </section>
          {recent.length > 0 && (
            <section aria-label="Recent" className="flex flex-col gap-2">
              <p className={CAPTION}>Recent</p>
              {recent.map(card)}
            </section>
          )}
          {others.length > 0 && (
            <section aria-label="Other kits Chapp has read" className="flex flex-col gap-2">
              <p className={CAPTION}>Other kits Chapp has read</p>
              {others.map(card)}
            </section>
          )}
          {query && rows.length === 0 && <p className={NOTE}>Nothing matches “{query.trim()}”.</p>}
        </>
      )}
    </div>
  );
}

type Asking = { run: string; onOpen: () => void; onKeep: () => void };

/**
 * One protocol as Library's card: the user's kit photos when they took any, "This run" on the run's own, and the
 * bookmark that saves it or takes it out of Saved. A protocol no longer on this computer can only be taken out.
 */
function Card({ row, current, onOpen, onToggle, asking }: { row: LibraryRow; current: boolean; onOpen: () => void; onToggle: () => void; asking: Asking | null }) {
  const photos = useKits(s => s.kits[row.id]);
  const shots = Object.values(photos ?? {});
  const saved = row.savedAt !== null;
  const gone = row.summary === null;
  return (
    <div className={cn(SHADOW, 'flex flex-col')}>
      <div className="grid grid-cols-[minmax(0,1fr)_44px] items-center gap-1 py-1.5 pr-1.5 pl-3">
        <button
          type="button"
          onClick={onOpen}
          disabled={gone}
          aria-expanded={asking ? true : undefined}
          className="grid min-w-0 grid-cols-[44px_minmax(0,1fr)] items-center gap-3 rounded-2xl py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-blue"
        >
          <BookIcon />
          <span className="flex min-w-0 flex-col gap-[3px]">
            <span className="text-base leading-5 font-[650] text-ink">{row.title}</span>
            <span className="flex items-center gap-1.5 text-[13px] leading-[18px] text-text">
              {current && <span className="shrink-0 rounded-lg bg-sample-bg px-[7px] py-px text-[11px] leading-4 font-bold text-sample-ink">This run</span>}
              {row.summary ? `${row.summary.procedure} · ${row.summary.steps} steps` : 'Not on this computer anymore'}
            </span>
            {shots.length > 0 && (
              <span aria-label={`Your kit: ${shots.length} ${shots.length === 1 ? 'photo' : 'photos'}`} className="mt-1 flex items-center gap-1.5">
                {shots.slice(0, THUMBS).map((src, i) => (
                  <img key={i} src={src} alt="" className="size-8 rounded-lg object-cover" />
                ))}
                {shots.length > THUMBS && <span className="text-[13px] leading-[18px] font-semibold text-text">+{shots.length - THUMBS}</span>}
              </span>
            )}
          </span>
        </button>
        <button
          type="button"
          onClick={onToggle}
          aria-pressed={saved}
          aria-label={saved ? `Saved: ${row.title}` : `Save ${row.title}`}
          className="flex size-11 items-center justify-center rounded-full text-ink outline-none focus-visible:ring-2 focus-visible:ring-blue"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill={saved ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
            <path d="M6 3h12v18l-6-4-6 4z" />
          </svg>
        </button>
      </div>
      {asking && (
        <div role="group" aria-label="Replace the run" className="mx-3 mb-3 flex flex-col gap-2.5 border-t border-line pt-3">
          <p className="m-0 text-[15px] leading-5 text-ink">
            Your <b className="font-semibold">{asking.run}</b> run is under way. Open {row.title} instead? That run’s ticks, timers and readings are cleared.
          </p>
          <div className="flex gap-2">
            <button type="button" onClick={asking.onOpen} className="min-h-10 rounded-full bg-ink px-3.5 text-sm leading-[18px] font-[650] text-white outline-none focus-visible:ring-2 focus-visible:ring-blue focus-visible:ring-offset-2">
              Open it
            </button>
            <button type="button" onClick={asking.onKeep} className="min-h-10 rounded-full bg-sunken px-3.5 text-sm leading-[18px] font-[650] text-ink outline-none focus-visible:ring-2 focus-visible:ring-blue">
              Keep my run
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function SharedLibrary() {
  const [query, setQuery] = useState('');
  const mine = useMine(s => s.protocols);
  const sharedIds = useSharedLibrary(s => s.ids);
  const ids = [...new Set([...Object.keys(mine).filter(id => mine[id]!.savedAt !== null), ...sharedIds])];
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
        {ids.length === 0 && <p className={NOTE}>Save a protocol to your library first; then you can share it here.</p>}
        {ids.map(id => (
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
  if (!protocol || !matches([protocol.title, protocol.kit.name, ...protocol.kit.variants.map(v => v.catalog)], query)) return null;
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
function matches(fields: string[], query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fields.some(s => s.toLowerCase().includes(q));
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
