import { api } from '../api/client.ts';
import { MAX_TURN_MS, NO_SPEECH_MS, SILENCE_MS, type Engine, type EngineEvents, type Mode, type Problem } from './engine.ts';
import { SpeechGate } from './silence.ts';
import { concat, level, toWav } from './wav.ts';

/** Audio kept from just before speech is detected, so the first syllable is not clipped. */
const PREROLL_MS = 400;
/** Of the closing silence, this much stays on the recording, so the last word is not clipped. */
const TAIL_MS = 300;

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

const transcribeOnServer = async (wav: Blob, signal: AbortSignal) => (await api.transcribe(wav, signal)).transcript;

/**
 * Hears through the server: records the microphone, cuts each turn at a pause (by loudness, see silence.ts) and sends
 * it as a 16 kHz WAV to POST /api/voice. Nothing appears while the user speaks; the words come back in one piece.
 */
export class ServerEngine implements Engine {
  private mode: Mode;
  private readonly events: EngineEvents;
  private readonly transcribe: (wav: Blob, signal: AbortSignal) => Promise<string>;
  /** Cancels transcriptions still on their way when the engine stops. */
  private readonly cancel = new AbortController();
  private state: 'listening' | 'paused' | 'sending' | 'done' = 'listening';
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private tap: AudioNode | null = null;
  private readonly gate = new SpeechGate({ endAfterMs: SILENCE_MS });
  private before: Float32Array[] = [];
  private speech: Float32Array[] = [];
  private speechMs = 0;
  private quietTimer = 0;
  /** Turns go to the server one after another, so they come back in the order they were said. */
  private queue: Promise<void> = Promise.resolve();

  constructor(mode: Mode, events: EngineEvents, transcribe = transcribeOnServer) {
    this.mode = mode;
    this.events = events;
    this.transcribe = transcribe;
  }

  start() {
    if (!window.isSecureContext) return this.stop('insecure');
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === 'undefined') return this.stop('unavailable');
    // Made inside the user's tap: Safari lets an AudioContext run only if it was.
    this.ctx = new AudioContext();
    this.ctx.resume().catch(() => {});
    if (this.mode === 'tap') this.quietTimer = window.setTimeout(() => this.stop('no-speech'), NO_SPEECH_MS);
    void this.open();
  }

  finish() {
    if (this.state === 'done' || this.state === 'sending') return;
    if (this.mode !== 'talk' && this.gate.heard && this.ctx) this.send(this.ctx.sampleRate, false);
    else this.stop();
  }

  toTap() {
    if (this.mode !== 'hold' || this.state !== 'listening') return;
    this.mode = 'tap';
    // Already quiet after speech: that was the pause that ends a tap.
    if (this.gate.heard && !this.gate.speaking && this.ctx) this.send(this.ctx.sampleRate, false);
    else if (!this.gate.heard) this.quietTimer = window.setTimeout(() => this.stop('no-speech'), NO_SPEECH_MS);
  }

  /** Lets go of the microphone while Chapp speaks: no echo, and iOS plays the answer on the speaker, not the earpiece. */
  pause() {
    if (this.state !== 'listening') return;
    this.state = 'paused';
    this.forget();
    this.release();
  }

  resume() {
    if (this.state !== 'paused') return;
    this.state = 'listening';
    void this.open();
  }

  abort() {
    this.state = 'done';
    clearTimeout(this.quietTimer);
    this.cancel.abort();
    this.release();
    this.tap?.disconnect();
    this.tap = null;
    this.ctx?.close().catch(() => {});
    this.ctx = null;
  }

  private async open() {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      const name = (e as { name?: string } | null)?.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') return this.stop('mic-off');
      if (name === 'NotFoundError' || name === 'OverconstrainedError') return this.stop('no-mic');
      return this.stop('failed');
    }
    // Stopped or paused while the permission prompt was up.
    if (this.state !== 'listening' || !this.ctx) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    try {
      const ctx = this.ctx;
      this.tap ??= await this.makeTap(ctx);
      if (this.state !== 'listening' || this.ctx !== ctx) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      this.stream = stream;
      this.source = ctx.createMediaStreamSource(stream);
      this.source.connect(this.tap);
    } catch {
      for (const track of stream.getTracks()) track.stop();
      this.stop('unavailable');
    }
  }

  /** A node that passes each chunk of microphone samples to onChunk. It plays nothing: its output is muted. */
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

  private onChunk(chunk: Float32Array, rate: number) {
    if (this.state !== 'listening') return;
    const ms = (chunk.length / rate) * 1000;
    const gate = this.gate.push(level(chunk), ms);
    // Held, everything after the first word is kept, pauses too, until it is let go.
    if (this.mode === 'hold' && this.speech.length) {
      this.speech.push(chunk);
      this.speechMs += ms;
      if (this.speechMs >= MAX_TURN_MS) this.send(rate, false);
      return;
    }
    if (gate === 'quiet') {
      this.before.push(chunk);
      while (this.before.length > 1 && (this.before.length - 1) * ms > PREROLL_MS) this.before.shift();
      return;
    }
    if (gate === 'start') {
      clearTimeout(this.quietTimer);
      this.speech = [...this.before, chunk];
      this.before = [];
      this.speechMs = 0;
      return;
    }
    this.speech.push(chunk);
    this.speechMs += ms;
    if (gate === 'end' || this.speechMs >= MAX_TURN_MS) this.send(rate, gate === 'end');
  }

  /** Sends this turn's recording to be transcribed. A tap or a hold closes the microphone first: there is nothing more to hear. */
  private send(rate: number, endedByPause: boolean) {
    let samples = concat(this.speech);
    this.forget();
    if (endedByPause) samples = samples.subarray(0, Math.max(0, samples.length - Math.round(((SILENCE_MS - TAIL_MS) / 1000) * rate)));
    const wav = toWav(samples, rate);
    if (this.mode !== 'talk') {
      this.state = 'sending';
      this.release();
    }
    this.queue = this.queue.then(async () => {
      let text: string;
      try {
        text = (await this.transcribe(wav, this.cancel.signal)).trim();
      } catch {
        if (this.state === 'done') return;
        if (this.mode !== 'talk') this.stop('failed');
        else this.events.warn('failed');
        return;
      }
      if (this.state === 'done') return;
      if (text) this.events.turn(text);
      if (this.mode !== 'talk') this.stop(text ? undefined : 'failed');
    });
  }

  /** Drops the words of this turn (the room's level is kept). */
  private forget() {
    this.gate.reset();
    this.before = [];
    this.speech = [];
    this.speechMs = 0;
  }

  /** Closes the microphone (the red dot goes away); the audio context stays for the next turn. */
  private release() {
    this.source?.disconnect();
    this.source = null;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
  }

  private stop(problem?: Problem) {
    if (this.state === 'done') return;
    this.abort();
    this.events.end(problem);
  }
}
