import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { createLiveVoice } from '../server/live.ts';
import { chooseEngine } from '../src/voice/engine.ts';
import { toPcm16 } from '../src/voice/wav.ts';

// Live speech (server/live.ts): the phone's stream passed on to a stand-in for Muse Voice Transcribe's realtime
// endpoint on this machine, and its events passed back. No network.

const closers: (() => void)[] = [];
afterEach(() => closers.splice(0).forEach(c => c()));

const portOf = (s: Server | WebSocketServer) => (s.address() as AddressInfo).port;

/** A stand-in for Meta: answers the handshake, keeps the audio, and on endStream says the turn and closes. */
function fakeMeta(events: object[]) {
  const seen = { handshake: null as Record<string, any> | null, audio: [] as Buffer[], ended: false };
  const meta = new WebSocketServer({ port: 0 });
  closers.push(() => meta.close());
  meta.on('connection', ws => {
    ws.on('message', (data, binary) => {
      if (binary) return seen.audio.push(data as Buffer);
      const message = JSON.parse(data.toString());
      if (!seen.handshake) {
        seen.handshake = message;
        // Answered late, so audio sent meanwhile has to wait on our side.
        setTimeout(() => ws.send(JSON.stringify({ sessionId: 's1' })), 30);
        return;
      }
      if (message.type === 'endStream') {
        seen.ended = true;
        for (const e of events) ws.send(JSON.stringify(e));
        ws.close(1000);
      }
    });
  });
  return { meta, seen };
}

async function ourServer(metaPort: number) {
  const upgrade = createLiveVoice({ apiKey: 'test-key', url: `ws://127.0.0.1:${metaPort}`, log: () => {} });
  const server = createServer((_, res) => res.end());
  server.on('upgrade', (req, socket, head) => {
    if (!upgrade(req, socket, head)) socket.destroy();
  });
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  closers.push(() => server.close());
  return portOf(server);
}

describe('live speech through the server', () => {
  it('passes the stream on with the lab’s words, and the words back as Taiwan writes them', async () => {
    const { meta, seen } = fakeMeta([
      { type: 'speechStart', turnId: 1, audioProcessedMs: 100 },
      { type: 'transcript', transcript: '把样本数', final: false, audioProcessedMs: 600 },
      { type: 'speechComplete', turnId: 1, transcript: '把样本数改成12个，用 pierced BCA', audioProcessedMs: 1800 },
    ]);
    await new Promise(ok => meta.on('listening', ok));
    const port = await ourServer(portOf(meta));

    const phone = new WebSocket(`ws://127.0.0.1:${port}/api/voice/live`);
    const heard: Record<string, unknown>[] = [];
    phone.on('message', data => heard.push(JSON.parse(data.toString())));
    const closed = new Promise<number>(ok => phone.on('close', code => ok(code)));
    await new Promise(ok => phone.on('open', ok));
    phone.send(Buffer.from([1, 2, 3, 4]));
    await new Promise(ok => setTimeout(ok, 80));
    phone.send(Buffer.from([5, 6]));
    await new Promise(ok => setTimeout(ok, 30));
    phone.send(JSON.stringify({ type: 'endStream' }));

    expect(await closed).toBe(1000);
    expect(seen.handshake).toMatchObject({
      authorization: { accessToken: 'Bearer test-key' },
      audioEncoding: 'PCM_16KHZ',
      model: 'muse-voice-transcribe-1.0',
      mode: 'ENDPOINTING',
      languageBias: ['Chinese (Taiwan)', 'English'],
    });
    expect(seen.handshake!.keywords).toEqual(expect.arrayContaining(['TRIzol', 'BCA']));
    // The audio that came before Meta's answer waited, and none was lost or reordered.
    expect(Buffer.concat(seen.audio)).toEqual(Buffer.from([1, 2, 3, 4, 5, 6]));
    expect(seen.ended).toBe(true);
    expect(heard.map(e => e.type)).toEqual(['speechStart', 'transcript', 'speechComplete']);
    expect(heard[1]!.transcript).toBe('把樣本數');
    expect(heard[2]!.transcript).toBe('把樣本數改成12個，用 Pierce BCA');
  });

  it('takes only /api/voice/live', async () => {
    const upgrade = createLiveVoice({ apiKey: 'k', url: 'ws://127.0.0.1:1', log: () => {} });
    const req = { url: '/api/other', headers: {} } as never;
    expect(upgrade(req, {} as never, Buffer.alloc(0))).toBe(false);
  });
});

describe('the phone’s side', () => {
  it('listens live by default', () => {
    expect(chooseEngine()).toBe('live');
  });

  it('streams 16 kHz 16-bit PCM: three 48 kHz samples make one', () => {
    const pcm = new Int16Array(toPcm16(new Float32Array([0.5, 0.5, 0.5, -1, -1, -1]), 48000));
    expect([...pcm]).toEqual([Math.trunc(0.5 * 0x7fff), -0x8000]);
  });
});
