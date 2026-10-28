/**
 * Screenshots the app at phone size in the Mac's own Chrome, to compare with the design artboards.
 *
 *   node scripts/shot.ts <url> <out.png> [--wait 1500] [--size 402x874] [--eval "<js run in the page before the shot>"]
 *   node scripts/shot.ts http://localhost:5175/ /tmp/home.png
 *   node scripts/shot.ts "http://localhost:5175/?state=plus" /tmp/plus.png --wait 800
 *
 * The page is emulated as a touch phone at 3× like an iPhone 17 (402×874, the design's screen size). WebGL runs on
 * SwiftShader, so 3D renders without a GPU. Prints the page's console errors, if any.
 */
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const wait = Number(flag('wait') ?? 1500);
const [width, height] = (flag('size') ?? '402x874').split('x').map(Number);
const script = flag('eval');
const [url, out] = args;
if (!url || !out) {
  console.error('Usage: node scripts/shot.ts <url> <out.png> [--wait ms] [--size WxH] [--eval js]');
  process.exit(1);
}

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars'],
});
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('console', m => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', e => errors.push(String(e)));
  await page.setViewport({ width, height, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
  if (script) await page.evaluate(script);
  await new Promise(r => setTimeout(r, wait));
  await page.screenshot({ path: out as `${string}.png` });
  console.log(`saved ${out}`);
  if (errors.length) console.log(`console errors:\n  ${errors.join('\n  ')}`);
} finally {
  await browser.close();
}
