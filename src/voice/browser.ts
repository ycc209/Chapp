import { LISTEN_LANG, NO_SPEECH_MS, SILENCE_MS, type Engine, type EngineEvents, type Mode, type Problem } from './engine.ts';

// The Web Speech API is not in TypeScript's DOM types (Chrome and Safari ship it prefixed); just the parts used here.
type Alternative = { readonly transcript: string };
type Result = { readonly isFinal: boolean; readonly length: number; readonly [index: number]: Alternative | undefined };
type ResultEvent = { readonly results: { readonly length: number; readonly [index: number]: Result | undefined } };
type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: ResultEvent) => void) | null;
  onerror: ((event: { readonly error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};
type RecognitionClass = new () => Recognition;

/** The browser's speech recognizer, or null when it has none (Firefox, some in-app browsers). */
export function recognitionClass(): RecognitionClass | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: RecognitionClass; webkitSpeechRecognition?: RecognitionClass };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * Joins the recognizer's settled pieces. Chrome on Android repeats the whole sentence so far in each new piece, and
 * sometimes sends a piece twice; both would otherwise show the words twice.
 */
export function joinFinals(parts: readonly string[]): string {
  let out = '';
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    const had = out.toLowerCase();
    const next = part.toLowerCase();
    if (next.startsWith(had)) out = part;
    else if (!had.endsWith(next)) out = `${out} ${part}`;
  }
  return out;
}

export const joinWords = (...parts: string[]) => parts.map(p => p.trim()).filter(Boolean).join(' ');

/**
 * Hears with the browser's recognizer: words appear while the user speaks. A turn ends after a pause (the recognizer
 * keeps going in continuous mode, so the pause is timed here). In talk mode a fresh recognizer starts for each turn,
 * which also clears the words of the last one.
 */
export class BrowserEngine implements Engine {
  private mode: Mode;
  private readonly events: EngineEvents;
  private readonly lang: string;
  private rec: Recognition | null = null;
  private settled = '';
  private interim = '';
  /** A hold's words from recognizers that already stopped by themselves (Safari stops after each sentence). */
  private kept = '';
  private state: 'listening' | 'paused' | 'done' = 'listening';
  /** The turn is over; waiting for the recognizer's last words before handing it over. */
  private closing = false;
  private silenceTimer = 0;
  private quietTimer = 0;
  private closeTimer = 0;
  private restarts: number[] = [];

  constructor(mode: Mode, events: EngineEvents, lang = LISTEN_LANG) {
    this.mode = mode;
    this.events = events;
    this.lang = lang;
  }

  start() {
    if (!window.isSecureContext) return this.stop('insecure');
    if (this.mode === 'tap') this.quietTimer = window.setTimeout(() => this.stop('no-speech'), NO_SPEECH_MS);
    this.listen();
  }

  finish() {
    if (this.state === 'done') return;
    if (this.mode !== 'talk' && this.text()) this.endTurn();
    else this.stop();
  }

  toTap() {
    if (this.mode !== 'hold' || this.state === 'done') return;
    this.mode = 'tap';
    if (this.text()) this.silenceTimer = window.setTimeout(() => this.endTurn(), SILENCE_MS);
    else this.quietTimer = window.setTimeout(() => this.stop('no-speech'), NO_SPEECH_MS);
  }

  pause() {
    if (this.state !== 'listening') return;
    this.state = 'paused';
    this.drop();
    this.events.heard('', '');
  }

  resume() {
    if (this.state !== 'paused') return;
    this.state = 'listening';
    this.listen();
  }

  abort() {
    this.state = 'done';
    clearTimeout(this.quietTimer);
    this.drop();
  }

  private listen() {
    const Recognition = recognitionClass();
    if (!Recognition) return this.stop('unavailable');
    const rec = new Recognition();
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    // A recognizer replaced by a newer one may still send events; only the current one counts.
    rec.onresult = e => rec === this.rec && this.onResult(e);
    rec.onerror = e => rec === this.rec && this.onError(e.error);
    rec.onend = () => rec === this.rec && this.onEnd();
    this.rec = rec;
    this.settled = '';
    this.interim = '';
    this.closing = false;
    try {
      rec.start();
    } catch {
      this.stop('failed');
    }
  }

  private onResult(e: ResultEvent) {
    const finals: string[] = [];
    let interim = '';
    for (let i = 0; i < e.results.length; i++) {
      const result = e.results[i];
      const words = result?.[0]?.transcript ?? '';
      if (result?.isFinal) finals.push(words);
      else interim += words;
    }
    this.settled = joinFinals(finals);
    this.interim = interim.trim();
    this.events.heard(joinWords(this.kept, this.settled), this.interim);
    if (!this.text() || this.closing) return;
    clearTimeout(this.quietTimer);
    // Held, a pause does not end the turn: letting go does.
    if (this.mode === 'hold') return;
    clearTimeout(this.silenceTimer);
    // Settled words mean the recognizer already heard a short pause, so less of the pause is left to wait for.
    this.silenceTimer = window.setTimeout(() => this.endTurn(), this.interim ? SILENCE_MS : SILENCE_MS - 500);
  }

  private onError(error: string) {
    switch (error) {
      case 'aborted':
        return;
      case 'no-speech':
        // Hold and talk modes just listen again (onend follows).
        if (this.mode === 'tap' && !this.text()) this.stop('no-speech');
        return;
      case 'not-allowed':
        return this.stop(window.isSecureContext ? 'mic-off' : 'insecure');
      case 'audio-capture':
        return this.stop('no-mic');
      case 'service-not-allowed':
      case 'language-not-supported':
        return this.stop('unavailable');
      case 'network':
        return this.stop('network');
      default:
        if (this.mode !== 'talk') this.stop('failed');
    }
  }

  private onEnd() {
    if (this.closing) return this.deliver();
    if (this.state !== 'listening') return;
    // The recognizer stopped by itself: Safari after a sentence, Chrome after a long silence or a minute. Held, the
    // words so far are kept and it listens on.
    if (this.mode === 'hold') this.kept = this.text();
    else if (this.text()) return this.deliver();
    if (this.mode === 'tap') return this.stop('no-speech');
    const now = Date.now();
    this.restarts = [...this.restarts.filter(t => now - t < 10000), now];
    if (this.restarts.length > 5) return this.stop('failed');
    this.listen();
  }

  /** Asks the recognizer for its last words; hands the turn over when they arrive (or after a second). */
  private endTurn() {
    if (this.closing || this.state !== 'listening') return;
    this.closing = true;
    clearTimeout(this.silenceTimer);
    try {
      this.rec?.stop();
    } catch {
      // Already stopped: onend has fired or will.
    }
    this.closeTimer = window.setTimeout(() => this.deliver(), 1000);
  }

  private deliver() {
    const text = this.text();
    this.drop();
    if (this.state !== 'listening') return;
    if (text) this.events.turn(text);
    // The turn's handler may have ended the conversation.
    if (this.state !== 'listening') return;
    if (this.mode === 'talk') this.listen();
    else this.stop();
  }

  /** Lets go of the recognizer and the words of this turn. */
  private drop() {
    clearTimeout(this.silenceTimer);
    clearTimeout(this.closeTimer);
    const rec = this.rec;
    this.rec = null;
    this.closing = false;
    this.settled = '';
    this.interim = '';
    this.kept = '';
    try {
      rec?.abort();
    } catch {
      // Not started yet.
    }
  }

  private stop(problem?: Problem) {
    if (this.state === 'done') return;
    this.abort();
    this.events.end(problem);
  }

  private text() {
    return joinWords(this.kept, this.settled, this.interim);
  }
}
