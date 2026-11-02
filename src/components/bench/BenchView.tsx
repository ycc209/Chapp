import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { BenchScene, Item, Look } from '../../../shared/bench.ts';
import { Arrow, BenchDefs, Beaker, BigText, Bottle, Centrifuge, Chart, Conical, Dish, Flask, Incubator, Microscope, PhotoBottle, Pipette, Plate, Rack, Reader, Reservoir, Thermometer, Timer, Tube, WashBottle } from './Items.tsx';

/**
 * A bench scene (shared/bench.ts) as a drawing that happens. `still`: the step done, its items appearing one after
 * another the first time it is shown (a step card). `play`: from the start, its timeline played: the pipette moves,
 * drops fall, wells fill column by column, a colour turns (the enlarged step). A tap on an item picks it. A kit bottle
 * the user has photographed (`photos`, by component id) stands on the bench as their own bottle. `big`: the words on
 * it (amounts, volumes, temperatures) big enough to read from arm's length, for the run.
 */

type Drop = { key: number; x: number; y1: number; y2: number; colour: string; ms: number };

/** The scene as it stands once every action has played. */
export function settled(scene: BenchScene): Record<string, Item> {
  const looks = Object.fromEntries(scene.items.map(it => [it.id, it]));
  for (const a of scene.actions) if (a.set && looks[a.id]) looks[a.id] = merge(looks[a.id]!, a.set);
  return looks;
}

/** The user's photo of the kit bottle this item is, if it is one and they took one. */
export function photoOf(it: Item, photos?: Record<string, string>): string | undefined {
  if (it.kind !== 'bottle' || it.source.from !== 'protocol' || !photos) return undefined;
  const component = /^components\.([^.]+)$/.exec(it.source.field)?.[1];
  return component ? photos[component] : undefined;
}

const merge = (it: Item, set: Partial<Look>): Item => ({ ...it, ...set, ...(set.wells ? { wells: { ...it.wells, ...set.wells } } : {}) });

export function BenchView({ scene, mode, picked, onPick, replay = 0, photos, big }: { scene: BenchScene; mode: 'still' | 'play'; picked?: string | null; onPick?: (id: string | null) => void; replay?: number; photos?: Record<string, string>; big?: boolean }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const start = useMemo(() => (mode === 'still' ? settled(scene) : Object.fromEntries(scene.items.map(it => [it.id, it]))), [scene, mode]);
  const [looks, setLooks] = useState(start);
  const [ms, setMs] = useState<Record<string, number>>({});
  const [drops, setDrops] = useState<Drop[]>([]);
  const timers = useRef<number[]>([]);

  useEffect(() => {
    setLooks(start);
    setMs({});
    setDrops([]);
    if (mode !== 'play') return;
    let key = 0;
    for (const a of scene.actions) {
      timers.current.push(
        window.setTimeout(() => {
          if (a.set) {
            setLooks(l => (l[a.id] ? { ...l, [a.id]: merge(l[a.id]!, a.set!) } : l));
            setMs(m => ({ ...m, [a.id]: a.ms }));
          }
          if (a.drop) {
            const d = { key: ++key, ...a.drop, ms: Math.max(250, a.ms) };
            setDrops(ds => [...ds, d]);
            timers.current.push(window.setTimeout(() => setDrops(ds => ds.filter(x => x.key !== d.key)), d.ms + 50));
          }
        }, a.at),
      );
    }
    return () => {
      timers.current.forEach(clearTimeout);
      timers.current = [];
    };
  }, [scene, mode, start, replay]);

  const order = scene.items.map(it => looks[it.id]!).filter(Boolean);
  const lastTube = order.map(it => it.kind).lastIndexOf('tube');
  const drawn: ReactNode[] = [];
  order.forEach((it, i) => {
    drawn.push(<Placed key={it.id} it={it} ms={ms[it.id] ?? 600} index={i} picked={picked === it.id} onPick={onPick} clip={`${id}-${it.id.replace(/[^a-zA-Z0-9]/g, '')}`} photo={photoOf(it, photos)} />);
    // A rack's front face covers the feet of the tubes in it.
    if (i === lastTube)
      for (const rack of order.filter(r => r.kind === 'rack'))
        drawn.push(
          <g key={`${rack.id}-front`} style={{ transform: `translate(${rack.x}px, ${rack.y}px) scale(${rack.scale ?? 1})` }}>
            <Rack it={rack} front />
          </g>,
        );
  });

  return (
    <svg viewBox="0 0 240 240" className="block size-full" role="img" aria-label={scene.title} onClick={() => onPick?.(null)}>
      <style>{`
        .bench-in { animation: bench-in 520ms cubic-bezier(.2,.8,.2,1.15) both; }
        @keyframes bench-in { from { opacity: 0; transform: translateY(6px) scale(.96); } to { opacity: 1; transform: none; } }
        .bench-drop { animation: bench-drop var(--ms) cubic-bezier(.5,0,.9,.6) both; }
        @keyframes bench-drop { from { transform: translateY(0); opacity: 1; } 85% { opacity: 1; } to { transform: translateY(var(--fall)); opacity: 0; } }
        @media (prefers-reduced-motion: reduce) { .bench-in, .bench-drop { animation: none; } }
      `}</style>
      <BenchDefs id={id}>
        <BigText.Provider value={!!big}>{drawn}</BigText.Provider>
        {drops.map(d => (
          <g key={d.key} transform={`translate(${d.x} ${d.y1})`}>
            <g className="bench-drop" style={{ ['--ms' as string]: `${d.ms}ms`, ['--fall' as string]: `${d.y2 - d.y1}px` }}>
              <path d="M0,-3.6 C2.2,-0.6 2.6,1.2 0,2.6 C-2.6,1.2 -2.2,-0.6 0,-3.6 Z" fill={d.colour} stroke="#6f7e90" strokeWidth={0.4} />
              <ellipse cx={-0.7} cy={0.2} rx={0.6} ry={1} fill="#ffffff" opacity={0.7} />
            </g>
          </g>
        ))}
      </BenchDefs>
    </svg>
  );
}

function Placed({ it, ms, index, picked, onPick, clip, photo }: { it: Item; ms: number; index: number; picked: boolean; onPick?: (id: string | null) => void; clip: string; photo?: string }) {
  return (
    <g
      style={{
        transform: `translate(${it.x}px, ${it.y}px) rotate(${it.rotate ?? 0}deg) scale(${it.scale ?? 1})`,
        transition: `transform ${ms}ms cubic-bezier(.4,.1,.2,1), opacity 400ms ease`,
        opacity: it.hidden ? 0 : 1,
        cursor: onPick ? 'pointer' : undefined,
        filter: picked ? 'drop-shadow(0 0 2.5px #2b7de9) drop-shadow(0 0 1px #2b7de9)' : undefined,
      }}
      onClick={
        onPick
          ? e => {
              e.stopPropagation();
              onPick(it.id);
            }
          : undefined
      }
    >
      <g className="bench-in" style={{ animationDelay: `${index * 70}ms` }}>
        {photo ? <PhotoBottle it={it} ms={ms} clip={clip} photo={photo} /> : draw(it, ms, clip)}
        {it.kind === 'tube' && it.label && (
          <text x={0} y={11} fontSize={6.4} fontWeight={700} fill="#2f3a48" textAnchor="middle" dominantBaseline="middle">
            {it.label}
          </text>
        )}
      </g>
    </g>
  );
}

function draw(it: Item, ms: number, clip: string): ReactNode {
  switch (it.kind) {
    case 'tube':
      return <Tube it={it} ms={ms} clip={clip} />;
    case 'conical':
      return <Conical it={it} ms={ms} clip={clip} />;
    case 'bottle':
      return <Bottle it={it} ms={ms} clip={clip} />;
    case 'pipette':
      return <Pipette it={it} />;
    case 'reservoir':
      return <Reservoir it={it} ms={ms} />;
    case 'plate':
      return <Plate it={it} ms={ms} />;
    case 'rack':
      return <Rack it={it} />;
    case 'dish':
      return <Dish it={it} ms={ms} />;
    case 'flask':
      return <Flask it={it} ms={ms} clip={clip} />;
    case 'beaker':
      return <Beaker it={it} ms={ms} clip={clip} />;
    case 'washbottle':
      return <WashBottle it={it} ms={ms} clip={clip} />;
    case 'incubator':
      return <Incubator it={it} ms={ms} />;
    case 'reader':
      return <Reader it={it} ms={ms} />;
    case 'centrifuge':
      return <Centrifuge it={it} ms={ms} />;
    case 'microscope':
      return <Microscope />;
    case 'timer':
      return <Timer it={it} ms={ms} />;
    case 'thermometer':
      return <Thermometer it={it} />;
    case 'arrow':
      return <Arrow it={it} />;
    case 'chart':
      return <Chart it={it} ms={ms} />;
  }
}
