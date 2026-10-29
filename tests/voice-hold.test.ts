import { existsSync, readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Protocol } from '../shared/protocol.ts';

// Hold to talk and the silent Chapp, on a fake browser recognizer: no microphone, no network, no sound.

type Result = { isFinal: boolean; 0: { transcript: string }; length: 1 };
/** Stands in for the browser's SpeechRecognition: the test says what it hears, when it stops, when it ends. */
class FakeRecognition {
  static all: FakeRecognition[] = [];
  lang = '';
  continuous = false;
  interimResults = false;
  maxAlternatives = 1;
  onresult: ((e: { results: Result[] }) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  started = false;
  results: Result[] = [];
  constructor() {
    FakeRecognition.all.push(this);
  }
  start() {
    this.started = true;
  }
  stop() {
    queueMicrotask(() => this.onend?.());
  }
  abort() {
    this.started = false;
  }
  /** Words heard: settled ones, then the ones still changing. */
  hear(settled: string[], interim = '') {
    this.results = [...settled.map(t => ({ isFinal: true, 0: { transcript: t }, length: 1 as const })), ...(interim ? [{ isFinal: false, 0: { transcript: interim }, length: 1 as const }] : [])];
    this.onresult?.({ results: this.results });
  }
}
const latest = () => FakeRecognition.all.at(-1)!;

let controller: typeof import('../src/voice/controller.ts');
let session: typeof import('../src/state/session.ts');
let speak: typeof import('../src/voice/speak.ts');

beforeAll(async () => {
  vi.useFakeTimers();
  const said: string[] = [];
  const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  vi.stubGlobal('window', { isSecureContext: true, SpeechRecognition: FakeRecognition, setTimeout, clearTimeout, localStorage: storage });
  vi.stubGlobal('localStorage', { getItem: () => 'browser', setItem: () => {} });
  // Chapp must never speak: a speechSynthesis that records anything it is asked to say.
  vi.stubGlobal('speechSynthesis', { speaking: false, pending: false, cancel: () => {}, speak: (u: { text: string }) => said.push(u.text), getVoices: () => [] });
  vi.stubGlobal('SpeechSynthesisUtterance', class { text: string; constructor(t: string) { this.text = t; } });
  (globalThis as Record<string, unknown>).said = said;
  session = await import('../src/state/session.ts');
  controller = await import('../src/voice/controller.ts');
  speak = await import('../src/voice/speak.ts');
});
afterEach(() => {
  controller.endConversation();
  vi.clearAllTimers();
});
afterAll(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Registers a handler for the turns, as a mounted bar does. */
function turns() {
  const got: string[] = [];
  const detach = controller.attachHandler(t => got.push(t));
  return { got, detach };
}

describe('hold to talk', () => {
  it('listens while held, keeps going over a pause, and sends everything when let go', async () => {
    const { got, detach } = turns();
    controller.startListening('hold');
    expect(session.useSession.getState().voice).toBe('holding');
    latest().hear(['Make it'], 'triplic');
    expect(session.useSession.getState()).toMatchObject({ heard: 'Make it', interim: 'triplic' });
    latest().hear(['Make it', 'triplicates']);
    // A long pause would end a tap; held, it does not.
    vi.advanceTimersByTime(5000);
    expect(got).toEqual([]);
    expect(session.useSession.getState().voice).toBe('holding');
    controller.finishListening();
    await vi.advanceTimersByTimeAsync(0);
    expect(got).toEqual(['Make it triplicates']);
    expect(session.useSession.getState().voice).toBe('idle');
    detach();
  });

  it('keeps the words when the recognizer stops by itself mid-hold (Safari, after a sentence)', async () => {
    const { got, detach } = turns();
    controller.startListening('hold');
    const first = latest();
    first.hear(['12 samples.']);
    first.onend?.();
    expect(latest()).not.toBe(first);
    latest().hear(['In duplicate.']);
    expect(session.useSession.getState().heard).toBe('12 samples. In duplicate.');
    controller.finishListening();
    await vi.advanceTimersByTimeAsync(0);
    expect(got).toEqual(['12 samples. In duplicate.']);
    detach();
  });

  it('sends nothing when slid up to cancel, or when nothing was heard', async () => {
    const { got, detach } = turns();
    controller.startListening('hold');
    latest().hear(['Start the timer']);
    controller.cancelListening();
    controller.startListening('hold');
    controller.finishListening();
    await vi.advanceTimersByTimeAsync(2000);
    expect(got).toEqual([]);
    expect(session.useSession.getState().voice).toBe('idle');
    detach();
  });

  it('turns into a tap when let go too soon: listening goes on until the next pause', async () => {
    const { got, detach } = turns();
    controller.startListening('hold');
    controller.holdWasTap();
    expect(session.useSession.getState().voice).toBe('listening');
    latest().hear(['next']);
    await vi.advanceTimersByTimeAsync(2000);
    expect(got).toEqual(['next']);
    expect(session.useSession.getState().voice).toBe('idle');
    detach();
  });

  it('fixes lab words in what it hands over', async () => {
    const { got, detach } = turns();
    controller.startListening('hold');
    latest().hear(['I just got a pierced BCA protein acetate kit']);
    controller.finishListening();
    await vi.advanceTimersByTimeAsync(0);
    expect(got).toEqual(['I just got a Pierce BCA protein assay kit']);
    detach();
  });
});

describe('the conversation', () => {
  it('listens turn after turn until it is ended', async () => {
    const { got, detach } = turns();
    controller.startListening('talk');
    expect(session.useSession.getState().voice).toBe('talking');
    latest().hear(['12 samples']);
    await vi.advanceTimersByTimeAsync(2000);
    latest().hear(['make it triplicates']);
    await vi.advanceTimersByTimeAsync(2000);
    expect(got).toEqual(['12 samples', 'make it triplicates']);
    expect(session.useSession.getState().voice).toBe('talking');
    controller.endConversation();
    expect(session.useSession.getState().voice).toBe('idle');
    detach();
  });
});

describe('silence', () => {
  it('never speaks: speak() and primeSpeech() do nothing while VOICE_OUTPUT is off', async () => {
    expect(speak.VOICE_OUTPUT).toBe(false);
    speak.primeSpeech();
    await speak.speak('Starting your 30 minute timer.');
    expect((globalThis as Record<string, unknown>).said).toEqual([]);
    expect(speak.isSpeaking.get()).toBe(false);
  });
});

describe('what the conversation says it changed', () => {
  const file = new URL('../data/protocols/pierce-bca.json', import.meta.url);
  const bca = existsSync(file) ? Protocol.parse(JSON.parse(readFileSync(file, 'utf8'))) : null;

  it('reads each change back from the run, as the screens show it', async () => {
    const { doneLine, GO_LABELS } = await import('../src/screens/chat/useChat.ts');
    const { useRun } = await import('../src/state/run.ts');
    useRun.setState({ protocolId: 'pierce-bca', procedure: 'microplate', step: 2 });
    expect(doneLine({ type: 'setSamples', samples: 12 }, bca)).toBe('Samples: 12');
    expect(doneLine({ type: 'setReplicates', replicates: 3 }, bca)).toBe('Replicates: ×3, standards too');
    expect(doneLine({ type: 'startTimer', id: 'm-incubate', seconds: 1800 }, bca)).toBe('Timer started · 30 min');
    expect(doneLine({ type: 'markDone', id: 'A' }, bca)).toBe('A is done');
    expect(doneLine({ type: 'nextStep' }, bca)).toBe(bca ? 'Step 3 of 6 · Load the plate' : 'Next step');
    // Going somewhere and looking a kit up are not changes to the run: they become a button and a search.
    expect(doneLine({ type: 'navigate', to: '/plan' }, bca)).toBeNull();
    expect(doneLine({ type: 'findProtocol', query: 'Bradford' }, bca)).toBeNull();
    expect(GO_LABELS['/plan']).toBe('Open the plan');
  });
});
