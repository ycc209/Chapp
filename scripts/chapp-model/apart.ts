/**
 * Draws docs/img/chapp-apart.gif: Chapp coming apart into the 24 subunits of Hsp16.5 and back, as three quick taps on
 * the big 3D Chapp do in the app (rig.ts scatter), from the same scene as the stills (lookdev.html). The page's clock
 * is stepped one frame at a time, so the GIF plays the animation evenly however slowly SwiftShader draws it, a little
 * slower than the app (SLOW) so each subunit can be followed. Needs Vite running.
 *
 *   node scripts/chapp-model/apart.ts [vite url, default http://localhost:5175] [--out docs/img/chapp-apart.gif]
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';
import { SCATTER } from '../../src/components/chapp/three/rig.ts';

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const out = resolve(outAt >= 0 ? args.splice(outAt, 2)[1]! : resolve(import.meta.dirname, '../../docs/img/chapp-apart.gif'));
const base = (args[0] ?? 'http://localhost:5175').replace(/\/$/, '');
const ffmpeg = createRequire(import.meta.url)('ffmpeg-static') as string;

/**
 * Frames a second in the GIF, how much slower than the app it plays, its width, the still moments either side, and
 * how far the camera draws back from the still's framing so the subunits stay in the picture when apart.
 */
const FPS = 15;
const SLOW = 1.6;
const WIDTH = 400;
const ZOOM = 0.62;
const BEFORE = 600;
const AFTER = 500;

const frames = Math.ceil(((BEFORE + AFTER) / 1000) * FPS + ((SCATTER.end * SLOW) / 1000) * FPS);
const dir = mkdtempSync(join(tmpdir(), 'chapp-apart-'));
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars', '--ignore-certificate-errors'],
});
try {
  const page = await browser.newPage();
  page.on('pageerror', e => console.error(String(e)));
  await page.setViewport({ width: 1400, height: 800, deviceScaleFactor: 1 });
  await page.goto(`${base}/scripts/chapp-model/lookdev.html`, { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForFunction(() => 'lookdev' in window, { timeout: 60000 });
  // Chapp as in chapp.webp (neutral, the eyes open), then the page's clock taken over: rig.update reads performance.now.
  await page.evaluate(async zoom => {
    const w = window as unknown as { lookdev: any; clock: number };
    await w.lookdev.ready;
    await w.lookdev.render('chapp.webp');
    const scene = [...w.lookdev.scenes].sort((a: any, b: any) => a.gl.domElement.width - b.gl.domElement.width)[0];
    scene.camera.zoom *= zoom;
    scene.camera.updateProjectionMatrix();
    w.clock = performance.now();
    performance.now = () => w.clock;
  }, ZOOM);
  for (let f = 0; f < frames; f++) {
    const ms = (f / FPS) * 1000;
    const data = await page.evaluate(
      async (ms, before, slow) => {
        const w = window as unknown as { lookdev: any; clock: number; start?: number; started?: boolean };
        // The neutral still's scene: the smaller canvas (600 px; the faces that reach past the body get 720).
        const scene = [...w.lookdev.scenes].sort((a: any, b: any) => a.gl.domElement.width - b.gl.domElement.width)[0];
        if (w.start === undefined) w.start = w.clock;
        if (ms >= before && !w.started) {
          // Comes apart at the start of the page's clock, then runs on it, SLOW times slower than the app.
          w.clock = w.start;
          scene.rig.scatter();
          w.started = true;
        }
        w.clock = w.start + Math.max(0, ms - before) / slow;
        await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(done))));
        return scene.gl.domElement.toDataURL('image/png');
      },
      ms,
      BEFORE,
      SLOW,
    );
    writeFileSync(join(dir, `${String(f).padStart(4, '0')}.png`), Buffer.from(data.slice(data.indexOf(',') + 1), 'base64'));
  }
} finally {
  await browser.close();
}

// On white, as the README shows it, with one palette for the whole loop.
mkdirSync(dirname(out), { recursive: true });
const graph =
  `[0:v]scale=${WIDTH}:-1:flags=lanczos[c];color=white:s=${WIDTH}x${WIDTH}[bg];[bg][c]overlay=shortest=1,split[a][b];` +
  `[a]palettegen=max_colors=128:reserve_transparent=0[p];[b][p]paletteuse=dither=sierra2_4a`;
execFileSync(ffmpeg, ['-v', 'error', '-y', '-framerate', String(FPS), '-i', join(dir, '%04d.png'), '-filter_complex', graph, '-loop', '0', out]);
rmSync(dir, { recursive: true, force: true });
console.log(`${out}  ${frames} frames, ${(statSync(out).size / 1024).toFixed(0)} KB`);
