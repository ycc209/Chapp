import { ALL_FORMATS, BufferSource, EncodedPacketSink, Input } from 'mediabunny';
import type { Video } from '../../shared/ai.ts';

/**
 * When each frame of a video starts, in seconds from the first, in the order they show: the order SAM numbers them in
 * (240 frames of the 8 s test pan, 329 of the user's 11 s iPhone video, as SAM counted them). Read from the video's own
 * index, without decoding a frame (a few milliseconds), with mediabunny, as Meta's @meta-sam/video reads it. So the
 * phone finds the frame on screen by the time it shows, a recording whose frames come unevenly (a sweep) too. Null
 * when the video cannot be read; the phone then spreads the frames evenly over its length.
 */
export async function videoFrameTimes(video: Video): Promise<number[] | null> {
  const input = new Input({ source: new BufferSource(video.data), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) return null;
    const times: number[] = [];
    for await (const packet of new EncodedPacketSink(track).packets(undefined, undefined, { metadataOnly: true })) times.push(packet.timestamp);
    if (!times.length) return null;
    // Packets come in the order they decode; frames show in the order of their times.
    times.sort((a, b) => a - b);
    const first = times[0]!;
    return times.map(t => Math.round((t - first) * 1e4) / 1e4);
  } catch {
    return null;
  } finally {
    input.dispose();
  }
}
