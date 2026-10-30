import { MAX_TURN_MS, NO_SPEECH_MS, type Engine, type EngineEvents, type Mode, type Problem } from './engine.ts';
import { Microphone } from './mic.ts';
import { toPcm16 } from './wav.ts';

/** Audio kept while the connection opens, so the first word is not lost (ms); older audio goes. */
const EARLY_MS = 3000;
/** After the user is done, how long the last words may take before the turn goes without them. */
const CLOSING_MS = 4000;

/** What the server passes on from Muse Voice Transcribe (server/live.ts), Chinese already as Taiwan writes it. */
export type LiveEvent = { type?: string; transcript?: string; final?: boolean };

/**
 * Hears live through the server (WebSocket /api/voice/live → Muse Voice Transcribe's realtime endpoint): the
 * microphone streams as the user speaks, the words show as they are heard, and the model decides when a turn is over
 * (speechComplete), not a loudness threshold. tap: the first finished turn · hold: every turn until it is let go,
 * joined · talk: each finished turn, until the conversation ends. If the connection cannot be made it ends with
 * 'network', and the controller records turns instead (server.ts).
 */
export class LiveEngine implements Engine {
  private mode: Mode;
  private readonly events: EngineEvents;
  private readonly mic = new Microphone((chunk, rate) => this.onChunk(chunk, rate));
  private socket: WebSocket | null = null;
  private state: 'listening' | 'paused' | 'closing' | 'done' = 'listening';
  private early: ArrayBuffer[] = [];
  private earlyMs = 0;
  /** This turn's finished pieces (a hold may have several) and the one still being heard. */
  private said: string[] = [];
  private hearing = '';
  private heardAny = false;
  private heldMs = 0;
  private quietTimer = 0;
  private closingTimer = 0;

  constructor(mode: Mode, events: EngineEvents) {
    this.mode = mode;
    this.events = events;
  }

  start() {
    const problem = this.mic.begin();
    if (problem) return this.stop(problem);
    if (this.mode === 'tap') this.quietTimer = window.setTimeout(() => this.stop('no-speech'), NO_SPEECH_MS);
    this.connect();
    void this.open();
  }

  finish() {
    if (this.state !== 'listening') return;
    if (this.mode === 'talk' || (!this.heardAny && !this.said.length)) return this.stop();
    this.wrapUp();
  }

  toTap() {
    if (this.mode !== 'hold' || this.state !== 'listening') return;
    this.mode = 'tap';
    // A turn already finished while it was held: that was the pause that ends a tap.
    if (this.said.length && !this.hearing) return this.deliver();
    if (!this.heardAny) this.quietTimer = window.setTimeout(() => this.stop('no-speech'), NO_SPEECH_MS);
  }

  /** Chapp is about to speak: the microphone and the stream go, and come back fresh afterwards. */
  pause() {
    if (this.state !== 'listening') return;
    this.state = 'paused';
    this.mic.release();
    this.hangUp();
    this.said = [];
    this.hearing = '';
  }

  resume() {
    if (this.state !== 'paused') return;
    this.state = 'listening';
    this.connect();
    void this.open();
  }

  abort() {
    this.state = 'done';
    clearTimeout(this.quietTimer);
    clearTimeout(this.closingTimer);
    this.mic.close();
    this.hangUp();
  }

  private connect() {
    let socket: WebSocket;
    try {
      socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/voice/live`);
    } catch {
      return this.stop('network');
    }
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    socket.onopen = () => {
      for (const chunk of this.early) socket.send(chunk);
      this.early = [];
      this.earlyMs = 0;
    };
    socket.onmessage = e => {
      if (typeof e.data !== 'string') return;
      try {
        this.onEvent(JSON.parse(e.data) as LiveEvent);
      } catch {
        // Not an event: nothing to do with it.
      }
    };
    socket.onclose = () => this.onClose(socket);
  }

  private async open() {
    const problem = await this.mic.open(() => this.state === 'listening');
    if (problem) this.stop(problem);
  }

  private onChunk(chunk: Float32Array, rate: number) {
    if (this.state !== 'listening') return;
    const ms = (chunk.length / rate) * 1000;
    const pcm = toPcm16(chunk, rate);
    const socket = this.socket;
    if (socket?.readyState === WebSocket.OPEN) socket.send(pcm);
    else if (socket?.readyState === WebSocket.CONNECTING) {
      this.early.push(pcm);
      this.earlyMs += ms;
      while (this.earlyMs > EARLY_MS && this.early.length > 1) {
        this.early.shift();
        this.earlyMs -= ms;
      }
    }
    if (this.mode === 'hold' && this.heardAny && (this.heldMs += ms) >= MAX_TURN_MS) this.wrapUp();
  }

  private onEvent(event: LiveEvent) {
    if (this.state === 'done' || this.state === 'paused') return;
    if (event.type === 'speechStart') {
      this.heardAny = true;
      clearTimeout(this.quietTimer);
    } else if (event.type === 'transcript' && !event.final) {
      this.hearing = (event.transcript ?? '').trim();
      if (this.hearing) {
        this.heardAny = true;
        clearTimeout(this.quietTimer);
      }
      this.show();
    } else if (event.type === 'speechComplete') {
      const text = (event.transcript ?? '').trim();
      this.hearing = '';
      if (text) this.said.push(text);
      if (this.state === 'closing') return this.show();
      if (this.mode === 'tap') return this.deliver();
      if (this.mode === 'talk') {
        const turn = this.said.join(' ');
        this.said = [];
        this.show();
        if (turn) this.events.turn(turn);
        return;
      }
      this.show();
    } else if (event.type === 'error') {
      if (!this.said.length && !this.hearing) return this.stop('failed');
      this.events.warn('failed');
    }
  }

  private onClose(socket: WebSocket) {
    if (socket !== this.socket) return;
    this.socket = null;
    if (this.state === 'closing') return this.deliver();
    if (this.state !== 'listening') return;
    // Cut off before a word came back: no live speech here (no server for it, or a proxy without WebSockets).
    if (!this.heardAny && !this.said.length) return this.stop('network');
    if (this.mode === 'talk') return this.stop('network');
    this.deliver();
  }

  private show() {
    this.events.heard(this.said.join(' '), this.hearing);
  }

  /** The user is done (a tap, a hold let go): the microphone closes and the last words are waited for. */
  private wrapUp() {
    this.state = 'closing';
    this.mic.release();
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) return this.deliver();
    socket.send(JSON.stringify({ type: 'endStream' }));
    this.closingTimer = window.setTimeout(() => this.deliver(), CLOSING_MS);
  }

  /** A tap's or a hold's words go, and the engine stops. */
  private deliver() {
    if (this.state === 'done') return;
    const text = [...this.said, this.hearing].filter(Boolean).join(' ').trim();
    this.said = [];
    this.hearing = '';
    if (text) this.events.turn(text);
    this.stop(text ? undefined : 'failed');
  }

  private hangUp() {
    const socket = this.socket;
    this.socket = null;
    this.early = [];
    this.earlyMs = 0;
    if (!socket) return;
    socket.onopen = socket.onmessage = socket.onclose = null;
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'endStream' }));
    socket.close();
  }

  private stop(problem?: Problem) {
    if (this.state === 'done') return;
    this.abort();
    this.events.end(problem);
  }
}
