/**
 * Draws the stills in public/chapp (chapp.webp, chapp-blink.webp, chapp-<face>.webp …) from the same R3F scene the
 * app shows, through scripts/chapp-model/lookdev.html, so the pictures match the 3D Chapp. Needs Vite running.
 *
 *   node scripts/chapp-model/stills.ts [vite url, default http://localhost:5175] [--only chapp.webp,chapp-happy.webp]
 *   node scripts/chapp-model/stills.ts http://localhost:5194 --out /tmp/stills --png   (lossless, for comparing)
 *
 * WebGL runs on SwiftShader, as in scripts/shot.ts: the same pictures on any machine, no GPU needed.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const png = args.includes('--png') ? (args.splice(args.indexOf('--png'), 1), true) : false;
const only = flag('only')?.split(',');
const out = resolve(flag('out') ?? resolve(import.meta.dirname, '../../public/chapp'));
const base = (args[0] ?? 'http://localhost:5175').replace(/\/$/, '');

type Lookdev = { names: string[]; ready: Promise<void>; render(name: string): Promise<string>; renderPng(name: string): Promise<string> };

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars'],
});
try {
  const page = await browser.newPage();
  page.on('pageerror', e => console.error(String(e)));
  await page.setViewport({ width: 1400, height: 800, deviceScaleFactor: 1 });
  await page.goto(`${base}/scripts/chapp-model/lookdev.html`, { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForFunction(() => 'lookdev' in window, { timeout: 60000 });
  const names = await page.evaluate(async () => {
    const lookdev = (window as unknown as { lookdev: Lookdev }).lookdev;
    await lookdev.ready;
    return lookdev.names;
  });
  mkdirSync(out, { recursive: true });
  for (const name of names.filter(n => !only || only.includes(n))) {
    const data = await page.evaluate(
      (n, lossless) => {
        const lookdev = (window as unknown as { lookdev: Lookdev }).lookdev;
        return lossless ? lookdev.renderPng(n) : lookdev.render(n);
      },
      name,
      png,
    );
    const file = resolve(out, png ? name.replace(/\.webp$/, '.png') : name);
    const bytes = Buffer.from(data.slice(data.indexOf(',') + 1), 'base64');
    writeFileSync(file, bytes);
    console.log(`${file}  ${(bytes.length / 1024).toFixed(1)} KB`);
  }
} finally {
  await browser.close();
}
