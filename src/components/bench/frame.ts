import type { BenchScene, Item, Look } from '../../../shared/bench.ts';
import { ART } from '../../../shared/benchArt.ts';

/**
 * The square of the bench a scene is drawn in: round what it draws rather than the whole 240 × 240, so a scene that
 * stands low on the bench (bottles and tubes, the top of the bench empty) fills its picture. `still`: round the step
 * as it ends (what a card shows); otherwise round every place its items go while it plays, so nothing moves out of the
 * picture. Words the drawing puts beside an item (BenchView's `big` pills, a card's volume pill) count too.
 */

type Box = [number, number, number, number];

/** Never closer than this much of the bench across (so one small item is not blown up), and a margin round it all. */
const NEAREST = 140;
const MARGIN = 8;

/** A pill's box round (x, y), in the units it is drawn in (Items.tsx's Pill). */
function pill(x: number, y: number, text: string, big: boolean, thumb: boolean): Box {
  const size = big ? 15 : thumb ? 11 : 6.5, h = big ? 24 : thumb ? 18 : 12, w = text.length * size * 0.66 + (big ? 16 : thumb ? 12 : 8);
  return [x - w / 2, y - h / 2, x + w / 2, y + h / 2];
}

/** A callout at the item's own (x, y), drawn the bench's size whatever the item's (Items.tsx's Callout). */
function callout(it: Look, x: number, y: number, text: string, big: boolean, thumb: boolean): Box | null {
  if (!big && !thumb) return null;
  const s = it.scale ?? 1;
  const [l, t, r, b] = pill(0, 0, text, big, thumb);
  return [x + l / s, y + t / s, x + r / s, y + b / s];
}

/** What an item draws, round its own foot at (0, 0), before its place, turn and size. */
function extent(it: Item, big: boolean, thumb: boolean): Box[] {
  switch (it.kind) {
    case 'timer':
      return [[-19, -43, 19, 0]];
    case 'thermometer':
      return [[-7, -56, 9 + (it.text?.length ?? 2) * 4.4, 0] as Box, ...(it.label ? [callout(it, 44, -76, it.label, big, thumb)] : [])].filter(b => b !== null);
    case 'chart':
      return [[-75, -100, 75, 0]];
    case 'arrow': {
      // Its curve (Items.tsx's Arrow: up through a control point) at its highest, and its pill on it.
      const [x2, y2] = it.to ?? [it.x + 40, it.y];
      const dx = x2 - it.x, dy = y2 - it.y;
      const cx = dx / 2, cy = dy / 2 - Math.max(14, Math.abs(dx) * 0.25);
      const k = cy / (2 * cy - dy);
      const top = k > 0 && k < 1 ? 2 * k * (1 - k) * cy + k * k * dy : Math.min(0, dy);
      const line: Box = [Math.min(0, dx), Math.min(0, dy, top), Math.max(0, dx), Math.max(0, dy)];
      return it.label ? [line, pill(cx, cy / 2 + dy / 4 - 1, it.label, big, thumb)] : [line];
    }
  }
  const art = ART[it.kind];
  const boxes: Box[] = [[-art.cx * art.w, -art.foot * art.h, (1 - art.cx) * art.w, (1 - art.foot) * art.h + 3]];
  // Open, its cap stands at its right.
  if (it.open && 'cap' in art) boxes.push([0, -art.h * 0.2, art.w * art.cap.at + (art.cap.box[2] - art.cap.box[0]) * art.w * 0.5, 4]);
  if (it.kind === 'tube' && it.label && !thumb) boxes.push([-5, 0, 5, 15]);
  const said = (x: number, y: number, text?: string) => (text ? callout(it, x, y, text, big, thumb) : null);
  const words = [
    it.kind === 'pipette' ? said(66, -96, it.label) : null,
    it.kind === 'conical' ? said(-53, -175, it.text) : null,
    it.kind === 'plate' ? said(55, -114, it.label) : null,
    it.kind === 'incubator' || it.kind === 'reader' ? said(0, -art.h - 16, it.label) : null,
  ];
  return [...boxes, ...words.filter(b => b !== null)];
}

/** A box turned and sized as the item is, and put in its place on the bench. */
function placed([l, t, r, b]: Box, it: Look): Box {
  const s = it.scale ?? 1, a = ((it.rotate ?? 0) * Math.PI) / 180;
  const pts = [[l, t], [r, t], [r, b], [l, b]].map(([x, y]) => [it.x + s * (x! * Math.cos(a) - y! * Math.sin(a)), it.y + s * (x! * Math.sin(a) + y! * Math.cos(a))]);
  const xs = pts.map(p => p[0]!), ys = pts.map(p => p[1]!);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

const merge = (it: Item, set: Partial<Look>): Item => ({ ...it, ...set, ...(set.wells ? { wells: { ...it.wells, ...set.wells } } : {}) });

/** The scene's square as an SVG viewBox ("x y size size"). */
export function frameOf(scene: BenchScene, { still, big = false }: { still: boolean; big?: boolean }): string {
  const looks = new Map(scene.items.map(it => [it.id, it]));
  const seen: Item[] = still ? [] : [...looks.values()];
  for (const a of [...scene.actions].sort((x, y) => x.at - y.at)) {
    const now = looks.get(a.id);
    if (!now || !a.set) continue;
    const next = merge(now, a.set);
    looks.set(a.id, next);
    if (!still) seen.push(next);
  }
  if (still) seen.push(...looks.values());
  const boxes = seen.filter(it => !it.hidden).flatMap(it => extent(it, big, still).map(b => placed(b, it)));
  if (!still) for (const a of scene.actions) if (a.drop) boxes.push([a.drop.x - 3, a.drop.y1 - 4, a.drop.x + 3, a.drop.y2 + 3]);
  if (!boxes.length) return '0 0 240 240';
  const l = Math.min(...boxes.map(b => b[0])) - MARGIN, t = Math.min(...boxes.map(b => b[1])) - MARGIN;
  const r = Math.max(...boxes.map(b => b[2])) + MARGIN, b = Math.max(...boxes.map(b => b[3])) + MARGIN;
  const size = Math.max(NEAREST, r - l, b - t);
  const round = (n: number) => Math.round(n * 10) / 10;
  return [round((l + r - size) / 2), round((t + b - size) / 2), round(size), round(size)].join(' ');
}
