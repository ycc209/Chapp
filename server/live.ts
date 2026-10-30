import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { fixLabWords, labTerms } from '../src/voice/labWords.ts';
import { knownProtocols } from './ai/protocols.ts';
import { ASR_MODEL, keywords, LANGUAGES, toTaiwan } from './ai/speech.ts';
import { meter, PER } from './ai/usage.ts';

/**
 * Live speech: the phone streams its microphone here (WebSocket /api/voice/live, raw 16 kHz 16-bit mono PCM) and this
 * passes it on to Muse Voice Transcribe's realtime endpoint (https://dev.meta.ai/docs/api-reference/voice/realtime),
 * so the words show while the user speaks and the model, not a loudness threshold, decides when they have finished
 * (ENDPOINTING: speechStart, partial transcripts, speechEnd, speechComplete). The API key stays here: the phone never
 * sees it. Each transcript comes back as Taiwan writes Chinese, with lab names put right (speech.ts, labWords.ts).
 *
 * The phone sends {"type":"endStream"} when it is done (a tap, a hold let go) and reads on until this side closes.
 * Nothing here logs what was said: only timings.
 */

export const META_REALTIME = 'wss://api.meta.ai/v1/asr/realtime';
/** Meta wants the handshake within 10 s; audio that comes before its answer waits here, up to this much (bytes). */
const WAITING_MAX = 32_000 * 10;
/** 16 kHz 16-bit mono. */
const BYTES_PER_MS = 32;
/**
 * The audio that waited for the handshake (about 1 s of it) goes at twice real time, not all at once: sent in one burst
 * it cost the first word (on 2026-10-30, "幫我找 TRIzol" heard as "Pierce BCA" or "Pierce 660" in 3 of 5 sessions; at
 * twice real time 3 of 3 right), and Meta asks for about real-time speed.
 */
const CATCH_UP = 2;

export type LiveOptions = { apiKey: string; url?: string; log?: (line: string) => void };

/** The upgrade handler for /api/voice/live: true when it took the request. */
export function createLiveVoice({ apiKey, url = META_REALTIME, log = line => console.log(line) }: LiveOptions) {
  const server = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  server.on('connection', phone => relay(phone, { apiKey, url, log }));
  return (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (new URL(req.url ?? '/', 'http://local').pathname !== '/api/voice/live') return false;
    // Past today's allowance (usage.ts) there is no live speech; the phone falls back to recordings, which say why.
    if (meter.cap() && meter.spent() >= meter.cap()) return false;
    server.handleUpgrade(req, socket, head, ws => server.emit('connection', ws, req));
    return true;
  };
}

function relay(phone: WebSocket, { apiKey, url, log }: Required<LiveOptions>) {
  const started = Date.now();
  const terms = labTerms(knownProtocols());
  const meta = new WebSocket(url);
  let ready = false;
  let firstWords = 0;
  let waiting: Buffer[] = [];
  let waitingBytes = 0;
  let draining = false;
  let ending = false;
  let heardBytes = 0;
  const endStream = () => meta.readyState === WebSocket.OPEN && meta.send(JSON.stringify({ type: 'endStream' }));
  // One waiting chunk, then the next after half its length; what the phone sends meanwhile queues behind.
  const drain = () => {
    const chunk = waiting.shift();
    if (!chunk) {
      draining = false;
      if (ending) endStream();
      return;
    }
    if (meta.readyState === WebSocket.OPEN) meta.send(chunk);
    setTimeout(drain, chunk.length / BYTES_PER_MS / CATCH_UP);
  };
  const close = (code: number, reason = '') => {
    if (phone.readyState === WebSocket.OPEN) phone.close(code, reason);
    if (meta.readyState === WebSocket.OPEN || meta.readyState === WebSocket.CONNECTING) meta.terminate();
  };
  const tell = (event: object) => phone.readyState === WebSocket.OPEN && phone.send(JSON.stringify(event));

  meta.on('open', () => {
    meta.send(
      JSON.stringify({
        authorization: { accessToken: `Bearer ${apiKey}` },
        audioEncoding: 'PCM_16KHZ',
        model: ASR_MODEL,
        mode: 'ENDPOINTING',
        partialMode: 'CUMULATIVE',
        emitAudioProgress: false,
        languageBias: LANGUAGES,
        keywords: keywords(),
      }),
    );
  });

  meta.on('message', (data: RawData, binary: boolean) => {
    if (binary) return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data.toString());
    } catch {
      return;
    }
    // The handshake's answer is the one message without a type.
    if (!ready && event.type === undefined) {
      if (typeof event.sessionId !== 'string') return close(1011, 'handshake failed');
      ready = true;
      draining = true;
      drain();
      return;
    }
    if (event.type === 'error') {
      log(`[live] error after ${((Date.now() - started) / 1000).toFixed(1)} s: ${String(event.errorType ?? 'unknown')}`);
      return tell({ type: 'error', message: 'Transcription failed' });
    }
    if (typeof event.transcript === 'string') {
      if (!firstWords && event.transcript) firstWords = Date.now();
      event.transcript = fixLabWords(toTaiwan(event.transcript), terms);
    }
    tell(event);
  });

  meta.on('close', code => {
    meter.spend((heardBytes / BYTES_PER_MS / 3_600_000) * PER.speechHour);
    const words = firstWords ? `, first words after ${((firstWords - started) / 1000).toFixed(1)} s` : ', no words';
    log(`[live] ${((Date.now() - started) / 1000).toFixed(1)} s, ${(heardBytes / BYTES_PER_MS / 1000).toFixed(1)} s of audio${words}, closed ${code}`);
    close(code === 1000 ? 1000 : 1011);
  });
  meta.on('error', () => close(1011, 'transcriber unreachable'));

  phone.on('message', (data: RawData, binary: boolean) => {
    if (!binary) {
      // The phone's only words: it is done. Audio still queued goes first.
      if (!data.toString().includes('endStream')) return;
      ending = true;
      if (ready && !draining) endStream();
      return;
    }
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    heardBytes += chunk.length;
    if (ready && !draining) return meta.send(chunk);
    if (!ready && (waitingBytes += chunk.length) > WAITING_MAX) return close(1011, 'transcriber too slow');
    waiting.push(chunk);
  });
  phone.on('close', () => {
    if (meta.readyState === WebSocket.OPEN || meta.readyState === WebSocket.CONNECTING) meta.terminate();
  });
}
