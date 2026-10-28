import { useEffect, useState, type CSSProperties } from 'react';
import { ArrowRight, BookOpen, Camera, FileUp, Keyboard, Menu, Mic, Plus, QrCode } from 'lucide-react';
import { Protocol, type Cite, type Note, type StandardCurve } from '../../shared/protocol.ts';
import { formatVolume, plateLayout, standardSeries, workingReagent } from '../../shared/calc.ts';
import './style-guide.css';

/** The run every example on this page is drawn for: the storyboard's 12 samples in duplicate. */
const RUN = { procedure: 'microplate', samples: 12, replicates: 2 };

/** A standard's shade of Meta blue: 0 for the blank up to 8 for the most concentrated. */
function shade(curve: StandardCurve, id: string) {
  const ascending = [...curve.points].sort((a, b) => a.concentration.value - b.concentration.value);
  const level = Math.round((ascending.findIndex(p => p.id === id) * 8) / (ascending.length - 1));
  return { background: `var(--std-${level})`, color: level >= 5 ? '#fff' : 'var(--ink)' } satisfies CSSProperties;
}

const noteLabel: Record<Note['kind'], string> = { expected: 'Expected', tip: 'Tip', caution: 'Caution', info: 'Good to know' };

function CiteChip({ cite }: { cite: Cite }) {
  const where = cite.table ?? cite.figure;
  return (
    <span className="cite" title={cite.quote}>
      <BookOpen size={13} aria-hidden /> Manual p. {cite.page}
      {where ? ` · ${where.split(' ').slice(0, 2).join(' ')}` : ''}
    </span>
  );
}

function NoteLine({ note }: { note: Note }) {
  return (
    <p className={`note ${note.kind}`}>
      <span className="note-kind">{noteLabel[note.kind]}</span>
      <span>{note.text}</span>
      <CiteChip cite={note.cite} />
    </p>
  );
}

/** The other ways in, besides talking: photograph the kit, scan a shared setup, or upload the manual. */
const startFrom = [
  { icon: Camera, label: 'Camera' },
  { icon: QrCode, label: 'QR code' },
  { icon: FileUp, label: 'Upload' },
];

function Home({ sheet }: { sheet?: boolean }) {
  return (
    <div className="phone-screen">
      <div className="home-top">
        <button className="round small" aria-label="Library and history"><Menu size={20} /></button>
      </div>
      <div className="home-center">
        <div className="chapp" aria-hidden>
          <img src="/chapp/chapp.webp" alt="" />
          <img className="chapp-blink" src="/chapp/chapp-blink.webp" alt="" />
        </div>
        <p className="home-hello">Good morning</p>
        <h3 className="home-ask">What are we running today?</h3>
      </div>
      <div className="home-bar">
        <button className={sheet ? 'round on' : 'round'} aria-label="Start from a photo, QR code or manual" aria-expanded={sheet}>
          <Plus size={22} />
        </button>
        <button className="mic" aria-label="Talk to Chapp"><Mic size={30} /></button>
        <button className="round" aria-label="Type instead"><Keyboard size={21} /></button>
      </div>
      {sheet && (
        <div className="plus-menu" role="menu">
          {startFrom.map(({ icon: Icon, label }) => (
            <button key={label} className="plus-item" role="menuitem">
              <Icon size={20} aria-hidden />
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function PhotoSlot({ small }: { small?: boolean }) {
  return (
    <div className={small ? 'photo-slot small' : 'photo-slot'}>
      <Camera size={small ? 16 : 20} aria-hidden />
      {!small && <span>Your kit photo</span>}
    </div>
  );
}

export function StyleGuide() {
  const [doc, setDoc] = useState<Protocol | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/protocols/pierce-bca')
      .then(async res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setDoc(Protocol.parse(await res.json()));
      })
      .catch(e => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (error) return <main className="sg"><p className="sg-status">Could not load the BCA protocol ({error}). Is the API running?</p></main>;
  if (!doc) return <main className="sg"><p className="sg-status">Loading the BCA protocol…</p></main>;

  const proc = doc.procedures.find(p => p.id === RUN.procedure)!;
  const curve = doc.standardCurves.find(c => c.id === proc.standardCurve)!;
  const mix = doc.mixes.find(m => m.id === proc.mix)!;
  const wr = workingReagent(doc, RUN.procedure, RUN.samples, RUN.replicates);
  const series = standardSeries(doc, RUN.procedure, RUN.replicates);
  const wells = new Map(plateLayout(doc, RUN.procedure, RUN.samples, RUN.replicates).map(w => [w.well, w]));
  const component = (id: string) => doc.components.find(c => c.id === id)!;
  const incubate = proc.steps.find(s => s.stage === 'incubate')!;
  const addWr = proc.steps.find(s => s.id === 'm-add-wr')!;
  const vial = series.vials.find(v => v.id === 'D')!;

  const needed: Record<string, string> = {
    ...Object.fromEntries(wr.parts.map(p => [p.component, formatVolume(p.volume)])),
    [curve.stock]: formatVolume(series.stock),
    [curve.diluent]: formatVolume(series.diluent),
  };
  const notes = [
    mix.notes.find(n => n.kind === 'expected'),
    proc.steps.flatMap(s => s.notes ?? []).find(n => n.kind === 'tip'),
    doc.procedures.flatMap(p => p.steps).flatMap(s => s.notes ?? []).find(n => n.kind === 'caution'),
    proc.steps.flatMap(s => s.notes ?? []).find(n => n.kind === 'info'),
  ].filter((n): n is Note => Boolean(n));

  return (
    <main className="sg">
      <header className="sg-head">
        <p className="sg-kicker">Interface style · draft 1</p>
        <h1 className="wordmark" aria-label="Chapp"><img className="wordmark-mark" src="/chapp/chapp.webp" alt="" />chapp</h1>
        <p className="sg-lede">
          Built for the bench: read from arm's length, used with gloves on, one thing at a time. Every number on this page
          comes from the {doc.kit.name} manual ({doc.source.docId} rev. {doc.source.revision}), drawn for {RUN.samples} samples
          in duplicate.
        </p>
      </header>

      <section className="sg-section">
        <h2>Principles</h2>
        <div className="principles">
          {[
            ['Readable from arm’s length', 'The line you act on is 36 px. Amounts use even-width digits so columns line up.'],
            ['One thing at a time', 'Only the current action is highlighted. Everything else steps back.'],
            ['Your real bottles', 'Reagent cards show the photos you take of your own kit, never drawings.'],
            ['Calm, then two colors', 'A neutral canvas. Meta blue shades the standards; yellow marks your samples and what to do now.'],
            ['Hands busy', 'Talk first, type second. Anything you press mid-run is at least 60 px.'],
          ].map(([title, line]) => (
            <article key={title} className="principle">
              <h3>{title}</h3>
              <p>{line}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="sg-section">
        <h2>Color</h2>
        <div className="swatches">
          {[
            ['Canvas', '--bg'], ['Card', '--card'], ['Ink', '--ink'], ['Text', '--text'],
            ['Muted', '--muted'], ['Line', '--line'], ['Meta blue', '--blue'], ['Now', '--mark'],
          ].map(([name, token]) => (
            <div key={token} className="swatch">
              <span className="swatch-chip" style={{ background: `var(${token})` }} />
              <span className="swatch-name">{name}</span>
              <span className="swatch-token">{token}</span>
            </div>
          ))}
        </div>
        <p className="sg-sub">Standards, by concentration</p>
        <div className="scale">
          {curve.points.map(p => (
            <span key={p.id} className="scale-step" style={shade(curve, p.id)}>
              <b>{p.id}</b>
              <span className="num">{p.blank ? 'blank' : p.concentration.value.toLocaleString('en-US')}</span>
            </span>
          ))}
          <span className="scale-step sample">
            <b>1</b>
            <span>sample</span>
          </span>
        </div>
      </section>

      <section className="sg-section">
        <h2>Type</h2>
        <div className="type-specimen">
          <p className="t-display">{doc.title}</p>
          <p className="t-title">{proc.steps.find(s => s.stage === 'mix')!.title}</p>
          <p className="t-bench">{addWr.key}</p>
          <p className="t-body">{doc.summary}</p>
          <p className="t-caption">Caption · Manual p. {curve.cite.page}, {curve.cite.table}</p>
          <p className="t-body num">{needed['reagent-a']} · {needed['reagent-b']} · 2,000 µg/mL · 37 °C · 562 nm</p>
        </div>
      </section>

      <section className="sg-section">
        <h2>Components</h2>
        <div className="components">
          <figure className="phone">
            <Home />
            <figcaption>Home: talk in the middle; + to show Chapp something, the keyboard to type.</figcaption>
          </figure>

          <figure className="phone">
            <Home sheet />
            <figcaption>+ opened.</figcaption>
          </figure>

          <div className="stack">
            <figure className="listening" aria-label="Listening">
              <span className="breath" aria-hidden />
              <span className="heard">make it triplicates</span>
              <button className="text-btn">Done</button>
            </figure>
            <p className="caption">Listening: what Chapp hears appears as you speak.</p>

            <article className="bench">
              <p className="bench-stage">Standards · vial {vial.id} of A–I</p>
              <h3 className="bench-key"><span className="marker">Vial {vial.id}</span></h3>
              <ul className="checklist">
                <li>
                  <span className="check" aria-hidden />
                  <span className="what">{component(curve.diluent).name.replace(/ \(.*\)$/, '')}</span>
                  <span className="amt num">{formatVolume(vial.diluent)}</span>
                </li>
                <li>
                  <span className="check" aria-hidden />
                  <span className="what">from vial <span className="vial small" style={shade(curve, vial.from!)}>{vial.from}</span></span>
                  <span className="amt num">{formatVolume(vial.take)}</span>
                </li>
              </ul>
              <p className="bench-result num">Makes {vial.concentration.toLocaleString('en-US')} µg/mL</p>
              <button className="next">Next vial <ArrowRight size={22} /></button>
              <CiteChip cite={curve.cite} />
            </article>
          </div>

          <div className="stack">
            <div className="reagents">
              {[...wr.parts.map(p => p.component), curve.stock, curve.diluent].map(id => {
                const c = component(id);
                const storage = c.storage ? `store ${c.storage.value}${c.storage.max ? `–${c.storage.max}` : ''} °C` : 'your own';
                return (
                  <article key={id} className="reagent">
                    <PhotoSlot />
                    <div className="reagent-body">
                      <p className="reagent-name">{c.name.replace(/ \(.*\)$/, '')}</p>
                      <p className="reagent-meta">{c.suppliedBy === 'kit' ? 'Kit' : 'You provide'} · {storage}</p>
                    </div>
                    <p className="reagent-amount num">{needed[id]}</p>
                  </article>
                );
              })}
            </div>
            <p className="caption">Reagent cards: your photo, the name on the label, what this run needs.</p>
          </div>

          <article className="card">
            <p className="eyebrow">Working reagent · {RUN.samples} samples × {RUN.replicates}</p>
            <p className="mix-total num">{formatVolume(wr.total)}</p>
            <div className="mix-parts">
              {wr.parts.map(p => (
                <div key={p.component} className="mix-part">
                  <PhotoSlot small />
                  <div>
                    <p className="part-name">{component(p.component).name}</p>
                    <p className="part-ratio">{mix.parts.find(x => x.component === p.component)!.parts} part{mix.parts.find(x => x.component === p.component)!.parts > 1 ? 's' : ''}</p>
                  </div>
                  <p className="part-amount num">{formatVolume(p.volume)}</p>
                </div>
              ))}
            </div>
            <NoteLine note={mix.notes.find(n => n.kind === 'expected')!} />
          </article>

          <article className="card wide">
            <p className="eyebrow">BSA standards · {curve.range.min}–{curve.range.max.toLocaleString('en-US')} µg/mL</p>
            <h3 className="card-title">Make vials A–I</h3>
            <table className="std-table">
              <thead>
                <tr><th>Vial</th><th>Diluent</th><th>BSA</th><th>Makes</th></tr>
              </thead>
              <tbody>
                {series.vials.map(v => (
                  <tr key={v.id}>
                    <td><span className="vial" style={shade(curve, v.id)}>{v.id}</span></td>
                    <td className="num">{formatVolume(v.diluent)}</td>
                    <td className="num">
                      {v.from === null ? '—' : (
                        <>
                          {formatVolume(v.take)}{' '}
                          {v.from === 'stock'
                            ? <span className="from">stock</span>
                            : <span className="from">of <span className="vial small" style={shade(curve, v.from)}>{v.from}</span></span>}
                        </>
                      )}
                    </td>
                    <td className="num">{v.blank ? 'Blank' : `${v.concentration.toLocaleString('en-US')} µg/mL`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <CiteChip cite={curve.cite} />
          </article>

          <article className="card wide">
            <p className="eyebrow">Plate · {wells.size} of 96 wells</p>
            <h3 className="card-title">Standards first, then your samples</h3>
            <div className="plate" role="img" aria-label={`${wells.size} wells: standards A to I and ${RUN.samples} samples, each in duplicate`}>
              <span />
              {Array.from({ length: 12 }, (_, c) => <span key={c} className="plate-head num">{c + 1}</span>)}
              {Array.from({ length: 8 }, (_, r) => {
                const row = String.fromCharCode(65 + r);
                return [
                  <span key={row} className="plate-head">{row}</span>,
                  ...Array.from({ length: 12 }, (_, c) => {
                    const w = wells.get(`${row}${c + 1}`);
                    if (!w) return <span key={c} className="well empty" />;
                    return w.kind === 'standard'
                      ? <span key={c} className="well" style={shade(curve, w.ref)}>{w.ref}</span>
                      : <span key={c} className="well sample num">{w.ref}</span>;
                  }),
                ];
              })}
            </div>
            <div className="legend">
              <span><i className="dot" style={{ background: 'var(--std-6)' }} /> Standard</span>
              <span><i className="dot sample" /> Your sample</span>
              <span><i className="dot empty" /> Empty</span>
            </div>
          </article>

          <article className="card timer">
            <p className="eyebrow">
              {incubate.timer!.label} · {incubate.timer!.temperature?.value}&nbsp;°C{incubate.timer!.covered ? ' · covered' : ''} · running
            </p>
            <div className="ring-wrap">
              {/* A run in progress: 21:30 of the manual's 30 minutes left. */}
              <svg viewBox="0 0 120 120" className="ring" aria-hidden>
                <circle cx="60" cy="60" r="52" className="ring-track" />
                <circle cx="60" cy="60" r="52" className="ring-left" pathLength="100" strokeDasharray={`${(21.5 / incubate.timer!.duration.value) * 100} 100`} />
              </svg>
              <div className="timer-center">
                <p className="timer-time num">21:30</p>
                <p className="timer-label">left of {incubate.timer!.duration.value} {incubate.timer!.duration.unit}</p>
              </div>
            </div>
            {incubate.timer!.alternatives?.map(alt => (
              <p key={alt.label} className="timer-alt">{alt.label}: {alt.duration.value} {alt.duration.unit} at {alt.temperature?.value} °C</p>
            ))}
            <CiteChip cite={incubate.cite} />
          </article>

          <article className="card">
            <p className="eyebrow">Controls</p>
            <div className="controls">
              <button className="btn primary">Start run</button>
              <button className="btn secondary">Change conditions</button>
              <div className="segmented" role="radiogroup" aria-label="Replicates">
                {[1, 2, 3].map(n => (
                  <button key={n} role="radio" aria-checked={n === RUN.replicates} className={n === RUN.replicates ? 'on' : ''}>
                    {['Single', 'Duplicate', 'Triplicate'][n - 1]}
                  </button>
                ))}
              </div>
              <div className="badges">
                <span className="badge sample-data">Sample data</span>
                <CiteChip cite={proc.cite} />
              </div>
            </div>
          </article>

          <article className="card wide">
            <p className="eyebrow">Notes, in Chapp’s words, each pointing back to the manual</p>
            <div className="notes">
              {notes.map(n => <NoteLine key={n.text} note={n} />)}
            </div>
          </article>
        </div>
      </section>
    </main>
  );
}
