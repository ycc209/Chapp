import type { Problem } from './engine.ts';

// Runs on the audio thread: hands the microphone's samples to the page in chunks of 2048 (about 43 ms at 48 kHz).
const WORKLET = `
class ChappTap extends AudioWorkletProcessor {
  constructor() { super(); this.buffer = new Float32Array(2048); this.filled = 0; }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) for (let i = 0; i < channel.length; i++) {
      this.buffer[this.filled++] = channel[i];
      if (this.filled === this.buffer.length) {
        this.port.postMessage(this.buffer, [this.buffer.buffer]);
        this.buffer = new Float32Array(2048);
        this.filled = 0;
      }
    }
    return true;
  }
}
registerProcessor('chapp-tap', ChappTap);
`;

/**
 * The microphone, for the engines that hear through the server (server.ts records turns, live.ts streams them): each
 * chunk of samples goes to `onChunk` with the context's sample rate. Letting go of it keeps the audio context, so the
 * next turn opens at once.
 */
export class Microphone {
  ctx: AudioContext | null = null;
  private readonly onChunk: (chunk: Float32Array, rate: number) => void;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private tap: AudioNode | null = null;

  constructor(onChunk: (chunk: Float32Array, rate: number) => void) {
    this.onChunk = onChunk;
  }

  /** Call inside the user's tap: Safari lets an AudioContext run only if it was made there. */
  begin(): Problem | null {
    if (!window.isSecureContext) return 'insecure';
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === 'undefined') return 'unavailable';
    this.ctx = new AudioContext();
    this.ctx.resume().catch(() => {});
    return null;
  }

  /** Opens the microphone. `wanted` says whether it still is once the permission prompt has gone. */
  async open(wanted: () => boolean): Promise<Problem | null> {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      const name = (e as { name?: string } | null)?.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') return 'mic-off';
      if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'no-mic';
      return 'failed';
    }
    const ctx = this.ctx;
    // Stopped or paused while the permission prompt was up.
    if (!wanted() || !ctx) {
      for (const track of stream.getTracks()) track.stop();
      return null;
    }
    try {
      this.tap ??= await this.makeTap(ctx);
      if (!wanted() || this.ctx !== ctx) {
        for (const track of stream.getTracks()) track.stop();
        return null;
      }
      this.stream = stream;
      this.source = ctx.createMediaStreamSource(stream);
      this.source.connect(this.tap);
      return null;
    } catch {
      for (const track of stream.getTracks()) track.stop();
      return 'unavailable';
    }
  }

  /** Closes the microphone (the red dot goes away); the audio context stays for the next turn. */
  release() {
    this.source?.disconnect();
    this.source = null;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
  }

  /** Lets go of everything. */
  close() {
    this.release();
    this.tap?.disconnect();
    this.tap = null;
    this.ctx?.close().catch(() => {});
    this.ctx = null;
  }

  /** A node that passes each chunk of microphone samples on. It plays nothing: its output is muted. */
  private async makeTap(ctx: AudioContext): Promise<AudioNode> {
    const mute = ctx.createGain();
    mute.gain.value = 0;
    mute.connect(ctx.destination);
    const rate = ctx.sampleRate;
    if (ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
      try {
        const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
        await ctx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        const node = new AudioWorkletNode(ctx, 'chapp-tap', { channelCount: 1, channelCountMode: 'explicit' });
        node.port.onmessage = (e: MessageEvent<Float32Array>) => this.onChunk(e.data, rate);
        node.connect(mute);
        return node;
      } catch {
        // Older Safari: the deprecated ScriptProcessor below still works.
      }
    }
    const node = ctx.createScriptProcessor(2048, 1, 1);
    node.onaudioprocess = e => this.onChunk(e.inputBuffer.getChannelData(0).slice(), rate);
    node.connect(mute);
    return node;
  }
}
