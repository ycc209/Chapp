/** What POST /api/voice takes: mono 16-bit PCM at 16 kHz (shared/ai.ts). */
export const WAV_RATE = 16000;

/**
 * Resamples the microphone (usually 48 or 44.1 kHz) to `toRate`. Going down, each output sample is the mean of the input
 * samples it covers: a cheap low-pass that keeps speech clean. Going up (an 8 kHz headset), it interpolates.
 */
export function downsample(input: Float32Array, fromRate: number, toRate = WAV_RATE): Float32Array {
  if (fromRate === toRate) return input.slice();
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.floor(input.length / ratio));
  if (ratio < 1) {
    for (let i = 0; i < out.length; i++) {
      const at = i * ratio;
      const j = Math.floor(at);
      const next = input[Math.min(j + 1, input.length - 1)]!;
      out[i] = input[j]! + (next - input[j]!) * (at - j);
    }
    return out;
  }
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j]!;
    out[i] = end > start ? sum / (end - start) : input[start]!;
  }
  return out;
}

/** A WAV file (RIFF, PCM 16-bit, mono) holding `samples` in -1…1. */
export function encodeWav(samples: Float32Array, sampleRate = WAV_RATE): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(44 + samples.length * 2));
  const view = new DataView(bytes.buffer);
  const text = (at: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i)); };
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // bytes per second
  view.setUint16(32, 2, true); // bytes per frame
  view.setUint16(34, 16, true); // bits per sample
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return bytes;
}

/** The microphone's samples as the WAV the server transcribes. */
export function toWav(samples: Float32Array, fromRate: number): Blob {
  return new Blob([encodeWav(downsample(samples, fromRate))], { type: 'audio/wav' });
}

/** Root-mean-square level of a chunk, 0…1: how loud it is. */
export function level(chunk: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < chunk.length; i++) sum += chunk[i]! * chunk[i]!;
  return chunk.length ? Math.sqrt(sum / chunk.length) : 0;
}

/** Joins recorded chunks into one buffer. */
export function concat(chunks: Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
