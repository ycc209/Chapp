/**
 * Reads Chapp's answers aloud with the browser's own voices (speechSynthesis): free, instant and offline on phones.
 * While it speaks, `isSpeaking` is true and the microphone pauses, so Chapp does not hear itself.
 *
 * Chapp is silent for now (VOICE_OUTPUT): speak() and primeSpeech() do nothing, so no screen makes a sound. Turning
 * the flag on brings every spoken answer back as it was.
 */

/** Whether Chapp reads its answers aloud. Off: the user asked for no sound at all (2026-10-29). */
export const VOICE_OUTPUT = false;

/** A value others can read and watch. */
export type Signal<T> = { get(): T; subscribe(listener: (value: T) => void): () => void };

function signal<T>(initial: T) {
  let value = initial;
  const listeners = new Set<(value: T) => void>();
  return {
    get: () => value,
    set(next: T) {
      if (next === value) return;
      value = next;
      for (const listener of [...listeners]) listener(next);
    },
    subscribe(listener: (value: T) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

const speaking = signal(false);
/** True from the moment Chapp starts reading an answer until it stops. */
export const isSpeaking: Signal<boolean> = speaking;

const synth = () => (typeof speechSynthesis === 'undefined' ? null : speechSynthesis);

/** Ends the answer being read, if any. Its speak() promise resolves. */
export function stopSpeaking() {
  generation++;
  const finish = finishCurrent;
  finishCurrent = null;
  synth()?.cancel();
  finish?.();
}

// The utterance being read. Kept here because Chrome drops 'end' for utterances nothing references any more.
let current: SpeechSynthesisUtterance | null = null;
let finishCurrent: (() => void) | null = null;
/** Counts speak() and stopSpeaking() calls, so a reply that was waiting for voices knows it was overtaken. */
let generation = 0;

/** Reads `text` aloud, cutting off anything already being read; resolves when done, also when it fails. */
export async function speak(text: string): Promise<void> {
  if (!VOICE_OUTPUT) return;
  const s = synth();
  const busy = Boolean(s && (s.speaking || s.pending));
  stopSpeaking();
  const mine = ++generation;
  const words = text.trim();
  if (!s || !words) return;
  const lang = mostlyCjk(words) ? 'zh-TW' : 'en-US';
  const voice = pickVoice(await voices(s), lang);
  // Chrome drops an utterance queued in the same moment as cancel().
  if (busy) await new Promise(r => setTimeout(r, 60));
  if (mine !== generation) return;
  return new Promise(resolve => {
    const u = new SpeechSynthesisUtterance(words);
    u.lang = voice?.lang ?? lang;
    if (voice) u.voice = voice;
    let guard = 0;
    const finish = () => {
      clearTimeout(guard);
      if (current === u) {
        current = null;
        finishCurrent = null;
        speaking.set(false);
      }
      resolve();
    };
    u.onend = finish;
    u.onerror = finish;
    // Some engines never send 'end' (Chrome after ~15 s, a voice that fails to load): give up well after it should be done.
    guard = window.setTimeout(finish, 4000 + words.length * 110);
    current = u;
    finishCurrent = finish;
    speaking.set(true);
    s.speak(u);
  });
}

/**
 * iOS speaks only after the user has touched the page once; its first utterance has to start inside a touch.
 * The bar calls this on every press so the reply, which arrives later, can be read aloud.
 */
let primed = false;
export function primeSpeech() {
  const s = synth();
  if (!VOICE_OUTPUT || primed || !s) return;
  primed = true;
  const u = new SpeechSynthesisUtterance(' ');
  u.volume = 0;
  s.speak(u);
}

/** The voice list arrives late in Chrome; waits for it briefly. */
function voices(s: SpeechSynthesis): Promise<SpeechSynthesisVoice[]> {
  const now = s.getVoices();
  if (now.length) return Promise.resolve(now);
  return new Promise(resolve => {
    const done = () => {
      s.removeEventListener('voiceschanged', done);
      clearTimeout(timer);
      resolve(s.getVoices());
    };
    const timer = setTimeout(done, 600);
    s.addEventListener('voiceschanged', done);
  });
}

/** Text is read in Mandarin when its Han characters outweigh its Latin words (one character ≈ one word). */
export function mostlyCjk(text: string): boolean {
  const han = text.match(/[㐀-鿿豈-﫿]/g)?.length ?? 0;
  const latin = text.match(/[A-Za-z]/g)?.length ?? 0;
  return han > 0 && han * 3 >= latin;
}

/** Natural voices first, by name, as Apple, Google and Microsoft call them. */
const PREFERRED: Record<string, string[]> = {
  'en-US': [
    'Ava (Premium)', 'Zoe (Premium)', 'Ava (Enhanced)', 'Samantha (Enhanced)', 'Zoe (Enhanced)', 'Ava', 'Samantha',
    'Google US English', 'Microsoft Ava Online (Natural)', 'Microsoft Aria Online (Natural)', 'Microsoft Jenny Online (Natural)',
    'Allison', 'Susan', 'Zoe',
  ],
  'zh-TW': ['Meijia (Premium)', 'Meijia (Enhanced)', 'Meijia', '美佳', 'Google 國語（臺灣）', 'Microsoft HsiaoChen Online (Natural)', 'Microsoft HsiaoYu Online (Natural)'],
};
/** macOS's novelty voices are tagged en-US too; never pick them by accident. */
const NOVELTY = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Junior|Ralph|Fred|Kathy)\b/;

type VoiceLike = Pick<SpeechSynthesisVoice, 'name' | 'lang' | 'localService' | 'default'>;

/** The best voice for `lang` among those installed, or null to let the browser choose by language. */
export function pickVoice<V extends VoiceLike>(all: readonly V[], lang: 'en-US' | 'zh-TW'): V | null {
  const tag = (v: VoiceLike) => v.lang.replace('_', '-').toLowerCase();
  const want = lang.toLowerCase();
  const same = all.filter(v => tag(v) === want && !NOVELTY.test(v.name));
  for (const name of PREFERRED[lang]!) {
    const hit = same.find(v => v.name === name) ?? all.find(v => v.name === name);
    if (hit) return hit;
  }
  const natural = same.find(v => /premium|enhanced|natural|neural/i.test(v.name));
  if (natural) return natural;
  const local = same.find(v => v.localService) ?? same[0];
  if (local) return local;
  // No zh-TW voice: any Mandarin voice still reads traditional characters.
  if (lang === 'zh-TW') return all.find(v => /^zh[-_](cn|hans|sg)/i.test(v.lang)) ?? all.find(v => /^zh/i.test(v.lang)) ?? null;
  return null;
}
