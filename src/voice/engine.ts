/**
 * The two ways Chapp hears: the browser's own speech recognition (live words, free) or the server's (records a WAV
 * and sends it to POST /api/voice, which the Meta model transcribes). Both follow the same small contract, so the
 * controller does not care which one runs.
 */

/** What Chapp listens in. One constant, so a zh-TW setting can switch it later. */
export const LISTEN_LANG = 'en-US';

/** Quiet after speech that ends a turn. */
export const SILENCE_MS = 1200;
/** A tap that hears nothing at all gives up after this long. */
export const NO_SPEECH_MS = 8000;
/** The server engine sends a turn this long even if the speaker has not paused. */
export const MAX_TURN_MS = 30000;
/** Wait after Chapp stops talking before listening again, so the tail of its voice is not heard. */
export const AFTER_SPEAKING_MS = 300;

/**
 * tap: one thing said, then stop · hold: everything said while Tap to speak is held, sent when it is let go (a pause
 * does not end it) · talk: turn after turn until the user ends it.
 */
export type Mode = 'tap' | 'hold' | 'talk';

/** Why an engine stopped early. */
export type Problem = 'mic-off' | 'no-mic' | 'insecure' | 'unavailable' | 'network' | 'no-speech' | 'failed';

/** The line shown under Chapp's name for each problem. Plain words, no codes. */
export const PROBLEM_TEXT: Record<Problem, string> = {
  'mic-off': 'Microphone is off',
  'no-mic': 'No microphone found',
  insecure: 'Microphone needs HTTPS',
  unavailable: "Voice isn't available here",
  network: 'Voice needs a connection',
  'no-speech': "I didn't hear anything",
  failed: "Didn't catch that",
};

export type EngineEvents = {
  /** Words so far in this turn: settled, then still changing. Only the browser engine knows them before the turn ends. */
  heard(settled: string, interim: string): void;
  /** A finished turn's words. */
  turn(text: string): void;
  /** Something went wrong but the engine keeps listening (talk mode). */
  warn(problem: Problem): void;
  /** The engine has stopped for good: a tap's turn is done, or it gave up. Called once. */
  end(problem?: Problem): void;
};

export interface Engine {
  /** Opens the microphone. Call it inside the user's tap: browsers only open it for a gesture. */
  start(): void;
  /** The user tapped (or let go of a hold): tap and hold send what was said so far; talk mode drops it. */
  finish(): void;
  /** A press let go too soon to be a hold: go on as a tap, ending the turn at the next pause. */
  toTap(): void;
  /** Chapp is about to speak: stop hearing. */
  pause(): void;
  resume(): void;
  /** Stops now, delivers nothing, calls no events. */
  abort(): void;
}

export type EngineKind = 'browser' | 'server';

// Read once at startup: the router drops the query string on the first navigation.
const fromUrl = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('voice');

function fromStorage() {
  try {
    return localStorage.getItem('chapp.voice');
  } catch {
    return null;
  }
}

/** ?voice=browser|server, else localStorage chapp.voice, else the browser's recognizer when there is one. */
export function chooseEngine(hasBrowserRecognition: boolean): EngineKind {
  const wanted = fromUrl ?? fromStorage();
  if (wanted === 'browser' || wanted === 'server') return wanted;
  return hasBrowserRecognition ? 'browser' : 'server';
}
