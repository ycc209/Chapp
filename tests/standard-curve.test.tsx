import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { analyzePlate, fitLinear, type WellRole } from '../shared/fit.ts';
import { StandardCurve, coefText, lineText } from '../src/components/lab/StandardCurve.tsx';
import { READ_FIT } from '../src/screens/results/analysis.ts';

// The BCA plate photographed on 2026-11-04 (five standards, 2,000 halved to 250 and the blank, and four samples, all
// in duplicate), laid out as the plan put them: what the results page draws for it.
const STANDARDS: [string, number, string[]][] = [['A', 2000, ['A1', 'A2']], ['B', 1000, ['B1', 'B2']], ['C', 500, ['C1', 'C2']], ['D', 250, ['D1', 'D2']], ['E', 0, ['E1', 'E2']]];
const SAMPLES: [string, string[]][] = [['1', ['F1', 'F2']], ['2', ['G1', 'G2']], ['3', ['H1', 'H2']], ['4', ['A3', 'A4']]];
const roles: WellRole[] = [
  ...STANDARDS.flatMap(([ref, concentration, wells]) => wells.map(well => ({ well, kind: 'standard' as const, ref, concentration, blank: concentration === 0 }))),
  ...SAMPLES.flatMap(([ref, wells]) => wells.map(well => ({ well, kind: 'sample' as const, ref }))),
];
const readings = {
  A1: 1.803, A2: 1.864, B1: 1.1, B2: 1.087, C1: 0.643, C2: 0.617, D1: 0.373, D2: 0.38, E1: 0.098, E2: 0.101,
  F1: 1.304, F2: 1.286, G1: 0.967, G2: 0.94, H1: 0.565, H2: 0.561, A3: 2.048, A4: 2.034,
};
const a = analyzePlate(roles, readings, { preferred: ['4pl', 'best-fit'], avoid: ['linear'] });
const html = (props: Partial<Parameters<typeof StandardCurve>[0]> = {}) => renderToStaticMarkup(<StandardCurve analysis={a} xLabel="BSA, µg/mL" yLabel="Net A562" {...props} />);
const texts = (markup: string) => [...markup.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map(m => m[1]);

describe('the standard curve on the results page', () => {
  it('numbers the y axis as well as the x axis', () => {
    // Net A562 reaches 1.73 at 2,000 µg/mL: ticks every 0.5.
    expect(texts(html())).toEqual(['0', '500', '1,000', '1,500', '2,000', 'BSA, µg/mL', '0', '0.5', '1.0', '1.5', 'Net A562']);
  });

  it('draws the straight regression line, its R² beside it on the plot and its equation below: nothing for the fit', () => {
    const page = html({ caption: false, regression: true });
    expect(page).not.toContain('blank subtracted');
    expect(page).toContain('stroke-dasharray="4 3"');
    const straight = fitLinear(a.standards.map(s => ({ x: s.concentration, y: s.mean })))!;
    if (straight.kind !== 'linear') throw new Error('expected a straight line');
    expect(lineText(straight)).toBe('y = 0.000858x + 0.06364');
    expect(page).toContain(`<span class="min-w-0 flex-1 font-semibold text-ink tabular-nums">${lineText(straight)}</span></figcaption>`);
    // The one R² is the straight line's, a <text> in the plot: the four-parameter fit's (0.999+) is not written.
    expect(texts(page)).toContain('R² = 0.993');
    expect(page.match(/R²/g)).toHaveLength(1);
    expect(page).not.toContain('(x / c)');
  });

  it('reads the samples off the straight line, and draws only that line: no solid blue curve', () => {
    const line = analyzePlate(roles, readings, READ_FIT);
    expect(line.fit.kind).toBe('linear');
    // S1–S3 by y = 0.000858x + 0.06364 read backwards; S4 (net 1.94) is still above the top standard.
    expect(line.samples.map(s => (s.concentration === null ? s.flag : Math.round(s.concentration)))).toEqual([1319, 921, 466, 'above']);
    const blue = 'stroke="var(--blue)"';
    expect(html({ analysis: line, caption: false, regression: true })).not.toContain(blue);
    expect(html({ analysis: line, caption: false, regression: true }).match(/<path /g)).toHaveLength(3); // axes, dashed line, key
    // Elsewhere (the lab gallery) the fitted curve is still drawn solid.
    expect(html()).toContain(blue);
  });

  it('writes the coefficients to four figures, with a true minus sign', () => {
    expect([coefText(0.000861745), coefText(5367.73), coefText(-0.0123456), coefText(1.01499)]).toEqual(['0.0008617', '5,368', '−0.01235', '1.015']);
    expect(lineText({ kind: 'linear', slope: 0.0008617, intercept: -0.0123, r2: 0.99 })).toBe('y = 0.0008617x − 0.0123');
    expect(lineText({ kind: 'linear', slope: 0.0008617, intercept: 0.0457, r2: 0.99 })).toBe('y = 0.0008617x + 0.0457');
  });
});
