import { describe, expect, it } from 'vitest';
import type { ConverseRequest } from '../shared/ai.ts';
import { createRouter, type Embed } from '../server/ai/router.ts';

// The embedding fast path on a stand-in for the sentence-embedding model: no download, no model. What it decides from
// the scores is the real code; scripts/bench/router-check.ts scores real sentences with the real model.

/** Character and bigram counts hashed into a unit vector: the same words score 1, and a question scores closer to its own example than to the bare command inside it. */
const charEmbed: Embed = async texts => texts.map(text => {
  const v = new Array<number>(256).fill(0);
  const s = text.replace(/^query: /, '').toLowerCase();
  const bump = (key: string) => {
    let h = 7;
    for (const c of key) h = (h * 31 + c.codePointAt(0)!) % 256;
    v[h]! += 1;
  };
  for (let i = 0; i < s.length; i++) {
    bump(s[i]!);
    if (i + 1 < s.length) bump(s.slice(i, i + 2));
  }
  const n = Math.hypot(...v) || 1;
  return v.map(x => x / n);
});
const run = (text: string, context: Partial<ConverseRequest['context']> = {}): ConverseRequest => ({ text, context: { screen: 'run', protocolId: 'pierce-bca', procedure: 'microplate', step: 1, ...context } });
const quiet = () => {};

describe('the embedding fast path', () => {
  it('performs the plainest bench commands on the run screen at once, and leaves questions that mention them to the model', async () => {
    const router = createRouter({ embed: charEmbed, log: quiet });
    // Not loaded yet: the model's turn, never a wait.
    expect(await router.route(run('下一步'))).toBeNull();
    await router.warm();
    expect(await router.route(run('下一步'))).toEqual({ type: 'nextStep' });
    expect(await router.route(run('next step'))).toEqual({ type: 'nextStep' });
    expect(await router.route(run('回上一步'))).toEqual({ type: 'previousStep' });
    expect(await router.route(run('下一步要做什麼'))).toBeNull();
    expect(await router.route(run('不要下一步'))).toBeNull();
    expect(await router.route(run('你好'))).toBeNull();
  });

  it('is only for short sentences on the run screen, and never for a continuation', async () => {
    const router = createRouter({ embed: charEmbed, log: quiet });
    await router.warm();
    expect(await router.route({ text: '下一步', context: { screen: 'home' } })).toBeNull();
    expect(await router.route(run('下一步，然後把 B 和 C 的 working reagent 都加進去'))).toBeNull();
    expect(await router.route({ ...run('下一步'), continuationToken: 'ticket' })).toBeNull();
  });

  it('names the one timer a command can mean, and leaves it to the model when there are two or none', async () => {
    const router = createRouter({ embed: charEmbed, log: quiet });
    await router.warm();
    expect(await router.route(run('pause the timer', { timers: [{ id: 'm-incubate', secondsLeft: 900 }] }))).toEqual({ type: 'stopTimer', id: 'm-incubate' });
    expect(await router.route(run('pause the timer', { timers: [{ id: 'a', secondsLeft: 9 }, { id: 'b', secondsLeft: 9 }] }))).toBeNull();
    expect(await router.route(run('pause the timer'))).toBeNull();
    expect(await router.route(run('繼續計時', { paused: [{ id: 'm-incubate', secondsLeft: 500 }] }))).toEqual({ type: 'resumeTimer', id: 'm-incubate' });
    expect(await router.route(run('繼續計時'))).toBeNull();
  });

  it('stays out of the way when its model cannot load', async () => {
    const lines: string[] = [];
    const router = createRouter({ embed: async () => { throw new Error('no model here'); }, log: line => lines.push(line) });
    await router.warm();
    expect(await router.route(run('下一步'))).toBeNull();
    expect(lines.join('\n')).toContain('unavailable: no model here');
  });
});
