import { createContext, useContext, type CSSProperties, type ReactNode } from 'react';
import type { Item } from '../../../shared/bench.ts';
import { useCutout } from './cutout.ts';

/**
 * Real lab items, drawn as a scientific illustration (BioRender-like): translucent polypropylene tubes with snap caps
 * and graduations, glass bottles with ridged caps and printed labels, a micropipette with its colour-coded plunger,
 * volume window and tip, a 96-well plate at a slant with its A–H and 1–12 marks, an incubator with its glass door and
 * display. Each is drawn round its foot on the bench (0, 0), y up being negative, and takes its state from the scene:
 * how full, with what, cap open or shut, which wells hold what, what its display says. Changes ease (CSS transitions),
 * so a scene's timeline (BenchView.tsx) plays as motion.
 */

const OUT = '#6f7e90';
const INK = '#2f3a48';
const SOFT = '#8a97a7';
const EMPTY = '#eef3f8';

/** Ids of the shared gradients, unique per drawing. */
const Defs = createContext('b');
export const useDefs = () => {
  const p = useContext(Defs);
  return (name: string) => `url(#${p}-${name})`;
};

export function BenchDefs({ id, children }: { id: string; children: ReactNode }) {
  const g = (name: string) => `${id}-${name}`;
  return (
    <Defs.Provider value={id}>
      <defs>
        <linearGradient id={g('plastic')} x1="0" x2="1">
          <stop offset="0" stopColor="#e9eef4" />
          <stop offset="0.32" stopColor="#ffffff" />
          <stop offset="0.7" stopColor="#f1f4f8" />
          <stop offset="1" stopColor="#d9e0e8" />
        </linearGradient>
        <linearGradient id={g('glass')} x1="0" x2="1">
          <stop offset="0" stopColor="#c9d8e8" stopOpacity="0.7" />
          <stop offset="0.28" stopColor="#ffffff" stopOpacity="0.35" />
          <stop offset="0.75" stopColor="#e3ecf5" stopOpacity="0.4" />
          <stop offset="1" stopColor="#b9cbe0" stopOpacity="0.75" />
        </linearGradient>
        <linearGradient id={g('device')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fbfcfd" />
          <stop offset="1" stopColor="#e2e7ed" />
        </linearGradient>
        <linearGradient id={g('deviceSide')} x1="0" x2="1">
          <stop offset="0" stopColor="#f3f5f8" />
          <stop offset="1" stopColor="#d3dae3" />
        </linearGradient>
        <linearGradient id={g('metal')} x1="0" x2="1">
          <stop offset="0" stopColor="#c3ccd6" />
          <stop offset="0.45" stopColor="#f1f4f7" />
          <stop offset="1" stopColor="#aeb8c4" />
        </linearGradient>
        <linearGradient id={g('liquid')} x1="0" x2="1">
          <stop offset="0" stopColor="#000000" stopOpacity="0.14" />
          <stop offset="0.35" stopColor="#ffffff" stopOpacity="0.22" />
          <stop offset="0.65" stopColor="#ffffff" stopOpacity="0.05" />
          <stop offset="1" stopColor="#000000" stopOpacity="0.16" />
        </linearGradient>
        <radialGradient id={g('shadow')}>
          <stop offset="0" stopColor="#253246" stopOpacity="0.28" />
          <stop offset="1" stopColor="#253246" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={g('well')} cx="0.5" cy="0.4" r="0.6">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#cdd6e0" />
        </radialGradient>
        <linearGradient id={g('screen')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#253244" />
          <stop offset="1" stopColor="#111a26" />
        </linearGradient>
      </defs>
      {children}
    </Defs.Provider>
  );
}

const ease = (ms: number): CSSProperties => ({ transition: `transform ${ms}ms cubic-bezier(.4,.1,.2,1), fill ${Math.max(ms, 300)}ms ease, opacity ${ms}ms ease` });

/** A soft shadow on the bench under an item. */
function Shadow({ w, d = 4 }: { w: number; d?: number }) {
  const u = useDefs();
  return <ellipse cx={0} cy={1} rx={w / 2} ry={d} fill={u('shadow')} />;
}

/** Liquid in a vessel: the body's shape, filled from the bottom to `level`, with a lighter surface. */
function Liquid({ clip, top, bottom = 0, width, level, colour, ms }: { clip: string; top: number; bottom?: number; width: number; level: number; colour: string; ms: number }) {
  const u = useDefs();
  const h = bottom - top;
  return (
    <g clipPath={`url(#${clip})`}>
      <g style={{ ...ease(ms), transform: `scaleY(${Math.max(0.0001, level)})`, transformBox: 'fill-box', transformOrigin: '50% 100%' }}>
        <rect x={-width / 2} y={top} width={width} height={h} style={{ fill: colour, ...ease(ms) }} />
        <rect x={-width / 2} y={top} width={width} height={h} fill={u('liquid')} />
      </g>
      <g style={{ ...ease(ms), transform: `translateY(${-h * level}px)`, opacity: level > 0.02 ? 1 : 0 }}>
        <ellipse cx={0} cy={bottom} rx={width / 2} ry={1.4} style={{ fill: colour, ...ease(ms) }} />
        <ellipse cx={0} cy={bottom} rx={width / 2} ry={1.4} fill="#ffffff" opacity={0.45} />
      </g>
    </g>
  );
}

// ---------------------------------------------------------------------------------------------------------------

/** A 1.5 mL microcentrifuge tube: conical body, lip, snap cap on its hinge (open when something goes in). */
export function Tube({ it, ms, clip }: { it: Item; ms: number; clip: string }) {
  const u = useDefs();
  const body = 'M-7,-44 L7,-44 L7,-17 C7,-9 2.2,-1.5 0.9,0 L-0.9,0 C-2.2,-1.5 -7,-9 -7,-17 Z';
  return (
    <g>
      <Shadow w={16} d={2.6} />
      <clipPath id={clip}>
        <path d={body} />
      </clipPath>
      <path d={body} fill={u('plastic')} opacity={0.92} />
      <Liquid clip={clip} top={-44} width={16} level={it.level ?? 0} colour={it.liquid ?? EMPTY} ms={ms} />
      <path d={body} fill="none" stroke={OUT} strokeWidth={0.8} />
      {[-36, -30, -24].map(y => (
        <line key={y} x1={-7} x2={-4.2} y1={y} y2={y} stroke={OUT} strokeWidth={0.45} opacity={0.6} />
      ))}
      <path d="M-4.6,-41 L-4.6,-19" stroke="#ffffff" strokeWidth={1.4} strokeLinecap="round" opacity={0.8} />
      <rect x={-8.6} y={-47.2} width={17.2} height={3.4} rx={1} fill={u('plastic')} stroke={OUT} strokeWidth={0.7} />
      {/* The cap swings open on its hinge at the right of the lip. */}
      <g style={{ ...ease(ms), transform: it.open ? 'rotate(118deg)' : 'rotate(0deg)', transformOrigin: '8.6px -47px' }}>
        <rect x={-8} y={-52.6} width={16} height={5.6} rx={1.8} style={{ fill: it.cap ?? '#f3f6f9', ...ease(ms) }} stroke={OUT} strokeWidth={0.7} />
        <rect x={-5.5} y={-51.4} width={11} height={1.3} rx={0.6} fill="#ffffff" opacity={0.6} />
      </g>
      <path d="M8.4,-48.4 h2.6 a1.4,1.4 0 0 1 0,2.8 h-2.6" fill={u('plastic')} stroke={OUT} strokeWidth={0.6} />
    </g>
  );
}

/** A 15 mL conical tube: screw cap with ridges, threads, graduations, a label strip. */
export function Conical({ it, ms, clip }: { it: Item; ms: number; clip: string }) {
  const u = useDefs();
  const body = 'M-12.5,-96 L12.5,-96 L12.5,-24 L2.6,-1.2 Q0,1.4 -2.6,-1.2 L-12.5,-24 Z';
  return (
    <g>
      <Shadow w={26} d={3} />
      <clipPath id={clip}>
        <path d={body} />
      </clipPath>
      <path d={body} fill={u('plastic')} opacity={0.9} />
      <Liquid clip={clip} top={-96} width={26} level={it.level ?? 0} colour={it.liquid ?? EMPTY} ms={ms} />
      <path d={body} fill="none" stroke={OUT} strokeWidth={0.9} />
      {Array.from({ length: 7 }, (_, i) => (
        <line key={i} x1={12.5} x2={i % 2 ? 9.5 : 7.5} y1={-32 - i * 9} y2={-32 - i * 9} stroke={OUT} strokeWidth={0.5} opacity={0.7} />
      ))}
      <path d="M-8.5,-92 L-8.5,-30" stroke="#ffffff" strokeWidth={2} strokeLinecap="round" opacity={0.75} />
      {it.label && (
        <g>
          <rect x={-9} y={-84} width={14} height={30} rx={1.5} fill="#ffffff" opacity={0.92} stroke="#d4dbe3" strokeWidth={0.5} />
          <text x={-2} y={-69} fontSize={6.5} fontWeight={700} fill={INK} textAnchor="middle" dominantBaseline="middle" transform="rotate(-90 -2 -69)">
            {it.label}
          </text>
        </g>
      )}
      <rect x={-13.5} y={-99.5} width={27} height={4} fill="#e6ebf1" stroke={OUT} strokeWidth={0.6} />
      <rect x={-14.5} y={-112} width={29} height={13} rx={2.2} style={{ fill: it.cap ?? '#2b7de9', ...ease(ms) }} stroke={OUT} strokeWidth={0.7} />
      {Array.from({ length: 9 }, (_, i) => (
        <line key={i} x1={-11 + i * 2.75} x2={-11 + i * 2.75} y1={-110.5} y2={-100.5} stroke="#ffffff" strokeWidth={0.6} opacity={0.35} />
      ))}
    </g>
  );
}

/** A glass reagent bottle: shoulders, neck, ridged screw cap, a printed label with the reagent's name. */
export function Bottle({ it, ms, clip }: { it: Item; ms: number; clip: string }) {
  const u = useDefs();
  const body = 'M-22,-56 C-22,-63 -14,-65 -9,-67 L-9,-73 L9,-73 L9,-67 C14,-65 22,-63 22,-56 L22,-5 Q22,0 17,0 L-17,0 Q-22,0 -22,-5 Z';
  const words = (it.label ?? '').split(/\s+/);
  const lines = words.length > 1 && (it.label ?? '').length > 10 ? [words.slice(0, Math.ceil(words.length / 2)).join(' '), words.slice(Math.ceil(words.length / 2)).join(' ')] : [it.label ?? ''];
  return (
    <g>
      <Shadow w={46} d={4} />
      <clipPath id={clip}>
        <path d={body} />
      </clipPath>
      <path d={body} fill={u('glass')} />
      <Liquid clip={clip} top={-62} width={44} level={it.level ?? 0} colour={it.liquid ?? EMPTY} ms={ms} />
      <path d={body} fill="none" stroke={OUT} strokeWidth={0.9} />
      <path d="M-17,-52 L-17,-8" stroke="#ffffff" strokeWidth={2.4} strokeLinecap="round" opacity={0.7} />
      {it.label && (
        <g>
          <rect x={-16} y={-46} width={32} height={26} rx={2} fill="#ffffff" stroke="#d0d7e0" strokeWidth={0.6} />
          <rect x={-16} y={-46} width={32} height={4} rx={1} style={{ fill: it.cap ?? '#2b7de9', ...ease(ms) }} />
          {lines.map((line, i) => (
            // A long word is squeezed to the label's width rather than cut.
            <text key={i} x={0} y={-34.5 + i * 7.5 - (lines.length - 1) * 3.2} fontSize={line.length > 11 ? 5 : 6} fontWeight={700} fill={INK} textAnchor="middle" dominantBaseline="middle" {...(line.length * (line.length > 11 ? 5 : 6) * 0.62 > 28 ? { textLength: 28, lengthAdjust: 'spacingAndGlyphs' } : {})}>
              {line}
            </text>
          ))}
          <line x1={-11} x2={11} y1={-23.5} y2={-23.5} stroke="#c9d1db" strokeWidth={0.8} />
        </g>
      )}
      <rect x={-10.5} y={-76} width={21} height={4} fill="#e6ebf1" stroke={OUT} strokeWidth={0.6} />
      <rect x={-12} y={-89} width={24} height={14} rx={2.2} style={{ fill: it.cap ?? '#2b7de9', ...ease(ms) }} stroke={OUT} strokeWidth={0.7} />
      {Array.from({ length: 8 }, (_, i) => (
        <line key={i} x1={-9 + i * 2.6} x2={-9 + i * 2.6} y1={-87.5} y2={-76.5} stroke="#ffffff" strokeWidth={0.6} opacity={0.35} />
      ))}
    </g>
  );
}

/**
 * The user's own bottle, from their photo of the kit, standing where the drawn bottle would: cut out of its
 * background (cutout.ts), as tall as the drawn bottle (so the arrows and the pipette meet it where they would) and no
 * wider than its place on the bench, its foot melting into its shadow. Only a cut-out that came out whole stands
 * there; until it is ready, and when it did not (the kit screen asks for a better photo), the drawn bottle does.
 */
export function PhotoBottle({ it, ms, clip, photo }: { it: Item; ms: number; clip: string; photo: string }) {
  const cut = useCutout(photo);
  if (!cut?.ok) return <Bottle it={it} ms={ms} clip={clip} />;
  const aspect = cut.width / cut.height;
  const width = Math.min(52, 89 * aspect);
  const height = width / aspect;
  return (
    <g>
      <Shadow w={Math.max(30, width * 1.15)} d={3.5} />
      <linearGradient id={`${clip}-fade`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0.9" stopColor="#ffffff" />
        <stop offset="1" stopColor="#ffffff" stopOpacity="0.3" />
      </linearGradient>
      <mask id={`${clip}-foot`}>
        <rect x={-width / 2} y={-height} width={width} height={height} fill={`url(#${clip}-fade)`} />
      </mask>
      <g style={{ filter: 'drop-shadow(0 0.6px 1px rgba(37,50,70,0.32))' }}>
        <image href={cut.src} x={-width / 2} y={-height} width={width} height={height} mask={`url(#${clip}-foot)`} />
      </g>
    </g>
  );
}

/** A single-channel micropipette, tip down: plunger (its colour gives the range), body with finger hook and volume window, ejector, tip. */
export function Pipette({ it }: { it: Item }) {
  const u = useDefs();
  return (
    <g>
      <path d="M-0.55,0 L0.55,0 L4.1,-33 L-4.1,-33 Z" fill="#eef5fc" fillOpacity={0.85} stroke={OUT} strokeWidth={0.6} />
      {it.liquid && <path d="M-0.5,-0.2 L0.5,-0.2 L1.5,-9 L-1.5,-9 Z" fill={it.liquid} />}
      <rect x={-4.6} y={-36} width={9.2} height={3.4} rx={0.8} fill="#dfe6ee" stroke={OUT} strokeWidth={0.5} />
      <rect x={-3.6} y={-62} width={7.2} height={26.5} fill={u('metal')} stroke={OUT} strokeWidth={0.5} />
      <rect x={-5.4} y={-68} width={10.8} height={6.5} rx={1.2} fill="#cfd7e0" stroke={OUT} strokeWidth={0.5} />
      <path d="M-9,-68 L9,-68 L10.4,-121 Q10.4,-126 6,-126 L-6,-126 Q-10.4,-126 -10.4,-121 Z" fill={u('device')} stroke={OUT} strokeWidth={0.8} />
      <path d="M10.2,-102 C21,-102 23,-111 14.5,-114.5 L10.3,-114.5" fill="#e3e8ee" stroke={OUT} strokeWidth={0.7} />
      <rect x={-5.6} y={-104} width={11.2} height={15} rx={1.6} fill={u('screen')} />
      <text x={0} y={-96.2} fontSize={4.6} fontWeight={700} fill="#8ff0c4" textAnchor="middle" dominantBaseline="middle" fontFamily="ui-monospace, monospace">
        {it.text ?? '200'}
      </text>
      <rect x={-9} y={-80} width={18} height={2.2} fill={it.cap ?? '#f2c230'} opacity={0.8} />
      <rect x={-13.2} y={-124} width={5} height={11} rx={1.6} fill="#cbd3dc" stroke={OUT} strokeWidth={0.5} />
      <rect x={-2.1} y={-134} width={4.2} height={9} fill="#b7c0cb" />
      <rect x={-7} y={-142.5} width={14} height={9} rx={3.2} fill={it.cap ?? '#f2c230'} stroke={OUT} strokeWidth={0.6} />
      <rect x={-4.6} y={-141.2} width={9.2} height={2} rx={1} fill="#ffffff" opacity={0.45} />
    </g>
  );
}

/** Where a plate's well is, at a slant: the back rows a little narrower and shallower. */
export function wellAt(row: number, col: number) {
  const t = (row + 0.5) / 8;
  const y = -66 + t * 50;
  const half = 79 + t * 8;
  const x = -half + ((col + 0.5) * (2 * half)) / 12;
  const rx = ((2 * half) / 12) * 0.36;
  return { x, y, rx, ry: rx * (0.55 + t * 0.12) };
}

/** A 96-well plate at a slant from the front: white polystyrene, skirt, A1 corner chamfered, rows A–H and columns 1–12 marked. */
const darker = (hex: string) => `#${[0, 1, 2].map(i => Math.round(parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) * 0.72).toString(16).padStart(2, '0')).join('')}`;

export function Plate({ it, ms }: { it: Item; ms: number }) {
  const u = useDefs();
  const wells = it.wells ?? {};
  const cells: ReactNode[] = [];
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 12; c++) {
      const { x, y, rx, ry } = wellAt(r, c);
      const name = `${String.fromCharCode(65 + r)}${c + 1}`;
      const colour = wells[name];
      cells.push(
        <g key={name}>
          <ellipse cx={x} cy={y} rx={rx} ry={ry} fill={u('well')} stroke="#b6c1cd" strokeWidth={0.45} />
          {/* Liquid in a well: its colour, rimmed a little darker, so a clear one shows as filled too. */}
          <ellipse cx={x} cy={y + ry * 0.12} rx={rx * 0.86} ry={ry * 0.8} strokeWidth={0.5} style={{ fill: colour ?? 'transparent', stroke: colour ? darker(colour) : 'transparent', opacity: colour ? 1 : 0, transitionDelay: `${c * Math.min(60, ms / 14)}ms`, ...ease(ms) }} />
          {colour && <ellipse cx={x - rx * 0.25} cy={y - ry * 0.2} rx={rx * 0.32} ry={ry * 0.22} fill="#ffffff" opacity={0.45} />}
        </g>,
      );
    }
  return (
    <g>
      <Shadow w={200} d={6} />
      <path d="M-97,-13 L97,-13 L97,0 L-97,0 Z" fill="#e1e7ee" stroke={OUT} strokeWidth={0.8} />
      <path d="M-97,-13 L-88,-73 L80,-73 L88,-73 L97,-13 Z" fill="#ffffff" />
      <path d="M-97,-13 L-88,-66 L-81,-73 L88,-73 L97,-13 Z" fill={u('device')} stroke={OUT} strokeWidth={0.9} strokeLinejoin="round" />
      {cells}
      {Array.from({ length: 12 }, (_, c) => {
        const { x } = wellAt(-0.9, c);
        return (
          <text key={c} x={x} y={-69.3} fontSize={3.4} fill={SOFT} textAnchor="middle" dominantBaseline="middle">
            {c + 1}
          </text>
        );
      })}
      {Array.from({ length: 8 }, (_, r) => {
        const { y } = wellAt(r, 0);
        return (
          <text key={r} x={-89 - r * 0.9} y={y} fontSize={3.6} fill={SOFT} textAnchor="middle" dominantBaseline="middle">
            {String.fromCharCode(65 + r)}
          </text>
        );
      })}
    </g>
  );
}

/** A tube rack: the top with its holes (behind the tubes) and, drawn after them, its front face. */
export function Rack({ it, front }: { it: Item; front?: boolean }) {
  const u = useDefs();
  const w = it.width ?? 180;
  if (front)
    return (
      <g>
        <rect x={-w / 2} y={-14} width={w} height={14} rx={2} fill={u('deviceSide')} stroke={OUT} strokeWidth={0.8} />
        <rect x={-w / 2 + 3} y={-11} width={w - 6} height={1.2} fill="#ffffff" opacity={0.6} />
      </g>
    );
  return (
    <g>
      <Shadow w={w + 8} d={5} />
      <path d={`M${-w / 2},-14 L${-w / 2 + 6},-24 L${w / 2 - 6},-24 L${w / 2},-14 Z`} fill="#eef2f6" stroke={OUT} strokeWidth={0.8} />
    </g>
  );
}

/** A reagent reservoir (trough) seen from the front and above, with what it holds. */
export function Reservoir({ it, ms }: { it: Item; ms: number }) {
  const level = it.level ?? 0;
  return (
    <g>
      <Shadow w={78} d={4} />
      <path d="M-38,-30 L38,-30 L32,0 L-32,0 Z" fill="#f4f7fa" stroke={OUT} strokeWidth={0.8} />
      <path d="M-34,-27 L34,-27 L29,-3 L-29,-3 Z" fill="#e8eef4" />
      <path d={`M${-29 - 5 * level},${-3 - 24 * level} L${29 + 5 * level},${-3 - 24 * level} L29,-3 L-29,-3 Z`} style={{ fill: it.liquid ?? EMPTY, ...ease(ms) }} opacity={level > 0.02 ? 0.9 : 0} />
      <path d="M-38,-30 L38,-30" stroke={OUT} strokeWidth={1.2} />
    </g>
  );
}

/** A culture dish from above at a slant: medium, and the cells on its floor. */
export function Dish({ it, ms }: { it: Item; ms: number }) {
  return (
    <g>
      <Shadow w={112} d={6} />
      <ellipse cx={0} cy={-8} rx={54} ry={17} fill="#e7edf3" stroke={OUT} strokeWidth={0.8} />
      <path d="M-54,-8 L-54,-16 A54,17 0 0 1 54,-16 L54,-8" fill="none" stroke={OUT} strokeWidth={0.8} />
      <ellipse cx={0} cy={-16} rx={54} ry={17} fill="#f6f9fb" fillOpacity={0.6} stroke={OUT} strokeWidth={0.8} />
      <ellipse cx={0} cy={-14} rx={49} ry={14.5} style={{ fill: it.liquid ?? '#f2a7b5', ...ease(ms) }} opacity={0.85} />
      {Array.from({ length: Number(it.text ?? 26) }, (_, i) => {
        const a = i * 2.39996, r = Math.sqrt((i + 0.5) / Number(it.text ?? 26));
        return <ellipse key={i} cx={Math.cos(a) * r * 42} cy={-14 + Math.sin(a) * r * 11} rx={2.4} ry={1.4} transform={`rotate(${(i * 47) % 180} ${Math.cos(a) * r * 42} ${-14 + Math.sin(a) * r * 11})`} fill="#c0708a" opacity={0.75} />;
      })}
      <path d="M-40,-24 A48,13 0 0 1 10,-29" stroke="#ffffff" strokeWidth={1.6} fill="none" opacity={0.7} />
    </g>
  );
}

/** A culture flask: canted neck and vented cap, medium along its floor, cells on it. */
export function Flask({ it, ms, clip }: { it: Item; ms: number; clip: string }) {
  const u = useDefs();
  const body = 'M-40,-6 L-40,-46 Q-40,-50 -36,-50 L22,-50 L34,-60 L40,-54 L30,-42 L30,-6 Q30,0 24,0 L-34,0 Q-40,0 -40,-6 Z';
  return (
    <g>
      <Shadow w={84} d={4} />
      <clipPath id={clip}>
        <path d={body} />
      </clipPath>
      <path d={body} fill={u('glass')} />
      <Liquid clip={clip} top={-50} width={84} level={it.level ?? 0.28} colour={it.liquid ?? '#f2a7b5'} ms={ms} />
      <path d={body} fill="none" stroke={OUT} strokeWidth={0.9} strokeLinejoin="round" />
      {Array.from({ length: 14 }, (_, i) => (
        <ellipse key={i} cx={-34 + i * 4.4} cy={-3.2} rx={1.6} ry={0.9} fill="#c0708a" opacity={0.8} />
      ))}
      <g transform="rotate(45 37 -57)">
        <rect x={31} y={-66} width={13} height={10} rx={2} style={{ fill: it.cap ?? '#2b7de9', ...ease(ms) }} stroke={OUT} strokeWidth={0.6} />
      </g>
      <path d="M-34,-44 L14,-44" stroke="#ffffff" strokeWidth={1.6} strokeLinecap="round" opacity={0.7} />
    </g>
  );
}

/** A glass beaker with spout and graduations (waste, or what is poured). */
export function Beaker({ it, ms, clip }: { it: Item; ms: number; clip: string }) {
  const u = useDefs();
  const body = 'M-22,-58 L-25,-62 L22,-62 L22,-4 Q22,0 18,0 L-18,0 Q-22,0 -22,-4 Z';
  return (
    <g>
      <Shadow w={48} d={4} />
      <clipPath id={clip}>
        <path d={body} />
      </clipPath>
      <path d={body} fill={u('glass')} />
      <Liquid clip={clip} top={-62} width={48} level={it.level ?? 0} colour={it.liquid ?? EMPTY} ms={ms} />
      <path d={body} fill="none" stroke={OUT} strokeWidth={0.9} />
      {[-48, -38, -28, -18].map(y => (
        <line key={y} x1={10} x2={20} y1={y} y2={y} stroke={OUT} strokeWidth={0.5} opacity={0.7} />
      ))}
      <path d="M-16,-54 L-16,-8" stroke="#ffffff" strokeWidth={2} strokeLinecap="round" opacity={0.65} />
    </g>
  );
}

/** A squeeze wash bottle with its bent nozzle. */
export function WashBottle({ it, ms, clip }: { it: Item; ms: number; clip: string }) {
  const u = useDefs();
  const body = 'M-17,-50 Q-17,-58 -8,-60 L8,-60 Q17,-58 17,-50 L17,-4 Q17,0 13,0 L-13,0 Q-17,0 -17,-4 Z';
  return (
    <g>
      <Shadow w={36} d={3} />
      <clipPath id={clip}>
        <path d={body} />
      </clipPath>
      <path d={body} fill={u('plastic')} opacity={0.85} />
      <Liquid clip={clip} top={-60} width={36} level={it.level ?? 0.7} colour={it.liquid ?? EMPTY} ms={ms} />
      <path d={body} fill="none" stroke={OUT} strokeWidth={0.9} />
      <rect x={-8} y={-68} width={16} height={9} rx={1.5} fill={it.cap ?? '#e0564f'} stroke={OUT} strokeWidth={0.6} />
      <path d="M2,-68 L2,-80 Q2,-86 10,-88 L22,-92" fill="none" stroke="#c3ccd6" strokeWidth={2.2} strokeLinecap="round" />
      <path d="M-12,-46 L-12,-8" stroke="#ffffff" strokeWidth={1.8} strokeLinecap="round" opacity={0.7} />
    </g>
  );
}

/** A CO₂ incubator: cabinet, glass inner door with shelves, display, handle. `open`: the door swung aside. */
export function Incubator({ it, ms }: { it: Item; ms: number }) {
  const u = useDefs();
  return (
    <g>
      <Shadow w={118} d={6} />
      <rect x={-55} y={-128} width={110} height={124} rx={5} fill={u('device')} stroke={OUT} strokeWidth={0.9} />
      <rect x={-51} y={-124} width={102} height={14} rx={2.5} fill="#e9edf2" stroke={OUT} strokeWidth={0.5} />
      <rect x={-46} y={-122} width={34} height={10} rx={1.5} fill={u('screen')} />
      <text x={-29} y={-116.8} fontSize={6.2} fontWeight={700} fill="#8ff0c4" textAnchor="middle" dominantBaseline="middle" fontFamily="ui-monospace, monospace">
        {it.text ?? '37.0 °C'}
      </text>
      <circle cx={8} cy={-117} r={2.6} fill="#c3ccd6" />
      <circle cx={16} cy={-117} r={2.6} fill="#c3ccd6" />
      <circle cx={42} cy={-117} r={2.2} style={{ fill: it.text ? '#34c38f' : '#c3ccd6', ...ease(ms) }} />
      {/* Inside: shelves, seen through the glass door or when it is open. */}
      <rect x={-47} y={-104} width={94} height={92} rx={2} fill="#dfe6ee" />
      {[-80, -56, -32].map(y => (
        <rect key={y} x={-45} y={y} width={90} height={2.4} fill="#b7c2ce" />
      ))}
      <g style={{ ...ease(ms), transform: it.open ? 'scaleX(0.12)' : 'scaleX(1)', transformOrigin: '-49px 0px' }}>
        <rect x={-49} y={-106} width={98} height={96} rx={2.5} fill="#e7f0f9" fillOpacity={0.55} stroke={OUT} strokeWidth={0.8} />
        <path d="M-40,-100 L-24,-100 L-44,-60" fill="#ffffff" opacity={0.5} />
        <rect x={42} y={-74} width={4} height={28} rx={2} fill={u('metal')} stroke={OUT} strokeWidth={0.5} />
      </g>
      <rect x={-48} y={-4} width={8} height={4} fill="#9aa6b4" />
      <rect x={40} y={-4} width={8} height={4} fill="#9aa6b4" />
    </g>
  );
}

/** A microplate reader: low housing, display, and a tray that slides out to the right when `open`. */
export function Reader({ it, ms }: { it: Item; ms: number }) {
  const u = useDefs();
  return (
    <g>
      <Shadow w={130} d={6} />
      <g style={{ ...ease(ms), transform: it.open ? 'translateX(58px)' : 'translateX(0px)' }}>
        <rect x={10} y={-26} width={62} height={7} rx={1.5} fill="#cdd5de" stroke={OUT} strokeWidth={0.6} />
      </g>
      <path d="M-62,-4 L-62,-48 Q-62,-54 -56,-54 L50,-54 Q58,-54 60,-46 L64,-4 Z" fill={u('device')} stroke={OUT} strokeWidth={0.9} />
      <rect x={14} y={-31} width={50} height={14} rx={2} fill="#3a4656" />
      <rect x={-54} y={-46} width={44} height={16} rx={2} fill={u('screen')} />
      <text x={-32} y={-37.6} fontSize={7} fontWeight={700} fill="#8ff0c4" textAnchor="middle" dominantBaseline="middle" fontFamily="ui-monospace, monospace">
        {it.text ?? 'Ready'}
      </text>
      <rect x={-54} y={-20} width={60} height={2} fill="#ffffff" opacity={0.7} />
      <circle cx={-48} cy={-11} r={2.4} style={{ fill: it.open || it.text ? '#34c38f' : '#c3ccd6', ...ease(ms) }} />
    </g>
  );
}

/** A microcentrifuge: body, a clear lid showing the rotor (it spins while `open` is false and progress runs). */
export function Centrifuge({ it, ms }: { it: Item; ms: number }) {
  const u = useDefs();
  const spinning = (it.progress ?? 0) > 0 && (it.progress ?? 0) < 1;
  return (
    <g>
      <Shadow w={92} d={5} />
      <path d="M-44,-4 L-40,-34 Q-38,-40 -30,-40 L30,-40 Q38,-40 40,-34 L44,-4 Z" fill={u('device')} stroke={OUT} strokeWidth={0.9} />
      <ellipse cx={0} cy={-40} rx={34} ry={9} fill="#dfe8f1" fillOpacity={0.8} stroke={OUT} strokeWidth={0.8} />
      <g>
        <g transform="translate(0 -40) scale(1 0.26)">
          {/* Turned in the rotor's own plane, before it is flattened: it spins seen from the side. */}
          <g style={{ transformBox: 'fill-box', transformOrigin: 'center', animation: spinning ? 'bench-spin 0.4s linear infinite' : undefined }}>
            <circle r={26} fill="#b7c2ce" />
            {Array.from({ length: 12 }, (_, i) => (
              <circle key={i} cx={Math.cos((i * Math.PI) / 6) * 19} cy={Math.sin((i * Math.PI) / 6) * 19} r={3.2} fill="#eef2f6" stroke={OUT} strokeWidth={0.6} />
            ))}
          </g>
        </g>
      </g>
      <rect x={-20} y={-24} width={30} height={11} rx={1.8} fill={u('screen')} />
      <text x={-5} y={-18.4} fontSize={5.6} fontWeight={700} fill="#8ff0c4" textAnchor="middle" dominantBaseline="middle" fontFamily="ui-monospace, monospace">
        {it.text ?? ''}
      </text>
      <circle cx={24} cy={-18} r={3.4} style={{ fill: spinning ? '#34c38f' : '#c3ccd6', ...ease(ms) }} />
      <style>{'@keyframes bench-spin { to { transform: rotate(360deg); } }'}</style>
    </g>
  );
}

/** An upright microscope: base, arm, stage, objectives, eyepieces. */
export function Microscope() {
  const u = useDefs();
  return (
    <g>
      <Shadow w={74} d={5} />
      <path d="M-34,-4 L34,-4 L30,-14 L-30,-14 Z" fill="#3c4757" />
      <path d="M8,-14 C26,-30 28,-70 12,-96 L2,-92 C14,-70 12,-36 -2,-14 Z" fill="#46526a" stroke="#2f3a48" strokeWidth={0.8} />
      <rect x={-26} y={-44} width={36} height={4} rx={1} fill="#2f3a48" />
      <rect x={-12} y={-60} width={9} height={14} rx={2} fill={u('metal')} />
      <rect x={-21} y={-58} width={7} height={12} rx={2} fill={u('metal')} transform="rotate(-18 -17 -52)" />
      <rect x={-16} y={-72} width={20} height={12} rx={3} fill="#46526a" />
      <rect x={-14} y={-96} width={8} height={24} rx={2} fill="#2f3a48" transform="rotate(-24 -10 -84)" />
      <rect x={-6} y={-96} width={8} height={24} rx={2} fill="#2f3a48" transform="rotate(-24 -2 -84)" />
      <circle cx={0} cy={-26} r={6} fill="#c3ccd6" stroke="#2f3a48" strokeWidth={0.8} />
    </g>
  );
}

/** A timer: a dial filling round as `progress` runs, and what it times. */
export function Timer({ it, ms }: { it: Item; ms: number }) {
  const p = it.progress ?? 0;
  const c = 2 * Math.PI * 15;
  return (
    <g>
      <circle cx={0} cy={-20} r={19} fill="#ffffff" stroke={OUT} strokeWidth={0.9} />
      <circle cx={0} cy={-20} r={15} fill="none" stroke="#e5eaf0" strokeWidth={4} />
      <circle cx={0} cy={-20} r={15} fill="none" stroke="#2b7de9" strokeWidth={4} strokeLinecap="round" strokeDasharray={`${c * p} ${c}`} transform="rotate(-90 0 -20)" style={{ transition: `stroke-dasharray ${ms}ms linear` }} />
      <rect x={-2.5} y={-42.5} width={5} height={4} rx={1} fill={OUT} />
      {it.text && (
        <text x={0} y={-19.6} fontSize={6.4} fontWeight={700} fill={INK} textAnchor="middle" dominantBaseline="middle">
          {it.text}
        </text>
      )}
    </g>
  );
}

/** A thermometer showing a temperature. */
export function Thermometer({ it }: { it: Item }) {
  const t = Number.parseFloat(it.text ?? '20') || 20;
  const level = Math.max(0.12, Math.min(0.95, (t + 10) / 60));
  return (
    <g>
      <rect x={-3.6} y={-56} width={7.2} height={48} rx={3.6} fill="#ffffff" stroke={OUT} strokeWidth={0.8} />
      <rect x={-1.6} y={-12 - 42 * level} width={3.2} height={42 * level} fill="#e0564f" />
      <circle cx={0} cy={-6} r={6} fill="#e0564f" stroke={OUT} strokeWidth={0.8} />
      <text x={9} y={-34} fontSize={7} fontWeight={700} fill={INK} dominantBaseline="middle">
        {it.text}
      </text>
    </g>
  );
}

/** An arrow from the item's place to `to`, curving up, with a label on it. */
export function Arrow({ it }: { it: Item }) {
  const [x2, y2] = it.to ?? [it.x + 40, it.y];
  const dx = x2 - it.x, dy = y2 - it.y;
  const cx = dx / 2, cy = dy / 2 - Math.max(14, Math.abs(dx) * 0.25);
  const a = Math.atan2(dy - cy, dx - cx);
  const head = `${dx},${dy} ${dx - 6 * Math.cos(a - 0.45)},${dy - 6 * Math.sin(a - 0.45)} ${dx - 6 * Math.cos(a + 0.45)},${dy - 6 * Math.sin(a + 0.45)}`;
  return (
    <g>
      <path d={`M0,0 Q${cx},${cy} ${dx},${dy}`} fill="none" stroke="#4a5b74" strokeWidth={1.6} strokeLinecap="round" />
      <polygon points={head} fill="#4a5b74" />
      {it.label && (
        <g>
          <rect x={cx / 1 - it.label.length * 2.2 - 4} y={cy / 2 + dy / 4 - 7} width={it.label.length * 4.4 + 8} height={12} rx={6} fill="#ffffff" stroke="#c9d2dc" strokeWidth={0.6} />
          <text x={cx} y={cy / 2 + dy / 4 - 0.8} fontSize={6.5} fontWeight={700} fill={INK} textAnchor="middle" dominantBaseline="middle">
            {it.label}
          </text>
        </g>
      )}
    </g>
  );
}

/** A standard curve: axes, the points, and a smooth curve through them. */
export function Chart({ it, ms }: { it: Item; ms: number }) {
  const pts = it.points ?? [];
  const W = 150, H = 100;
  const px = (x: number) => -W / 2 + 12 + x * (W - 20);
  const py = (y: number) => -14 - y * (H - 24);
  const curve = pts.length > 1 ? pts.map(([x, y], i) => `${i ? 'L' : 'M'}${px(x)},${py(y)}`).join(' ') : '';
  return (
    <g>
      <rect x={-W / 2} y={-H} width={W} height={H} rx={8} fill="#ffffff" stroke="#d3dae3" strokeWidth={0.8} />
      <line x1={px(0)} y1={py(0)} x2={px(1)} y2={py(0)} stroke={OUT} strokeWidth={0.8} />
      <line x1={px(0)} y1={py(0)} x2={px(0)} y2={py(1)} stroke={OUT} strokeWidth={0.8} />
      <text x={0} y={-5} fontSize={5.4} fill={SOFT} textAnchor="middle">
        {it.label ?? 'Concentration'}
      </text>
      <text x={px(0) - 6} y={py(0.5)} fontSize={5.4} fill={SOFT} textAnchor="middle" transform={`rotate(-90 ${px(0) - 6} ${py(0.5)})`}>
        {it.text ?? 'Absorbance'}
      </text>
      <path d={curve} fill="none" stroke="#7b3fbf" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" pathLength={1} strokeDasharray="1 1" style={{ strokeDashoffset: it.progress === undefined || it.progress >= 1 ? 0 : 1, transition: `stroke-dashoffset ${ms}ms ease` }} />
      {pts.map(([x, y], i) => (
        <circle key={i} cx={px(x)} cy={py(y)} r={2.4} fill="#2b7de9" stroke="#ffffff" strokeWidth={0.8} />
      ))}
    </g>
  );
}
