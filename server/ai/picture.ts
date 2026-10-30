import type { StepFacts } from '../../shared/stepFacts.ts';

/**
 * A step card's picture, written by Muse Spark as SVG from the step's facts (shared/stepFacts.ts): what it handles,
 * its counts and labels, the colours the protocol gives, and nothing else to invent from, with how to lay the scene
 * out for that kind of step (layoutFor). What comes back is kept only if it is plain, well-formed drawing (cleanSvg):
 * no script, style sheet, link, image or reference outside itself, so it is safe to serve and to show. Each picture
 * is made once per protocol step and kept (server/pictures.ts).
 *
 * On 2026-10-30, BCA's four steps at low effort and without a layout came back muddled (the standards as circles in a
 * box, labels over shapes) and one was not well-formed XML (an attribute given twice), hence both.
 */

export const DRAW_INSTRUCTIONS = `You draw the small picture on one step card of a lab app, as SVG.
Answer with one <svg> element only: viewBox="0 0 200 200", no width or height, no background rectangle (the card behind it is pale grey), nothing before or after it.
Style: a clean, friendly flat illustration with soft depth, like a modern science app's spot illustrations. Rounded vessels with gentle gradients and a soft highlight; thin outlines in #8e9bab; glassware white or very light; liquids filling their vessels. Where the step moves liquid, a gloved hand holding a pipette is welcome. One clear scene, centred, with room around it: three to eight objects.
Draw what the facts say and nothing more: as many vials as listed, in their order, each labelled with its label; the mix's parts with their shares; the colours given, for what they colour. Where no colour is given, a liquid is pale blue (#cfe0f2) or clear.
Lay the scene out as "layout" says. Keep everything at least 10 units inside the edges.
Text: only labels taken from the facts (a vial's label, a part's share), short, font-family="Inter, Helvetica, sans-serif", 10 to 13 units tall, each on clear background beside or below what it names, never over a shape or another label. No titles, no sentences, no number that is not in the facts.
Write well-formed XML: every element closed, each attribute once, & written as &amp;.
Use only svg, g, defs, linearGradient, radialGradient, stop, clipPath, path, rect, circle, ellipse, line, polyline, polygon, text and tspan. No script, style element, image, filter, link, foreignObject or reference outside the drawing; ids short and unique.`;

/** How to lay out a step's picture, by what it does: the model draws, this keeps one kind of step looking like itself. */
export function layoutFor(f: StepFacts): string {
  const where = f.vessel === 'plate' ? 'a 96-well plate seen from slightly above' : f.vessel === 'dish' ? 'a culture dish of cells seen from slightly above' : 'a few tubes standing in a rack';
  switch (f.stage) {
    case 'standards':
      return `A rack seen from the front holding ${f.vials?.length ?? 'several'} small conical tubes in one row, left to right in the vials' order, each labelled under it; their liquid pale blue, lightest for the blank and deeper as the concentration rises. Nothing else.`;
    case 'mix':
      return `On the left, ${f.mix?.parts.length ?? 2} reagent bottles side by side, each with its share written under it; a small arrow; on the right one tall tube holding the mix${f.mix?.colour ? ' in its colour' : ''}. Nothing else.`;
    case 'load':
    case 'treat':
      return `In the lower half ${where}; above it a pipette, tip just over it, a drop falling; what has been added tinted ${f.adds?.length ? 'with what goes in' : 'pale blue'}.`;
    case 'wash':
      return `In the lower half ${where}; on the left an arrow up taking liquid out, on the right an arrow down adding clear buffer.`;
    case 'prepare':
      return f.prep === 'warm'
        ? 'Two or three reagent bottles side by side, soft orange warmth lines rising above them.'
        : f.prep === 'spin'
          ? 'One tube in the middle with two curved arrows going round it.'
          : f.prep === 'dilute'
            ? 'A row of three or four tubes and a pipette adding to one of them.'
            : f.prep === 'dissolve'
              ? 'One vial with a pipette above it adding liquid.'
              : f.prep === 'grow'
                ? 'A culture dish with pink medium and cells spread over it.'
                : `${f.bottles?.length ?? 2} reagent bottles side by side.`;
    default:
      return `What the step does, simply: ${f.does}`;
  }
}

/** Whether markup is well-formed enough for a browser to draw: tags closed in order, attributes once, text escaped. */
export function wellFormed(svg: string): boolean {
  const open: string[] = [];
  const tags = /<(\/?)([a-zA-Z][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/g;
  let at = 0;
  for (const m of svg.matchAll(tags)) {
    const text = svg.slice(at, m.index);
    if (/[<>]/.test(text) || /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i.test(text)) return false;
    at = m.index + m[0].length;
    const [, close, name, attrs, self] = m as unknown as [string, string, string, string, string];
    const names = [...attrs.matchAll(/([\w:.-]+)\s*=/g)].map(a => a[1]);
    if (new Set(names).size !== names.length) return false;
    if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i.test(attrs)) return false;
    if (close) {
      if (open.pop() !== name) return false;
    } else if (!self) open.push(name);
  }
  return open.length === 0 && !/[<>]/.test(svg.slice(at));
}

const ALLOWED = new Set(['svg', 'g', 'defs', 'lineargradient', 'radialgradient', 'stop', 'clippath', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'title', 'desc']);
const MAX_SVG = 80_000;

/** The drawing in a model's answer, if it is only drawing; null otherwise. */
export function cleanSvg(answer: string): string | null {
  const svg = /<svg\b[\s\S]*<\/svg>/i.exec(answer)?.[0];
  if (!svg || svg.length > MAX_SVG) return null;
  for (const tag of svg.matchAll(/<\/?\s*([a-zA-Z][\w:.-]*)/g)) if (!ALLOWED.has(tag[1]!.toLowerCase())) return null;
  // No markup declarations, handlers, scripts in attributes, outside data or style sheets.
  if (/<!|<\?|\bon[a-z]+\s*=|javascript:|data:|@import|expression\s*\(/i.test(svg)) return null;
  // References only to its own parts.
  if (/\bhref\s*=\s*["']?(?!#)/i.test(svg) || /url\(\s*['"]?(?!#)/i.test(svg)) return null;
  if (!/\bviewBox\s*=/.test(svg) || !wellFormed(svg)) return null;
  return /\bxmlns\s*=/.test(svg) ? svg : svg.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
}
