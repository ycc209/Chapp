import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Video } from '../../shared/ai.ts';

/**
 * A video made small for SAM 3.1 to follow: its short side at most SMALL_SIDE, SMALL_FPS frames a second, H.264, no
 * sound. SAM takes every frame it is sent, and no option asks it for fewer (dev.meta.ai/docs/sam/segmenting): on the
 * user's 11 s iPhone video (1080p, 30 fps, 12.5 MB) it took 31.6 s through Meta's file store; made small (720p, 10 fps,
 * 2.7 MB, 0.8 s with ffmpeg on the Mac mini) it took 9.0 s in the request itself, with the same reagents and ampules
 * followed. Its frames are SAM's: the times it is followed by are this video's (videoFrames.ts), which the phone finds
 * on the video it has, as the same moments.
 */

export const SMALL_SIDE = 720;
export const SMALL_FPS = 10;
/** A video that takes longer than this to make small is sent as it is. */
const SMALL_WAIT_MS = 20_000;

/** ffmpeg as the ffmpeg-static package brings it; null where it did not download. */
function ffmpegPath(): string | null {
  try {
    return (createRequire(import.meta.url)('ffmpeg-static') as string | null) ?? null;
  } catch {
    return null;
  }
}

/** The ffmpeg arguments that make `input` small into `output`. Pure, so it is tested. */
export function smallArgs(input: string, output: string, side = SMALL_SIDE, fps = SMALL_FPS): string[] {
  // The short side down to `side` (never up), turned upright first as the video says; the long side by its shape, even.
  const scale = `scale='if(gt(iw,ih),-2,min(${side},iw))':'if(gt(iw,ih),min(${side},ih),-2)'`;
  return [
    '-v', 'error', '-y', '-i', input,
    '-map', '0:v:0', '-an', '-sn', '-dn', '-map_metadata', '-1',
    '-vf', `fps=${fps},${scale}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', output,
  ];
}

/** `video` made small (an MP4), or null when it cannot be: no ffmpeg, a video it cannot read, or too slow. */
export async function smallVideo(video: Video, ffmpeg = ffmpegPath()): Promise<Video | null> {
  if (!ffmpeg) return null;
  const dir = await mkdtemp(join(tmpdir(), 'chapp-video-'));
  try {
    const input = join(dir, video.type === 'video/quicktime' ? 'in.mov' : 'in.mp4');
    const output = join(dir, 'small.mp4');
    await writeFile(input, video.data);
    const ok = await new Promise<boolean>(resolve => {
      const run = spawn(ffmpeg, smallArgs(input, output), { stdio: 'ignore' });
      const timer = setTimeout(() => run.kill('SIGKILL'), SMALL_WAIT_MS);
      run.on('error', () => (clearTimeout(timer), resolve(false)));
      run.on('close', code => (clearTimeout(timer), resolve(code === 0)));
    });
    if (!ok) return null;
    const data = new Uint8Array(await readFile(output));
    return data.length ? { type: 'video/mp4', data } : null;
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
