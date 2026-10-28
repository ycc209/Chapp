import { useMemo } from 'react';
import { create, toDataURL } from 'qrcode';

// M recovers from 15% damage: a code shown on one phone and read by another's camera, glare and all.
const LEVEL = 'M';

/**
 * The code as one SVG path, a rectangle per run of dark modules in a row, as Share-QR draws it (viewBox one unit per
 * module, no quiet zone: the white page around it is the margin).
 */
export function qrModules(text: string): { size: number; d: string } {
  const { modules } = create(text, { errorCorrectionLevel: LEVEL });
  const n = modules.size;
  let d = '';
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; ) {
      if (!modules.get(y, x)) {
        x++;
        continue;
      }
      let run = 1;
      while (x + run < n && modules.get(y, x + run)) run++;
      d += `M${x} ${y}h${run}v1h-${run}z`;
      x += run;
    }
  }
  return { size: n, d };
}

/** Share-QR's code: 210 px, ink on white, crisp module edges. */
export function QrCode({ text, size = 210 }: { text: string; size?: number }) {
  const { size: n, d } = useMemo(() => qrModules(text), [text]);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${n} ${n}`} shapeRendering="crispEdges" aria-hidden="true">
      <path fill="#111113" d={d} />
    </svg>
  );
}

/** The code as a PNG with its quiet zone, for "Save image": big enough to print or to show from another screen. */
export async function qrPng(text: string): Promise<Blob> {
  const url = await toDataURL(text, { errorCorrectionLevel: LEVEL, margin: 4, scale: 16, color: { dark: '#111113', light: '#ffffff' } });
  return (await fetch(url)).blob();
}
