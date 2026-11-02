import { createContext, useContext, type CSSProperties, type ReactNode } from 'react';
import type { Item } from '../../../shared/bench.ts';
import { ART, FLASK_MEDIUM_MASK, RACK_FRONT, at, plateFrame, wellAt, type Art } from '../../../shared/benchArt.ts';
import { useCutout } from './cutout.ts';

/**
 * Real lab items as pictures: drawn by Muse Image in one scientific-illustration style (BioRender-like) and kept in
 * public/bench (shared/benchArt.ts says where each stands and where its inside is), with what the scene says drawn
 * on them: how full and with what (the liquid multiplied over the picture, so its outlines and shine stay), a bottle's
 * cap colour and printed label, what a display says, which wells hold what. Each stands on its foot at (0, 0), y up
 * being negative. Changes ease (CSS transitions), so a scene's timeline (BenchView.tsx) plays as motion. The timer,
 * thermometer, arrows and chart are drawn, not pictured.
 */

export { wellAt };

const OUT = '#6f7e90';
const INK = '#2f3a48';
const SOFT = '#8a97a7';
const EMPTY = '#eef3f8';
const MEDIUM = '#f2a7b5';
const CELL = '#c0708a';

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
const multiply: CSSProperties = { mixBlendMode: 'multiply' };

/** A soft shadow on the bench under an item. */
function Shadow({ w, d = 4 }: { w: number; d?: number }) {
  const u = useDefs();
  return <ellipse cx={0} cy={1} rx={w / 2} ry={d} fill={u('shadow')} />;
}

/** A picture standing on its foot: its own box, or sized `w` × `h` (a rack as wide as its tubes). */
function Picture({ art, w = art.w, h = art.h }: { art: Art; w?: number; h?: number }) {
  return <image href={art.src} x={-art.cx * w} y={-art.foot * h} width={w} height={h} preserveAspectRatio="none" />;
}

/** Liquid in a vessel: a column round `x` from `bottom` up to `level` of the way to `top`, with a lighter surface, within `clip`. */
function Liquid({ clip, x = 0, top, bottom = 0, width, level, colour, ms }: { clip: string; x?: number; top: number; bottom?: number; width: number; level: number; colour: string; ms: number }) {
  const u = useDefs();
  const h = bottom - top;
  return (
    <g clipPath={`url(#${clip})`}>
      <g style={{ ...ease(ms), transform: `scaleY(${Math.max(0.0001, level)})`, transformBox: 'fill-box', transformOrigin: '50% 100%' }}>
        <rect x={x - width / 2} y={top} width={width} height={h} style={{ fill: colour, ...ease(ms) }} />
        <rect x={x - width / 2} y={top} width={width} height={h} fill={u('liquid')} />
      </g>
      <g style={{ ...ease(ms), transform: `translateY(${-h * level}px)`, opacity: level > 0.02 ? 1 : 0 }}>
        <ellipse cx={x} cy={bottom} rx={width / 2} ry={1.4} style={{ fill: colour, ...ease(ms) }} />
        <ellipse cx={x} cy={bottom} rx={width / 2} ry={1.4} fill="#ffffff" opacity={0.45} />
      </g>
    </g>
  );
}

/** The liquid in a pictured vessel: inside the picture's own outline, multiplied over it so the picture shows through. */
function Fill({ art, clip, level, colour, ms }: { art: Art; clip: string; level: number; colour: string; ms: number }) {
  const pts = (art.liquid ?? []).map(([fx, fy]) => at(art, fx, fy));
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const left = Math.min(...xs), right = Math.max(...xs), top = Math.min(...ys), bottom = Math.max(...ys);
  return (
    <g>
      <clipPath id={clip}>
        <polygon points={pts.map(p => `${p[0]},${p[1]}`).join(' ')} />
      </clipPath>
      <g style={multiply}>
        <Liquid clip={clip} x={(left + right) / 2} top={top} bottom={bottom} width={right - left} level={level} colour={colour} ms={ms} />
      </g>
    </g>
  );
}

/** A small screen on an instrument, saying `text`, turned with the face it is on. */
function Display({ x, y, w, h, text, size = 5.2, angle = 0 }: { x: number; y: number; w: number; h: number; text: string; size?: number; angle?: number }) {
  const u = useDefs();
  return (
    <g transform={`rotate(${angle} ${x + w / 2} ${y + h / 2})`}>
      <rect x={x} y={y} width={w} height={h} rx={1.4} fill={u('screen')} />
      <text x={x + w / 2} y={y + h / 2 + 0.3} fontSize={size} fontWeight={700} fill="#8ff0c4" textAnchor="middle" dominantBaseline="middle" fontFamily="ui-monospace, monospace">
        {text}
      </text>
    </g>
  );
}

/** Big words on the pictures while the protocol plays (BenchView's `big`): the amounts read from arm's length. */
export const BigText = createContext(false);
const useBig = () => useContext(BigText);

/** A label in a white pill centred on (x, y): the amount on an arrow, the volume by the pipette, the temperature over the incubator. */
function Pill({ x, y, text }: { x: number; y: number; text: string }) {
  const big = useBig();
  const size = big ? 15 : 6.5, h = big ? 24 : 12, w = text.length * size * 0.66 + (big ? 16 : 8);
  return (
    <g>
      <rect x={x - w / 2} y={y - h / 2} width={w} height={h} rx={h / 2} fill="#ffffff" stroke="#c9d2dc" strokeWidth={big ? 0.9 : 0.6} />
      <text x={x} y={y + size * 0.06} fontSize={size} fontWeight={700} fill={INK} textAnchor="middle" dominantBaseline="middle">
        {text}
      </text>
    </g>
  );
}

/**
 * A big pill at an item's own point (x, y), the item's scale and turn undone so it reads like every other; nothing when
 * the words are small. Undone as fast as the item changes (`ms`), so the pill keeps its size while the item shrinks.
 */
function Callout({ it, x, y, text, ms = 0 }: { it: Item; x: number; y: number; text: string; ms?: number }) {
  const big = useBig();
  if (!big) return null;
  return (
    <g style={{ transform: `translate(${x}px, ${y}px) rotate(${-(it.rotate ?? 0)}deg) scale(${1 / (it.scale ?? 1)})`, transition: `transform ${ms}ms cubic-bezier(.4,.1,.2,1)` }}>
      <Pill x={0} y={0} text={text} />
    </g>
  );
}

// ---------------------------------------------------------------------------------------------------------------

/** A 1.5 mL microcentrifuge tube: clear, with its snap cap. */
export function Tube({ it, ms, clip }: { it: Item; ms: number; clip: string }) {
  return (
    <g>
      <Shadow w={18} d={2.6} />
      <Picture art={ART.tube} />
      <Fill art={ART.tube} clip={clip} level={it.level ?? 0} colour={it.liquid ?? EMPTY} ms={ms} />
    </g>
  );
}

/** A 15 mL conical tube, with a label strip along its side when it has a name, and (big) what to do with it over it. */
export function Conical({ it, ms, clip }: { it: Item; ms: number; clip: string }) {
  const art = ART.conical;
  const big = useBig();
  const [x0] = at(art, 0.2, 0.5);
  const [x1, mid] = at(art, 0.8, 0.5);
  const size = big ? 8.5 : 6.5;
  const long = Math.min(86, Math.max(30, (it.label?.length ?? 0) * size * 0.6 + 8));
  return (
    <g>
      <Shadow w={26} d={3} />
      <Picture art={art} />
      <Fill art={art} clip={clip} level={it.level ?? 0} colour={it.liquid ?? EMPTY} ms={ms} />
      {it.label && (
        <g>
          <rect x={x0} y={mid - long / 2} width={x1 - x0} height={long} rx={1.5} fill="#ffffff" opacity={0.92} stroke="#d4dbe3" strokeWidth={0.5} />
          <text x={(x0 + x1) / 2} y={mid} fontSize={size} fontWeight={700} fill={INK} textAnchor="middle" dominantBaseline="middle" transform={`rotate(-90 ${(x0 + x1) / 2} ${mid})`}>
            {it.label}
          </text>
        </g>
      )}
      {it.text && <Callout it={it} x={-53} y={-175} text={it.text} />}
    </g>
  );
}

/** A reagent bottle: its cap in the bottle's colour, and a printed label with the reagent's name. */
export function Bottle({ it, ms, clip }: { it: Item; ms: number; clip: string }) {
  const art = ART.bottle;
  const words = (it.label ?? '').split(/\s+/);
  const lines = words.length > 1 && (it.label ?? '').length > 10 ? [words.slice(0, Math.ceil(words.length / 2)).join(' '), words.slice(Math.ceil(words.length / 2)).join(' ')] : [it.label ?? ''];
  const [cx0, cy0] = at(art, 0.15, 0.03);
  const [cx1, cy1] = at(art, 0.86, 0.2);
  const [lx0, ly0] = at(art, 0.125, 0.515);
  const [lx1, ly1] = at(art, 0.875, 0.79);
  const lw = lx1 - lx0, lh = ly1 - ly0;
  return (
    <g>
      <Shadow w={44} d={4} />
      <Picture art={art} />
      <Fill art={art} clip={clip} level={it.level ?? 0} colour={it.liquid ?? EMPTY} ms={ms} />
      <rect x={cx0} y={cy0} width={cx1 - cx0} height={cy1 - cy0} rx={2.2} opacity={0.85} style={{ fill: it.cap ?? '#2b7de9', ...multiply, ...ease(ms) }} />
      {it.label && (
        <g>
          <rect x={lx0} y={ly0} width={lw} height={lh} rx={2} fill="#ffffff" stroke="#d0d7e0" strokeWidth={0.6} />
          <rect x={lx0} y={ly0} width={lw} height={4} rx={1} style={{ fill: it.cap ?? '#2b7de9', ...ease(ms) }} />
          {lines.map((line, i) => (
            // A long word is squeezed to the label's width rather than cut.
            <text key={i} x={lx0 + lw / 2} y={ly0 + 11.5 + i * 7.5 - (lines.length - 1) * 3.2} fontSize={line.length > 11 ? 5 : 6} fontWeight={700} fill={INK} textAnchor="middle" dominantBaseline="middle" {...(line.length * (line.length > 11 ? 5 : 6) * 0.62 > lw - 4 ? { textLength: lw - 4, lengthAdjust: 'spacingAndGlyphs' } : {})}>
              {line}
            </text>
          ))}
          <line x1={lx0 + 5} x2={lx1 - 5} y1={ly1 - 4} y2={ly1 - 4} stroke="#c9d1db" strokeWidth={0.8} />
        </g>
      )}
    </g>
  );
}

/**
 * The user's own bottle, from their photo of the kit, standing where the drawn bottle would: cut out of its
 * background (cutout.ts), as tall as the drawn bottle (so the arrows and the pipette meet it where they would) and no
 * wider than its place on the bench, its foot melting into its shadow. Only a cut-out that came out whole stands
 * there; when it did not (the kit screen asks for a better photo), the drawn bottle does. Until it is ready the drawn
 * bottle breathes lighter and back (after a moment, so a cut kept from before does not flicker), and the photo fades
 * in, again when Muse Image's whole bottle replaces it.
 */
export function PhotoBottle({ it, ms, clip, photo }: { it: Item; ms: number; clip: string; photo: string }) {
  const cut = useCutout(photo);
  if (!cut)
    return (
      <g className="chapp-anim" style={{ animation: 'chapp-waiting 1.6s ease-in-out 0.4s infinite' }}>
        <Bottle it={it} ms={ms} clip={clip} />
      </g>
    );
  if (!cut.ok) return <Bottle it={it} ms={ms} clip={clip} />;
  const aspect = cut.width / cut.height;
  const width = Math.min(52, 89 * aspect);
  const height = width / aspect;
  return (
    <g key={cut.src} className="chapp-anim" style={{ animation: 'chapp-fade-in 0.5s ease-out both' }}>
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

/** A single-channel micropipette, tip down at (0, 0): its volume in the window, what it holds in the tip, and (big) its volume beside it. */
export function Pipette({ it }: { it: Item }) {
  const art = ART.pipette;
  const [wx0, wy0] = at(art, 0.5, 0.175);
  const [wx1, wy1] = at(art, 0.85, 0.2375);
  return (
    <g>
      {it.label && <Callout it={it} x={66} y={-96} text={it.label} />}
      <Picture art={art} />
      {it.liquid && <polygon points="0,0 -2.4,-9 2.4,-9" style={{ fill: it.liquid, ...multiply }} />}
      <text x={(wx0 + wx1) / 2} y={(wy0 + wy1) / 2 + 0.3} fontSize={4.4} fontWeight={700} fill={INK} textAnchor="middle" dominantBaseline="middle" fontFamily="ui-monospace, monospace">
        {it.text ?? '200'}
      </text>
    </g>
  );
}

/** A 96-well plate, seen from the front left: its wells drawn on the picture's face, rows A–H and columns 1–12 marked. */
const darker = (hex: string) => `#${[0, 1, 2].map(i => Math.round(parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) * 0.72).toString(16).padStart(2, '0')).join('')}`;

export function Plate({ it, ms }: { it: Item; ms: number }) {
  const u = useDefs();
  const wells = it.wells ?? {};
  const { cover } = plateFrame();
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
      <Shadow w={180} d={6} />
      <Picture art={ART.plate} />
      <polygon points={cover.map(p => `${p[0]},${p[1]}`).join(' ')} fill="#f7f9fb" />
      {cells}
      {Array.from({ length: 12 }, (_, c) => {
        const { x, y } = wellAt(-1.15, c);
        return (
          <text key={c} x={x} y={y} fontSize={3.4} fill={SOFT} textAnchor="middle" dominantBaseline="middle">
            {c + 1}
          </text>
        );
      })}
      {Array.from({ length: 8 }, (_, r) => {
        const { x, y } = wellAt(r, -1.05);
        return (
          <text key={r} x={x} y={y} fontSize={3.6} fill={SOFT} textAnchor="middle" dominantBaseline="middle">
            {String.fromCharCode(65 + r)}
          </text>
        );
      })}
      {it.label && <Callout it={it} x={55} y={-114} text={it.label} ms={ms} />}
    </g>
  );
}

/** A tube rack, as wide as the scene says: the whole of it behind the tubes and, drawn after them, its front face. */
export function Rack({ it, front }: { it: Item; front?: boolean }) {
  const art = ART.rack;
  const w = it.width ?? 180, h = (w * art.h) / art.w;
  if (front)
    return (
      <svg x={-w / 2} y={(RACK_FRONT - art.foot) * h} width={w} height={(1 - RACK_FRONT) * h} viewBox={`0 ${RACK_FRONT * art.h} ${art.w} ${(1 - RACK_FRONT) * art.h}`} preserveAspectRatio="none">
        <image href={art.src} width={art.w} height={art.h} preserveAspectRatio="none" />
      </svg>
    );
  return (
    <g>
      <Shadow w={w + 8} d={5} />
      <Picture art={art} w={w} h={h} />
    </g>
  );
}

/** A reagent reservoir (trough) seen from the front and above, with what it holds. */
export function Reservoir({ it, ms }: { it: Item; ms: number }) {
  const art = ART.reservoir;
  const level = it.level ?? 0;
  const pts = (art.liquid ?? []).map(([fx, fy]) => at(art, fx, fy));
  return (
    <g>
      <Shadow w={78} d={4} />
      <Picture art={art} />
      <polygon points={pts.map(p => `${p[0]},${p[1]}`).join(' ')} style={{ fill: it.liquid ?? EMPTY, opacity: level > 0.02 ? 0.9 : 0, transform: `translateY(${(1 - level) * 0.16 * art.h}px)`, ...multiply, ...ease(ms) }} />
    </g>
  );
}

/** A culture dish with its lid on: medium, and the cells on its floor. */
export function Dish({ it, ms }: { it: Item; ms: number }) {
  const art = ART.dish;
  const [cx, cy] = at(art, 0.5, 0.62);
  const rx = 0.42 * art.w, ry = 0.14 * art.h;
  const n = Number(it.text ?? 26);
  return (
    <g>
      <Shadow w={112} d={6} />
      <Picture art={art} />
      <ellipse cx={cx} cy={cy} rx={rx} ry={ry} opacity={0.8} style={{ fill: it.liquid ?? MEDIUM, ...multiply, ...ease(ms) }} />
      {Array.from({ length: n }, (_, i) => {
        const a = i * 2.39996, r = Math.sqrt((i + 0.5) / n);
        const x = cx + Math.cos(a) * r * rx * 0.88, y = cy + Math.sin(a) * r * ry * 0.82;
        return <ellipse key={i} cx={x} cy={y} rx={2.4} ry={1.4} transform={`rotate(${(i * 47) % 180} ${x} ${y})`} fill={CELL} opacity={0.7} style={multiply} />;
      })}
    </g>
  );
}

/** A culture flask lying down: medium along its floor (the picture's own, in whatever colour the scene says), cells on it. */
export function Flask({ it, ms, clip }: { it: Item; ms: number; clip: string }) {
  const art = ART.flask;
  const x = -art.cx * art.w, y = -art.foot * art.h;
  const level = it.level ?? 0.28;
  return (
    <g>
      <Shadow w={84} d={4} />
      <Picture art={art} />
      <mask id={`${clip}-medium`} maskUnits="userSpaceOnUse" x={x} y={y} width={art.w} height={art.h}>
        <image href={FLASK_MEDIUM_MASK} x={x} y={y} width={art.w} height={art.h} preserveAspectRatio="none" />
      </mask>
      <g mask={`url(#${clip}-medium)`} style={multiply}>
        <rect x={x} y={y} width={art.w} height={art.h} style={{ fill: it.liquid ?? MEDIUM, opacity: level > 0.02 ? 0.85 : 0, ...ease(ms) }} />
        {Array.from({ length: 14 }, (_, i) => {
          const [fx, fy] = at(art, 0.08 + i * 0.041, 0.76 + i * 0.006 + ((i * 7) % 3) * 0.02);
          return <ellipse key={i} cx={fx} cy={fy} rx={1.6} ry={0.9} fill={CELL} opacity={0.8} />;
        })}
      </g>
    </g>
  );
}

/** A glass beaker (waste, or what is poured). */
export function Beaker({ it, ms, clip }: { it: Item; ms: number; clip: string }) {
  return (
    <g>
      <Shadow w={48} d={4} />
      <Picture art={ART.beaker} />
      <Fill art={ART.beaker} clip={clip} level={it.level ?? 0} colour={it.liquid ?? EMPTY} ms={ms} />
    </g>
  );
}

/** A squeeze wash bottle with its bent nozzle. */
export function WashBottle({ it, ms, clip }: { it: Item; ms: number; clip: string }) {
  return (
    <g>
      <Shadow w={38} d={3} />
      <Picture art={ART.washbottle} />
      <Fill art={ART.washbottle} clip={clip} level={it.level ?? 0.7} colour={it.liquid ?? EMPTY} ms={ms} />
    </g>
  );
}

/** A CO₂ incubator: a white cabinet with its control panel across the top, where its display says the temperature. */
export function Incubator({ it, ms }: { it: Item; ms: number }) {
  // Its temperature on the display and, big, over it.
  const art = ART.incubator;
  const [x0, y0] = at(art, 0.4, 0.09);
  const [x1, y1] = at(art, 0.7, 0.15);
  const [dx, dy] = at(art, 0.755, 0.12);
  return (
    <g>
      <Shadow w={96} d={6} />
      <Picture art={art} />
      <Display x={x0} y={y0} w={x1 - x0} h={y1 - y0} text={it.text ?? '37.0 °C'} angle={-2} />
      <circle cx={dx} cy={dy} r={1.5} style={{ fill: it.text ? '#34c38f' : '#c3ccd6', ...ease(ms) }} />
      {it.label && <Callout it={it} x={0} y={-art.h - 16} text={it.label} />}
    </g>
  );
}

/** A microplate reader, its tray out at the front, a display on its face, and (big) what it reads at, over it. */
export function Reader({ it, ms }: { it: Item; ms: number }) {
  const art = ART.reader;
  const [x0, y0] = at(art, 0.745, 0.56);
  const [x1, y1] = at(art, 0.965, 0.66);
  return (
    <g>
      <Shadow w={130} d={6} />
      <Picture art={art} />
      <Display x={x0} y={y0} w={x1 - x0} h={y1 - y0} text={it.text ?? 'Ready'} size={4.6} angle={6} />
      <circle cx={x0 + 3} cy={y1 + 4} r={1.6} style={{ fill: it.open || it.text ? '#34c38f' : '#c3ccd6', ...ease(ms) }} />
      {it.label && <Callout it={it} x={0} y={-art.h - 16} text={it.label} />}
    </g>
  );
}

/** A microcentrifuge with its lid closed: its display, and a light while it runs. */
export function Centrifuge({ it, ms }: { it: Item; ms: number }) {
  const art = ART.centrifuge;
  const spinning = (it.progress ?? 0) > 0 && (it.progress ?? 0) < 1;
  const [x0, y0] = at(art, 0.23, 0.465);
  const [x1, y1] = at(art, 0.43, 0.545);
  const [bx, by] = at(art, 0.21, 0.65);
  return (
    <g>
      <Shadow w={92} d={5} />
      <Picture art={art} />
      <Display x={x0} y={y0} w={x1 - x0} h={y1 - y0} text={it.text ?? ''} size={5} angle={15} />
      <circle cx={bx} cy={by} r={3} style={{ fill: spinning ? '#34c38f' : 'transparent', ...multiply, ...ease(ms) }} />
    </g>
  );
}

/** An inverted cell culture microscope. */
export function Microscope() {
  return (
    <g>
      <Shadow w={80} d={5} />
      <Picture art={ART.microscope} />
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

/** A thermometer showing a temperature, and (big) what to do about it ("Cool to RT"). */
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
      {it.label && <Callout it={it} x={44} y={-76} text={it.label} />}
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
      {it.label && <Pill x={cx} y={cy / 2 + dy / 4 - 1} text={it.label} />}
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
