/**
 * Draws the app icons (public/chapp/icon-180/192/512.png) through scripts/chapp-model/unit.html: Chapp's body, the
 * Hsp16.5 cage without its face, seen straight down one of its four-fold axes (a square window in the middle), on
 * black, taking up two thirds of the tile. The same picture serves as the maskable icon: the cage stays inside the
 * safe circle. Needs Vite running.
 *
 *   node scripts/chapp-model/icons.ts [vite url, default http://localhost:5175] [--out dir]
 *   node scripts/chapp-model/icons.ts https://localhost:5175   (npm run dev:phone)
 *
 * WebGL runs on SwiftShader, as in stills.ts: the same pictures on any machine, no GPU needed.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

/** The icon's view (see unit.tsx): the cage down a four-fold axis, two thirds of the frame, black behind. */
export const ICON = { unit: 'all', yaw: 135, pitch: 0, roll: 0, fill: 0.66, bg: '#000000' } as const;
const DRAWN = 1024; // drawn this big (and supersampled), then scaled down to each size
const SIZES = [180, 192, 512];

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const out = resolve(flag('out') ?? resolve(import.meta.dirname, '../../public/chapp'));
const base = (args[0] ?? 'http://localhost:5175').replace(/\/$/, '');

type Unit = { ready: Promise<void>; render(view: typeof ICON): Promise<string> };

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars', '--ignore-certificate-errors'],
});
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(300000);
  page.on('pageerror', e => console.error(String(e)));
  await page.setViewport({ width: DRAWN + 100, height: DRAWN + 100, deviceScaleFactor: 1 });
  await page.goto(`${base}/scripts/chapp-model/unit.html?size=${DRAWN}`, { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForFunction(() => 'unit' in window, { timeout: 60000 });
  const drawn = await page.evaluate(async view => {
    const unit = (window as unknown as { unit: Unit }).unit;
    await unit.ready;
    return unit.render(view);
  }, ICON);
  mkdirSync(out, { recursive: true });
  for (const size of SIZES) {
    const data = await page.evaluate(
      async (src, s) => {
        const img = new Image();
        img.src = src;
        await img.decode();
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = s;
        const g = canvas.getContext('2d')!;
        g.imageSmoothingQuality = 'high';
        g.drawImage(img, 0, 0, s, s);
        return canvas.toDataURL('image/png');
      },
      drawn,
      size,
    );
    const file = resolve(out, `icon-${size}.png`);
    const bytes = Buffer.from(data.slice(data.indexOf(',') + 1), 'base64');
    writeFileSync(file, bytes);
    console.log(`${file}  ${(bytes.length / 1024).toFixed(1)} KB`);
  }
} finally {
  await Promise.race([browser.close(), new Promise(r => setTimeout(r, 5000))]);
  process.exit(0);
}
