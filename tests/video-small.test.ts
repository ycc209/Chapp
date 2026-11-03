import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Video } from '../shared/ai.ts';
import { createKitVision } from '../server/ai/vision.ts';
import { videoFrameTimes } from '../server/ai/videoFrames.ts';
import { smallArgs, smallVideo } from '../server/ai/videoSmall.ts';

const ffmpeg = (() => {
  try {
    return createRequire(import.meta.url)('ffmpeg-static') as string | null;
  } catch {
    return null;
  }
})();

describe('a video made small for SAM', () => {
  it('is H.264 at 10 frames a second, its short side 720 at most, upright, without sound', () => {
    const args = smallArgs('in.mov', 'small.mp4');
    expect(args.join(' ')).toContain("-vf fps=10,scale='if(gt(iw,ih),-2,min(720,iw))':'if(gt(iw,ih),min(720,ih),-2)' -c:v libx264");
    expect(args).toEqual(expect.arrayContaining(['-map', '0:v:0', '-an', '+faststart']));
    expect(args.at(-1)).toBe('small.mp4');
  });

  it.runIf(ffmpeg)('comes out a third of the frames and 720 high from a 1080p, 30 fps clip', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chapp-small-test-'));
    try {
      const file = join(dir, 'clip.mp4');
      execFileSync(ffmpeg!, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1920x1080:rate=30', '-t', '1', '-pix_fmt', 'yuv420p', file]);
      const original: Video = { type: 'video/mp4', data: new Uint8Array(readFileSync(file)) };
      const small = await smallVideo(original);
      expect(small?.type).toBe('video/mp4');
      expect(small!.data.length).toBeLessThan(original.data.length);
      expect((await videoFrameTimes(original))!.length).toBe(30);
      expect((await videoFrameTimes(small!))!.length).toBe(10);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is nothing when there is no ffmpeg or the video cannot be read', async () => {
    const junk: Video = { type: 'video/mp4', data: new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]) };
    expect(await smallVideo(junk, null)).toBeNull();
    if (ffmpeg) expect(await smallVideo(junk)).toBeNull();
  });

  it('is what SAM follows, the video as it came when it cannot be made', async () => {
    const done = { status: 'completed', usage: { video_frames_processed: 50 }, output: [{ type: 'message', content: [{ type: 'output_text', text: '<0f>1<|box;x1=10;y1=20;x2=40;y2=90;w=100;h=100|>' }] }] };
    const sent: string[] = [];
    const fetch = (async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)).input[0].content[1].video_url);
      return new Response(JSON.stringify(done));
    }) as unknown as typeof globalThis.fetch;
    const mov: Video = { type: 'video/quicktime', data: new Uint8Array([1, 2, 3]) };
    const small: Video = { type: 'video/mp4', data: new Uint8Array([4, 5, 6]) };
    await createKitVision({ apiKey: 'k', fetch, log: () => {}, smallVideo: async () => small }).trackBottles!(mov);
    await createKitVision({ apiKey: 'k', fetch, log: () => {}, smallVideo: async () => null }).trackBottles!(mov);
    expect(sent).toEqual(['data:video/mp4;base64,BAUG', 'data:video/quicktime;base64,AQID']);
  });
});
