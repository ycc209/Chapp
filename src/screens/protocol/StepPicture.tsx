import type { ReactNode } from 'react';
import type { BenchScene } from '../../../shared/bench.ts';
import { benchScenes } from '../../../shared/benchScenes.ts';
import type { Procedure, Protocol, Step } from '../../../shared/protocol.ts';
import { colourIn, mixColour as saidMixColour, prepKind } from '../../../shared/stepFacts.ts';
import { BenchView } from '../../components/bench/BenchView.tsx';
import { procedureFor } from './content.ts';

/**
 * A step's picture: its bench scene (shared/benchScenes.ts), drawn as the step leaves the bench, BioRender-like. Tapped
 * on its card, it opens enlarged and plays (BenchSheet). Nothing here asks a model (Muse Spark can write a step's
 * picture as SVG, server/pictures.ts, but no card asks for it); a step with no scene gets the simple picture. The kit
 * bottles the user photographed (`photos`, by component id) stand on the bench as theirs.
 */
export function StepPicture({ protocol, procedureId, stepId, photos }: { protocol: Protocol; procedureId?: string | null; stepId: string; photos?: Record<string, string> }) {
  const scene = scenesFor(protocol, procedureId).get(stepId);
  return scene?.items.length ? <BenchView scene={scene} mode="still" photos={photos} /> : <SimplePicture protocol={protocol} procedureId={procedureId} stepId={stepId} />;
}

const cache = new WeakMap<Protocol, Map<string, Map<string, BenchScene>>>();

/** The procedure's bench scenes by step id, composed once per protocol and procedure. */
export function scenesFor(protocol: Protocol, procedureId?: string | null): Map<string, BenchScene> {
  const proc = procedureFor(protocol, procedureId);
  const byProc = cache.get(protocol) ?? new Map<string, Map<string, BenchScene>>();
  cache.set(protocol, byProc);
  let scenes = byProc.get(proc.id);
  if (!scenes) {
    try {
      scenes = benchScenes(protocol, proc);
    } catch {
      scenes = new Map();
    }
    byProc.set(proc.id, scenes);
  }
  return scenes;
}

/**
 * The simple picture on a hands-on step's card, drawn from the protocol itself rather than a stock image: what the step
 * handles and does, with its own numbers and colours. The standards are one tube per vial of the dilution table,
 * lighter to darker; the mix is its bottles with their parts and the colour the protocol gives it; loading is the
 * pipette over the plate (or the tubes, or the dish of cells) with the wells it fills; washing is liquid out and
 * buffer in; preparing is read from the step's title, then its words (warm, spin, dilute, dissolve, grow). Flat
 * SVG, no network.
 */

const INK = '#2a3442';
const LINE = '#9aa8b8';
const GLASS = '#ffffff';
const SAMPLE = '#bcd2ea';
const CLEAR = '#dbe9f6';
const MEDIUM = '#f2a7b5';

const tint = (hex: string, k: number) => {
  const c = (i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  return `#${[0, 1, 2].map(i => Math.round(255 + (c(i) - 255) * k).toString(16).padStart(2, '0')).join('')}`;
};

export function SimplePicture({ protocol, procedureId, stepId }: { protocol: Protocol; procedureId?: string | null; stepId: string }) {
  const proc = procedureFor(protocol, procedureId);
  const step = [...(proc.prep ?? []), ...proc.steps].find(s => s.id === stepId);
  const body = step ? picture(protocol, proc, step) : null;
  if (!body) return null;
  return (
    <svg viewBox="0 0 100 100" className="block size-full" aria-hidden="true">
      {body}
    </svg>
  );
}

function picture(p: Protocol, proc: Procedure, step: Step): ReactNode {
  const mix = saidMixColour(p, proc) ?? (proc.mix ? '#8fb3dc' : SAMPLE);
  switch (step.stage) {
    case 'standards': {
      const curve = p.standardCurves.find(c => c.id === (step.standardCurve ?? proc.standardCurve));
      const pts = (curve?.points ?? []).slice(0, 9);
      if (!pts.length) return <Tubes n={6} y={34} colour={SAMPLE} />;
      const top = Math.max(...pts.map(x => x.concentration.value)) || 1;
      const w = Math.min(10, 84 / pts.length);
      const x0 = 50 - (pts.length * w) / 2;
      return (
        <>
          {pts.map((pt, i) => (
            <Tube key={pt.id} x={x0 + i * w + w * 0.15} y={30} w={w * 0.7} h={46} level={0.7} colour={pt.blank ? CLEAR : tint('#2f6fd6', 0.12 + 0.55 * (pt.concentration.value / top))} label={pts.every(x => x.id.length <= 2) ? pt.id : undefined} />
          ))}
        </>
      );
    }
    case 'mix': {
      const m = p.mixes.find(x => x.id === (step.mix ?? proc.mix));
      const parts = (m?.parts ?? []).slice(0, 3);
      if (!m) return <Bottle x={38} y={26} colour={mix} />;
      // Each part's bottle, as many parts as the protocol says; their colour only if it says that too.
      const bw = parts.length > 2 ? 15 : 20;
      const step_ = bw + 4;
      return (
        <>
          {parts.map((part, i) => {
            const named = p.components.find(c => c.id === part.component)?.notes?.map(n => colourIn(n.text)).find(Boolean);
            const x = 4 + i * step_;
            return (
              <g key={part.component}>
                <Bottle x={x} y={86 - bw * 2.1} w={bw} colour={named ?? CLEAR} />
                <text x={x + bw / 2} y={96} fontSize={8} fontWeight={700} fill={INK} textAnchor="middle">
                  {part.parts}
                </text>
              </g>
            );
          })}
          <Arrow x1={4 + parts.length * step_} y1={62} x2={4 + parts.length * step_ + 10} y2={62} />
          <Conical x={78} y={24} colour={mix} />
        </>
      );
    }
    case 'load':
    case 'treat': {
      const add = step.add?.[0];
      const colour = add?.what === 'mix' ? mix : add?.what === 'component' ? tint(mix, 0.5) : proc.format === 'cells' ? MEDIUM : SAMPLE;
      const curve = proc.standardCurve ? p.standardCurves.find(c => c.id === proc.standardCurve) : undefined;
      const wells = Math.min(96, (curve?.points.length ?? 8) * 2 + 24);
      return (
        <>
          {proc.format === 'microplate' ? <Plate y={56} filled={wells} colour={colour} /> : proc.format === 'cells' ? <Dish cy={74} colour={MEDIUM} /> : <Tubes n={5} y={50} colour={colour} />}
          <Pipette x={50} y={4} />
          <Drop x={50} y={46} colour={colour} />
        </>
      );
    }
    case 'wash':
      return (
        <>
          {proc.format === 'microplate' ? <Plate y={60} filled={40} colour={CLEAR} /> : proc.format === 'cells' ? <Dish cy={76} colour={CLEAR} /> : <Tubes n={5} y={52} colour={CLEAR} />}
          <Arrow x1={30} y1={50} x2={30} y2={22} />
          <Arrow x1={70} y1={22} x2={70} y2={50} />
          <Drop x={30} y={14} colour={LINE} />
          <Drop x={70} y={14} colour={CLEAR} />
        </>
      );
    case 'prepare': {
      // What the step does, by its title first (its key may mention other things), then by its words.
      const kind = prepKind(step) ?? 'bottles';
      if (kind === 'grow') return <Dish cy={60} colour={MEDIUM} cells={22} />;
      if (kind === 'spin')
        return (
          <>
            <Tube x={44} y={26} w={12} h={50} level={0.6} colour={SAMPLE} />
            <Spin />
          </>
        );
      if (kind === 'dilute')
        return (
          <>
            <Tubes n={4} y={52} colour={SAMPLE} />
            <Pipette x={50} y={2} />
            <Drop x={50} y={44} colour={SAMPLE} />
          </>
        );
      if (kind === 'dissolve')
        return (
          <>
            <Bottle x={36} y={36} w={28} colour={CLEAR} />
            <Pipette x={50} y={0} short />
            <Drop x={50} y={30} colour={CLEAR} />
          </>
        );
      return (
        <>
          <Bottle x={18} y={34} w={24} colour={CLEAR} />
          <Bottle x={58} y={34} w={24} colour={CLEAR} />
          {kind === 'warm' && <Warmth />}
        </>
      );
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// The pieces (liquids drawn as their own outline inside each vessel, so no clip paths or ids are needed)

function Tube({ x, y, w, h, level, colour, label }: { x: number; y: number; w: number; h: number; level: number; colour: string; label?: string }) {
  const shape = `M${x},${y} H${x + w} V${y + h * 0.78} L${x + w / 2},${y + h} L${x},${y + h * 0.78} Z`;
  const top = y + h * (1 - level);
  const cone = y + h * 0.78;
  const half = top <= cone ? w / 2 : ((y + h - top) / (h * 0.22)) * (w / 2);
  const liquid = top <= cone ? `M${x},${top} H${x + w} V${cone} L${x + w / 2},${y + h} L${x},${cone} Z` : `M${x + w / 2 - half},${top} H${x + w / 2 + half} L${x + w / 2},${y + h} Z`;
  return (
    <g>
      <path d={shape} fill={GLASS} />
      <path d={liquid} fill={colour} />
      <path d={shape} fill="none" stroke={LINE} strokeWidth={0.8} strokeLinejoin="round" />
      <rect x={x - 0.6} y={y - 2} width={w + 1.2} height={2.4} rx={0.8} fill={LINE} />
      {label && (
        <text x={x + w / 2} y={y + h + 7} fontSize={5} fontWeight={700} fill={INK} textAnchor="middle">
          {label}
        </text>
      )}
    </g>
  );
}

function Tubes({ n, y, colour }: { n: number; y: number; colour: string }) {
  return (
    <>
      {Array.from({ length: n }, (_, i) => (
        <Tube key={i} x={14 + i * 15} y={y} w={9} h={40} level={0.5} colour={colour} />
      ))}
    </>
  );
}

function Bottle({ x, y, w = 22, colour }: { x: number; y: number; w?: number; colour: string }) {
  const h = w * 2.1;
  const body = `M${x},${y + h * 0.3} Q${x},${y + h * 0.18} ${x + w * 0.3},${y + h * 0.14} V${y + h * 0.05} H${x + w * 0.7} V${y + h * 0.14} Q${x + w},${y + h * 0.18} ${x + w},${y + h * 0.3} V${y + h} H${x} Z`;
  return (
    <g>
      <path d={body} fill={GLASS} />
      <rect x={x} y={y + h * 0.42} width={w} height={h * 0.58} fill={colour} />
      <path d={body} fill="none" stroke={LINE} strokeWidth={0.8} strokeLinejoin="round" />
      <rect x={x + w * 0.26} y={y} width={w * 0.48} height={h * 0.08} rx={1} fill={INK} />
      <rect x={x + w * 0.18} y={y + h * 0.55} width={w * 0.64} height={h * 0.2} rx={1.2} fill="#ffffff" opacity={0.85} />
    </g>
  );
}

function Conical({ x, y, colour }: { x: number; y: number; colour: string }) {
  const shape = `M${x},${y} H${x + 18} V${y + 46} L${x + 9},${y + 60} L${x},${y + 46} Z`;
  return (
    <g>
      <path d={shape} fill={GLASS} />
      <path d={`M${x},${y + 16} H${x + 18} V${y + 46} L${x + 9},${y + 60} L${x},${y + 46} Z`} fill={colour} />
      <path d={shape} fill="none" stroke={LINE} strokeWidth={0.8} strokeLinejoin="round" />
      <rect x={x - 1} y={y - 4} width={20} height={5} rx={1.4} fill={INK} />
    </g>
  );
}

/** A 96-well plate seen from above at a slant: the first `filled` wells, column by column, hold `colour`. */
function Plate({ y, filled, colour }: { y: number; filled: number; colour: string }) {
  const wells = [];
  for (let col = 0; col < 12; col++)
    for (let row = 0; row < 8; row++) {
      const i = col * 8 + row;
      wells.push(<ellipse key={i} cx={13 + col * 6.7} cy={y + 3 + row * 4.2} rx={2.3} ry={1.6} fill={i < filled ? colour : '#ffffff'} stroke={LINE} strokeWidth={0.35} />);
    }
  return (
    <g>
      <rect x={8} y={y} width={84} height={38} rx={3} fill="#f6f8fb" stroke={LINE} strokeWidth={0.8} />
      {wells}
    </g>
  );
}

function Dish({ cy, colour, cells = 14 }: { cy: number; colour: string; cells?: number }) {
  return (
    <g>
      <ellipse cx={50} cy={cy + 4} rx={40} ry={13} fill="#e8edf3" />
      <ellipse cx={50} cy={cy} rx={40} ry={13} fill={GLASS} stroke={LINE} strokeWidth={0.8} />
      <ellipse cx={50} cy={cy + 1} rx={35} ry={10} fill={colour} opacity={0.75} />
      {Array.from({ length: cells }, (_, i) => {
        const a = i * 2.4, r = 0.25 + ((i * 37) % 10) / 14;
        return <circle key={i} cx={50 + Math.cos(a) * r * 30} cy={cy + 1 + Math.sin(a) * r * 8} r={1.5} fill="#b06f82" opacity={0.8} />;
      })}
    </g>
  );
}

function Pipette({ x, y, short = false }: { x: number; y: number; short?: boolean }) {
  const h = short ? 26 : 34;
  return (
    <g>
      <rect x={x - 3} y={y} width={6} height={4} rx={1.5} fill={INK} />
      <rect x={x - 4.5} y={y + 4} width={9} height={h * 0.55} rx={3} fill="#e3e8ef" stroke={LINE} strokeWidth={0.8} />
      <path d={`M${x - 3},${y + 4 + h * 0.55} L${x + 3},${y + 4 + h * 0.55} L${x + 0.6},${y + 4 + h} L${x - 0.6},${y + 4 + h} Z`} fill={GLASS} stroke={LINE} strokeWidth={0.8} strokeLinejoin="round" />
    </g>
  );
}

function Drop({ x, y, colour }: { x: number; y: number; colour: string }) {
  return <path d={`M${x},${y - 4} C${x + 3},${y} ${x + 3},${y + 3} ${x},${y + 3} C${x - 3},${y + 3} ${x - 3},${y} ${x},${y - 4} Z`} fill={colour} stroke={LINE} strokeWidth={0.5} />;
}

function Arrow({ x1, y1, x2, y2 }: { x1: number; y1: number; x2: number; y2: number }) {
  const a = Math.atan2(y2 - y1, x2 - x1);
  const head = `${x2},${y2} ${x2 - 4 * Math.cos(a - 0.5)},${y2 - 4 * Math.sin(a - 0.5)} ${x2 - 4 * Math.cos(a + 0.5)},${y2 - 4 * Math.sin(a + 0.5)}`;
  return (
    <g stroke={INK} fill={INK} opacity={0.7}>
      <line x1={x1} y1={y1} x2={x2} y2={y2} strokeWidth={1.4} strokeLinecap="round" />
      <polygon points={head} stroke="none" />
    </g>
  );
}

/** Warming to room temperature: soft waves rising. */
function Warmth() {
  return (
    <g fill="none" stroke="#ef8a24" strokeWidth={1.4} strokeLinecap="round" opacity={0.85}>
      {[30, 50, 70].map(x => (
        <path key={x} d={`M${x},26 q3,-4 0,-8 q-3,-4 0,-8`} />
      ))}
    </g>
  );
}

/** Spinning: two arcs round the tube. */
function Spin() {
  return (
    <g fill="none" stroke={INK} strokeWidth={1.4} strokeLinecap="round" opacity={0.6}>
      <path d="M26,40 A26,26 0 0 1 74,40" />
      <path d="M74,72 A26,26 0 0 1 26,72" />
      <polygon points="74,40 69,37 71,44" fill={INK} stroke="none" />
      <polygon points="26,72 31,75 29,68" fill={INK} stroke="none" />
    </g>
  );
}
