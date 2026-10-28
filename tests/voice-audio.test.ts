import { describe, expect, it } from 'vitest';
import { joinFinals } from '../src/voice/browser.ts';
import { SpeechGate } from '../src/voice/silence.ts';
import { mostlyCjk, pickVoice } from '../src/voice/speak.ts';
import { downsample, encodeWav, level } from '../src/voice/wav.ts';

describe('downsample', () => {
  it('turns 48 kHz into 16 kHz by averaging each group of three', () => {
    const out = downsample(Float32Array.from([0, 0.3, 0.6, 1, 1, 1, -1, -1, -1]), 48000, 16000);
    expect(Array.from(out).map(v => +v.toFixed(3))).toEqual([0.3, 1, -1]);
  });

  it('handles 44.1 kHz (not a whole ratio) and keeps the duration', () => {
    const second = new Float32Array(44100).fill(0.5);
    const out = downsample(second, 44100, 16000);
    expect(out.length).toBe(16000);
    expect(Math.max(...out)).toBeCloseTo(0.5);
    expect(Math.min(...out)).toBeCloseTo(0.5);
  });

  it('interpolates up from an 8 kHz headset', () => {
    const out = downsample(Float32Array.from([0, 1, 0, 1]), 8000, 16000);
    expect(Array.from(out)).toEqual([0, 0.5, 1, 0.5, 0, 0.5, 1, 1]);
  });
});

describe('encodeWav', () => {
  it('writes a mono 16-bit PCM 16 kHz WAV', () => {
    const bytes = encodeWav(Float32Array.from([0, 1, -1, 0.5, 2]));
    const view = new DataView(bytes.buffer);
    const text = (at: number) => String.fromCharCode(...bytes.slice(at, at + 4));
    expect(bytes.length).toBe(44 + 5 * 2);
    expect([text(0), text(8), text(12), text(36)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data']);
    expect(view.getUint32(4, true)).toBe(36 + 10);
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(28, true)).toBe(32000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(10);
    const samples = [0, 1, 2, 3, 4].map(i => view.getInt16(44 + i * 2, true));
    expect(samples).toEqual([0, 32767, -32768, 16383, 32767]); // clipped above 1
  });
});

describe('SpeechGate', () => {
  const feed = (gate: SpeechGate, level: number, ms: number, step = 40) => {
    const seen: string[] = [];
    for (let t = 0; t < ms; t += step) seen.push(gate.push(level, step));
    return seen;
  };

  it('starts on sustained speech and ends after the pause', () => {
    const gate = new SpeechGate({ endAfterMs: 1200 });
    expect(feed(gate, 0.002, 1000).every(g => g === 'quiet')).toBe(true);
    const talking = feed(gate, 0.1, 600);
    expect(talking.filter(g => g === 'start')).toHaveLength(1);
    expect(gate.speaking).toBe(true);
    const pause = feed(gate, 0.002, 1200);
    expect(pause.at(-1)).toBe('end');
    expect(pause.slice(0, -1).every(g => g === 'speech')).toBe(true);
    expect(gate.heard).toBe(true);
  });

  it('ignores a click, and short gaps between words', () => {
    const gate = new SpeechGate({ endAfterMs: 1200 });
    feed(gate, 0.002, 1000);
    expect(feed(gate, 0.3, 40)).toEqual(['quiet']);
    feed(gate, 0.002, 400);
    feed(gate, 0.1, 400);
    expect(gate.speaking).toBe(true);
    expect(feed(gate, 0.002, 600).includes('end')).toBe(false);
    feed(gate, 0.1, 200);
    expect(feed(gate, 0.002, 1000).includes('end')).toBe(false);
  });

  it('learns a noisy room, also one that gets loud while listening', () => {
    const gate = new SpeechGate({ endAfterMs: 1200 });
    feed(gate, 0.002, 1000);
    // A vortexer comes on: briefly taken for speech, then learned as the room.
    expect(feed(gate, 0.02, 5000)).toContain('end');
    expect(gate.speaking).toBe(false);
    feed(gate, 0.15, 300);
    expect(gate.speaking).toBe(true);
  });
});

describe('level', () => {
  it('is the RMS of the chunk', () => {
    expect(level(Float32Array.from([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5);
    expect(level(new Float32Array(0))).toBe(0);
  });
});

describe('joinFinals', () => {
  it('joins pieces and drops the repeats Chrome on Android sends', () => {
    expect(joinFinals(['A is', ' done'])).toBe('A is done');
    expect(joinFinals(['next', 'next step', 'next step please'])).toBe('next step please');
    expect(joinFinals(['twelve samples', 'samples'])).toBe('twelve samples');
    expect(joinFinals(['', '  '])).toBe('');
  });
});

describe('speaking', () => {
  const voice = (name: string, lang: string, localService = true) => ({ name, lang, localService, default: false });

  it('prefers a natural US voice, never a novelty one', () => {
    const voices = [voice('Albert', 'en-US'), voice('Fred', 'en-US'), voice('Samantha', 'en-US'), voice('Ava (Premium)', 'en-US'), voice('Meijia', 'zh-TW')];
    expect(pickVoice(voices, 'en-US')?.name).toBe('Ava (Premium)');
    expect(pickVoice(voices.slice(0, 3), 'en-US')?.name).toBe('Samantha');
    expect(pickVoice(voices.slice(0, 2), 'en-US')).toBeNull();
    expect(pickVoice([voice('Google US English', 'en-US', false), voice('Google UK English Female', 'en-GB', false)], 'en-US')?.name).toBe('Google US English');
  });

  it('reads Mandarin with a Taiwan voice, else any Mandarin voice', () => {
    expect(pickVoice([voice('Samantha', 'en-US'), voice('美佳', 'zh_TW')], 'zh-TW')?.name).toBe('美佳');
    expect(pickVoice([voice('Tingting', 'zh-CN')], 'zh-TW')?.name).toBe('Tingting');
  });

  it('tells Mandarin from English', () => {
    expect(mostlyCjk('Add 200 µL of working reagent to each well.')).toBe(false);
    expect(mostlyCjk('每個孔加 200 µL 的 BCA 工作液')).toBe(true);
    expect(mostlyCjk('Say 下一步 to go on to the next step')).toBe(false);
  });
});
