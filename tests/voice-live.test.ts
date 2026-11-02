import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// Live speech on a fake relay: no microphone, no network, no sound. What the phone's engine makes of the partial
// transcripts, and when it takes the words as the turn.

class FakeSocket {
  static all: FakeSocket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = 0;
  binaryType = '';
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() {
    FakeSocket.all.push(this);
  }
  send(data: unknown) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  emit(event: object) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
  get texts() {
    return this.sent.filter((d): d is string => typeof d === 'string');
  }
}
vi.mock('../src/voice/mic.ts', () => ({
  Microphone: class {
    begin() { return null; }
    open() { return Promise.resolve(null); }
    release() {}
    close() {}
  },
}));

let controller: typeof import('../src/voice/controller.ts');
let session: typeof import('../src/state/session.ts');
let engine: typeof import('../src/voice/engine.ts');

beforeAll(async () => {
  vi.useFakeTimers();
  const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  vi.stubGlobal('window', { isSecureContext: true, setTimeout, clearTimeout, localStorage: storage });
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('location', { protocol: 'https:', host: 'chapp.test', search: '' });
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('speechSynthesis', { speaking: false, pending: false, cancel: () => {}, speak: () => {}, getVoices: () => [] });
  vi.stubGlobal('SpeechSynthesisUtterance', class { text: string; constructor(t: string) { this.text = t; } });
  session = await import('../src/state/session.ts');
  controller = await import('../src/voice/controller.ts');
  engine = await import('../src/voice/engine.ts');
});
afterEach(() => {
  controller.endConversation();
  vi.clearAllTimers();
  FakeSocket.all.length = 0;
});
afterAll(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const latest = () => FakeSocket.all.at(-1)!;
function turns() {
  const got: string[] = [];
  const detach = controller.attachHandler(t => got.push(t));
  return { got, detach };
}
async function listen(mode: 'tap' | 'hold' | 'talk') {
  controller.startListening(mode);
  await vi.advanceTimersByTimeAsync(0);
  latest().open();
}

describe('live speech', () => {
  it('hands settled words on early, then takes a bare command as the turn without waiting for the transcriber', async () => {
    const { got, detach } = turns();
    const prepared: string[] = [];
    const unprepare = controller.attachPreparer(t => prepared.push(t));
    await listen('tap');
    latest().emit({ type: 'speechStart' });
    latest().emit({ type: 'transcript', transcript: '下一', final: false });
    latest().emit({ type: 'transcript', transcript: '下一步，', final: false });
    expect(session.useSession.getState().interim).toBe('下一步，');
    await vi.advanceTimersByTimeAsync(engine.STABLE_MS);
    expect(prepared).toEqual(['下一步，']);
    expect(got).toEqual([]);
    await vi.advanceTimersByTimeAsync(engine.COMMIT_MS - engine.STABLE_MS);
    expect(got).toEqual(['下一步，']);
    expect(session.useSession.getState().voice).toBe('idle');
    expect(latest().texts).toContain(JSON.stringify({ type: 'endStream' }));
    unprepare();
    detach();
  });

  it('sends a sentence the transcriber closes itself once only', async () => {
    const { got, detach } = turns();
    await listen('tap');
    latest().emit({ type: 'transcript', transcript: '好，下一步。', final: false });
    await vi.advanceTimersByTimeAsync(200);
    latest().emit({ type: 'speechComplete', transcript: '好，下一步。' });
    await vi.advanceTimersByTimeAsync(engine.COMMIT_MS);
    expect(got).toEqual(['好，下一步。']);
    detach();
  });

  it('in a conversation, never sends committed words twice, and sends what the transcriber heard after them', async () => {
    const { got, detach } = turns();
    await listen('talk');
    latest().emit({ type: 'transcript', transcript: '下一步', final: false });
    await vi.advanceTimersByTimeAsync(engine.COMMIT_MS);
    expect(got).toEqual(['下一步']);
    expect(session.useSession.getState().voice).toBe('talking');
    latest().emit({ type: 'speechStart' });
    latest().emit({ type: 'transcript', transcript: '下一步，開始計', final: false });
    expect(session.useSession.getState().interim).toBe('開始計');
    latest().emit({ type: 'speechComplete', transcript: '下一步，開始計時。' });
    await vi.advanceTimersByTimeAsync(0);
    expect(got).toEqual(['下一步', '開始計時。']);
    latest().emit({ type: 'transcript', transcript: 'next step', final: false });
    await vi.advanceTimersByTimeAsync(engine.COMMIT_MS);
    latest().emit({ type: 'speechComplete', transcript: 'Next step,' });
    await vi.advanceTimersByTimeAsync(0);
    expect(got).toEqual(['下一步', '開始計時。', 'next step']);
    detach();
  });

  it('while held, waits to be let go whatever the pause', async () => {
    const { got, detach } = turns();
    await listen('hold');
    latest().emit({ type: 'transcript', transcript: '下一步', final: false });
    await vi.advanceTimersByTimeAsync(5000);
    expect(got).toEqual([]);
    controller.finishListening();
    expect(latest().texts).toContain(JSON.stringify({ type: 'endStream' }));
    latest().emit({ type: 'speechComplete', transcript: '下一步。' });
    // The relay closes the stream once the last words are out; the turn goes then.
    latest().onclose?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(got).toEqual(['下一步。']);
    detach();
  });
});
