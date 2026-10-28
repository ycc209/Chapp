import type { Box } from '../../../shared/ai.ts';
import { SAMPLE, sampleLayout, squareOn, type SampleShape } from '../../../shared/kit.ts';
import type { Component } from '../../../shared/protocol.ts';
import { cropFrom, type Shot } from './photo.ts';
import { splitName } from '../protocol/content.ts';

/**
 * Drawn stand-ins for photos of a kit, for reviewing the kit screens by address (/kit?state=kit) without a camera.
 * Each is plainly a drawing and carries "SAMPLE PHOTO" across it; the screens that show them also say so. They are
 * never written to the run: a review must not leave a fake bottle where the user's own photo belongs. Where each
 * bottle stands is shared/kit.ts's sampleLayout, which the mock provider's bottles follow too.
 */

const W = SAMPLE.width;
const H = SAMPLE.height;
const BASE = SAMPLE.base;

/** A bottle on a sample photo: the box around it (cap to base) and the square picture of it. */
export type SamplePick = { shot: string; box: Box; crop: string };
type Sample = { shots: Shot[]; picks: Record<string, SamplePick> };

let cached: { key: string; sample: Sample } | null = null;

/** The sample photos for these bottles (two to a photo, then one each, like the storyboard's three photos). */
export function samplePhotos(bottles: Pick<Component, 'id' | 'name' | 'role'>[]): Sample {
  const key = bottles.map(b => `${b.id}:${b.name}`).join('|');
  if (cached?.key === key) return cached.sample;
  const shots: Shot[] = [];
  const picks: Record<string, SamplePick> = {};
  sampleLayout(bottles.map(b => b.role)).forEach((group, i) => {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const g = canvas.getContext('2d')!;
    drawBench(g);
    for (const b of group) drawBottle(g, b.cx, b.shape, splitName(bottles[b.index].name).name);
    drawCaption(g);
    const id = `sample-${i + 1}`;
    shots.push({ id, src: canvas.toDataURL('image/jpeg', 0.82), width: W, height: H });
    for (const b of group) picks[bottles[b.index].id] = { shot: id, box: b.box, crop: cropFrom(canvas, W, H, squareOn(b.box, W, H)) };
  });
  cached = { key, sample: { shots, picks } };
  return cached.sample;
}

function drawBench(g: CanvasRenderingContext2D) {
  const wall = g.createLinearGradient(0, 0, 0, 0.46 * H);
  wall.addColorStop(0, '#eceae4');
  wall.addColorStop(1, '#dedad1');
  g.fillStyle = wall;
  g.fillRect(0, 0, W, 0.46 * H);
  const bench = g.createLinearGradient(0, 0.46 * H, 0, H);
  bench.addColorStop(0, '#cfc8ba');
  bench.addColorStop(1, '#b7ae9e');
  g.fillStyle = bench;
  g.fillRect(0, 0.46 * H, W, H);
}

/** One bottle standing on the bench; returns the y of its label's middle, where a person would tap. */
function drawBottle(g: CanvasRenderingContext2D, cx: number, s: SampleShape, name: string): number {
  const top = BASE - s.h;
  g.fillStyle = 'rgba(40, 32, 20, 0.18)';
  g.beginPath();
  g.ellipse(cx, BASE + 4, s.w * 0.62, 18, 0, 0, Math.PI * 2);
  g.fill();

  const body = g.createLinearGradient(cx - s.w / 2, 0, cx + s.w / 2, 0);
  body.addColorStop(0, shade(s.body, -28));
  body.addColorStop(0.35, s.body);
  body.addColorStop(0.7, shade(s.body, -6));
  body.addColorStop(1, shade(s.body, -36));
  g.fillStyle = body;
  round(g, cx - s.w / 2, top, s.w, s.h, Math.min(28, s.w / 5));
  g.fill();

  const [nw, nh] = s.neck;
  g.fillStyle = shade(s.body, -14);
  g.fillRect(cx - nw / 2, top - nh, nw, nh + 6);
  const [cw, ch] = s.cap;
  g.fillStyle = s.capColor;
  round(g, cx - cw / 2, top - nh - ch, cw, ch, 8);
  g.fill();
  g.fillStyle = 'rgba(255, 255, 255, 0.18)';
  g.fillRect(cx - cw / 2 + 8, top - nh - ch + 6, 10, ch - 12);

  // The label: white, the bottle's name in bold, as large as fits.
  const lw = s.w - 22;
  const lh = Math.min(s.h * 0.56, 190);
  const ly = top + (s.h - lh) / 2 + 10;
  g.fillStyle = '#ffffff';
  round(g, cx - lw / 2, ly, lw, lh, 6);
  g.fill();
  g.fillStyle = '#2f5fae';
  g.fillRect(cx - lw / 2, ly + 10, lw, 8);
  let size = 30;
  let lines: string[] = [];
  for (; size >= 14; size -= 2) {
    g.font = `700 ${size}px -apple-system, "Helvetica Neue", Arial, sans-serif`;
    lines = wrap(g, name, lw - 16);
    if (lines.length * size * 1.15 <= lh - 36 && lines.every(l => g.measureText(l).width <= lw - 16)) break;
  }
  g.fillStyle = '#1b1b1d';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const mid = ly + 18 + (lh - 18) / 2;
  lines.forEach((line, i) => g.fillText(line, cx, mid + (i - (lines.length - 1) / 2) * size * 1.15));
  return mid;
}

function drawCaption(g: CanvasRenderingContext2D) {
  const text = 'SAMPLE PHOTO · drawn for review';
  g.font = '700 24px -apple-system, "Helvetica Neue", Arial, sans-serif';
  const w = g.measureText(text).width + 32;
  g.fillStyle = 'rgba(17, 17, 19, 0.78)';
  round(g, 24, H - 76, w, 48, 24);
  g.fill();
  g.fillStyle = '#ffffff';
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  g.fillText(text, 40, H - 52);
}

function wrap(g: CanvasRenderingContext2D, text: string, width: number): string[] {
  const lines: string[] = [];
  for (const word of text.split(/\s+/)) {
    const last = lines[lines.length - 1];
    if (last !== undefined && g.measureText(`${last} ${word}`).width <= width) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  return lines;
}

function round(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}

function shade(hex: string, amount: number) {
  const n = parseInt(hex.slice(1), 16);
  const c = (v: number) => Math.max(0, Math.min(255, v + amount));
  return `rgb(${c(n >> 16)}, ${c((n >> 8) & 255)}, ${c(n & 255)})`;
}
