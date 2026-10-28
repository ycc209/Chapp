import { predict, type Fit, type PlateAnalysis } from '../../../shared/fit.ts';
import { cn } from '../../lib/cn.ts';
import { concentrationText, shadeColor, shadeLevels } from './model.ts';

// The design's plot (Results-Swipe-Curve): a 300 × 210 drawing, axes from (36, 170) up to y 10 and across to x 290.
const X0 = 36, X1 = 290, Y0 = 170, Y1 = 10;

/** A light point gets a darker ring so it shows on white, as drawn: the blank in --std-2, pale blues in --std-4/5. */
function ring(level: number) {
  if (level === 0) return 'var(--std-2)';
  if (level === 1) return 'var(--std-4)';
  if (level <= 3) return 'var(--std-5)';
  return undefined;
}

/** Tick spacing: the 1-2-2.5-5 step that gives about four intervals up to the top standard (2,000 → every 500). */
function tickStep(max: number) {
  const raw = max / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  return ([1, 2, 2.5, 5, 10].find(m => m * p >= raw - 1e-9) ?? 10) * p;
}

const FIT_NAMES: Record<Fit['kind'], string> = {
  '4pl': 'Four-parameter fit',
  quadratic: 'Quadratic fit',
  linear: 'Straight-line fit',
  'point-to-point': 'Point to point',
};

/** "Four-parameter fit, blank subtracted." */
export const fitCaption = (fit: Fit) => `${FIT_NAMES[fit.kind]}, blank subtracted.`;

export type StandardCurveProps = {
  /** From shared/fit.ts analyzePlate(). */
  analysis: PlateAnalysis;
  /** Under the x axis: "BSA, µg/mL" (the standard's short name). */
  xLabel?: string;
  /** Along the y axis: "Net A562" (the protocol's readout). */
  yLabel?: string;
  /** Plot the samples read off the curve too (yellow). The design's curve page shows the standards only. */
  samples?: boolean;
  /** "Four-parameter fit, blank subtracted." under the plot. */
  caption?: boolean;
  /** Drawn width, px (the design: 338, the page's full width). */
  width?: number;
  className?: string;
};

/**
 * The standard curve as an SVG: each standard's mean blank-corrected reading against its concentration, in the vials'
 * blues, and the fitted curve through them in Meta blue. Axes, ticks and labels as drawn on Results-Swipe-Curve.
 */
export function StandardCurve({ analysis, xLabel = 'Concentration, µg/mL', yLabel = 'Net reading', samples = false, caption = true, width = 338, className }: StandardCurveProps) {
  const { fit, standards, range } = analysis;
  const levels = shadeLevels(standards.map(s => ({ concentration: s.concentration, blank: s.blank })));
  const xMax = range.max;
  const yMax = Math.max(...standards.filter(s => s.concentration === xMax).map(s => s.mean), predict(fit, xMax));
  const x = (c: number) => X0 + (c / xMax) * (X1 - X0);
  const y = (v: number) => Y0 - (Math.max(0, v) / yMax) * (Y0 - Y1);
  const steps = 64;
  const line = Array.from({ length: steps + 1 }, (_, i) => {
    const c = (xMax * i) / steps;
    return `${i ? 'L' : 'M'}${x(c).toFixed(1)} ${Math.max(Y1, Math.min(Y0, y(predict(fit, c)))).toFixed(1)}`;
  }).join('');
  const step = tickStep(xMax);
  const ticks = Array.from({ length: Math.floor(xMax / step + 1e-9) + 1 }, (_, i) => i * step);
  const shown = samples ? analysis.samples.filter(s => s.flag !== 'missing' && s.flag !== 'above' && s.concentration !== null && s.mean !== null) : [];
  const height = Math.round((width * 210) / 300);
  return (
    <figure className={cn('m-0 flex flex-col', className)}>
      {/* 3 px under the drawing: the descender room the design's inline SVG leaves before the caption. */}
      <div className="px-1 pt-2 pb-[3px]">
        <svg
          viewBox="0 0 300 210"
          width={width}
          height={height}
          role="img"
          aria-label={`Standard curve from 0 to ${concentrationText(xMax)} µg/mL, ${yLabel}`}
          className="block max-w-full"
        >
          <path d={`M${X0} ${Y1}V${Y0}H${X1}`} fill="none" stroke="#d9d9d5" strokeWidth="1" />
          <path d={line} fill="none" stroke="var(--blue)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          {standards.map((s, i) => {
            const stroke = ring(levels[i]!);
            return (
              <circle
                key={s.ref}
                cx={x(s.concentration)}
                cy={y(s.mean)}
                r="4"
                fill={shadeColor(levels[i]!)}
                stroke={stroke}
                strokeWidth={stroke ? 1.5 : undefined}
              >
                <title>{`${s.ref}: ${concentrationText(s.concentration)} µg/mL`}</title>
              </circle>
            );
          })}
          {shown.map(s => (
            <circle key={`s${s.ref}`} cx={x(s.concentration!)} cy={y(s.mean!)} r="3.5" fill="var(--sample-bg)" stroke="var(--sample-line)" strokeWidth="1.5">
              <title>{`Sample ${s.ref}`}</title>
            </circle>
          ))}
          {ticks.map(t => (
            <text key={t} x={t === xMax ? X1 - 6 : x(t)} y="186" fontSize="9" fontWeight="600" fill="var(--text)" textAnchor="middle">
              {concentrationText(t)}
            </text>
          ))}
          <text x={(X0 + X1) / 2} y="204" fontSize="10" fontWeight="600" fill="var(--text)" textAnchor="middle">
            {xLabel}
          </text>
          <text x="12" y="90" fontSize="10" fontWeight="600" fill="var(--text)" textAnchor="middle" transform="rotate(-90 12 90)">
            {yLabel}
          </text>
        </svg>
      </div>
      {caption && <figcaption className="mt-2 px-1 text-[15px] leading-[22px] text-text">{fitCaption(fit)}</figcaption>}
    </figure>
  );
}
