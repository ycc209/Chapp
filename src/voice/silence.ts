/**
 * Tells speech from quiet by loudness, for the server engine, which has no recognizer to say when a sentence ends.
 * The quiet level adapts to the room (a hood fan, a shaker), so speech is anything clearly above it.
 */
export type GateOptions = {
  /** Quiet after speech that ends the turn. */
  endAfterMs: number;
  /** Loud this long before it counts as speech, so a click or a bump does not. */
  startAfterMs?: number;
  /** Speech is never quieter than this RMS level, however quiet the room. */
  floor?: number;
};

export type Gate = 'quiet' | 'start' | 'speech' | 'end';

/** The room is never assumed louder than this, so a voice still gets through. */
const MAX_NOISE = 0.05;
/** A level that does not dip once in this long is not a voice: a fan or a vortexer came on. */
const STEADY_MS = 2000;

export class SpeechGate {
  /** Speech has started and has not ended yet. */
  speaking = false;
  /** Some speech was heard since the last reset. */
  heard = false;
  private noise = 0.003;
  private loudMs = 0;
  private quietMs = 0;
  private windowMs = 0;
  private windowLow = Infinity;
  private readonly endAfterMs: number;
  private readonly startAfterMs: number;
  private readonly floor: number;

  constructor({ endAfterMs, startAfterMs = 120, floor = 0.012 }: GateOptions) {
    this.endAfterMs = endAfterMs;
    this.startAfterMs = startAfterMs;
    this.floor = floor;
  }

  /** Feeds the level of the next `ms` of audio; says whether speech started, goes on or ended. */
  push(level: number, ms: number): Gate {
    this.windowLow = Math.min(this.windowLow, level);
    this.windowMs += ms;
    if (this.windowMs >= STEADY_MS) {
      if (this.windowLow > this.threshold()) this.noise = Math.min(MAX_NOISE, this.windowLow);
      this.windowMs = 0;
      this.windowLow = Infinity;
    }
    const loud = level > this.threshold();
    if (loud) {
      this.loudMs += ms;
      this.quietMs = 0;
      if (!this.speaking && this.loudMs >= this.startAfterMs) {
        this.speaking = true;
        this.heard = true;
        return 'start';
      }
      return this.speaking ? 'speech' : 'quiet';
    }
    this.loudMs = 0;
    if (!this.speaking) {
      // Learn the room while nobody speaks.
      this.noise = Math.min(MAX_NOISE, this.noise * 0.95 + level * 0.05);
      return 'quiet';
    }
    this.quietMs += ms;
    if (this.quietMs >= this.endAfterMs) {
      this.speaking = false;
      this.quietMs = 0;
      return 'end';
    }
    return 'speech';
  }

  private threshold() {
    return Math.max(this.floor, this.noise * 3);
  }

  /** Starts a new turn; keeps what it learned about the room. */
  reset() {
    this.speaking = false;
    this.heard = false;
    this.loudMs = 0;
    this.quietMs = 0;
  }
}
