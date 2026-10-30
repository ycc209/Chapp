import { api } from '../api/client.ts';
import { MAX_TURN_MS, NO_SPEECH_MS, SILENCE_MS, type Engine, type EngineEvents, type Mode, type Problem } from './engine.ts';
import { Microphone } from './mic.ts';
import { SpeechGate } from './silence.ts';
import { concat, level, toWav } from './wav.ts';

/** Audio kept from just before speech is detected, so the first syllable is not clipped. */
const PREROLL_MS = 400;
/** Of the closing silence, this much stays on the recording, so the last word is not clipped. */
const TAIL_MS = 300;

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
  private readonly mic = new Microphone((chunk, rate) => this.onChunk(chunk, rate));
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
    const problem = this.mic.begin();
    if (problem) return this.stop(problem);
    if (this.mode === 'tap') this.quietTimer = window.setTimeout(() => this.stop('no-speech'), NO_SPEECH_MS);
    void this.open();
  }

  finish() {
    if (this.state === 'done' || this.state === 'sending') return;
    if (this.mode !== 'talk' && this.gate.heard && this.mic.ctx) this.send(this.mic.ctx.sampleRate, false);
    else this.stop();
  }

  toTap() {
    if (this.mode !== 'hold' || this.state !== 'listening') return;
    this.mode = 'tap';
    // Already quiet after speech: that was the pause that ends a tap.
    if (this.gate.heard && !this.gate.speaking && this.mic.ctx) this.send(this.mic.ctx.sampleRate, false);
    else if (!this.gate.heard) this.quietTimer = window.setTimeout(() => this.stop('no-speech'), NO_SPEECH_MS);
  }

  /** Lets go of the microphone while Chapp speaks: no echo, and iOS plays the answer on the speaker, not the earpiece. */
  pause() {
    if (this.state !== 'listening') return;
    this.state = 'paused';
    this.forget();
    this.mic.release();
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
    this.mic.close();
  }

  private async open() {
    const problem = await this.mic.open(() => this.state === 'listening');
    if (problem) this.stop(problem);
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
      this.mic.release();
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

  private stop(problem?: Problem) {
    if (this.state === 'done') return;
    this.abort();
    this.events.end(problem);
  }
}
