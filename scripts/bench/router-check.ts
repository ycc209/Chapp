/**
 * How the embedding router (server/ai/router.ts) scores things said at the bench, with the real model: phrasings it
 * should perform, phrasings that only mention a command, and other bench talk. Prints each one's nearest command,
 * its score against the nearest question or chat, and whether the thresholds would route it. No Meta call: the
 * embedding runs here (the first run downloads the model into data/models/).
 *
 *   node scripts/bench/router-check.ts
 *   node scripts/bench/router-check.ts --model Xenova/multilingual-e5-base    # another embedding model, same sentences
 */
import { createRouter, MARGIN, SURE, THRESHOLD } from '../../server/ai/router.ts';

const SHOULD_ROUTE = ['下一步', '下一步。', '好，下一步', '好 下一步了', '那就下一步', '進下一步', '可以下一步了', 'ok 下一步', 'next', 'next step please', 'onto the next step', 'alright, next',
  '上一步', '回上一步', '回去一步', 'go back a step', 'back a step',
  '開始計時', '計時開始', '幫我開始計時', '計時器按下去', 'start the timer', 'start timing', 'kick off the timer',
  '計時先暫停', '暫停一下計時', 'pause the timer', 'stop the clock',
  '繼續計時', '計時器繼續', 'resume the timer', 'keep the timer going'];
const SHOULD_NOT = ['下一步要做什麼', '下一步是什麼', '下一步要加什麼', '下一步要等多久', '不要下一步', '先不要下一步', '等一下再下一步', '下一步嗎', '下一步？', '下一步呢', '上一步呢', '可以下一步嗎', '下一步了嗎', '我還沒好', '這一步做多久',
  '為什麼要計時', '計時器還剩多久', '計時到了嗎', '不用計時', '先不要計時', '計時器可以先不按嗎', '什麼時候開始計時',
  '上一步做了什麼', '上一步是什麼',
  "what's the next step", 'what do I do next', 'how long is this step', "don't go to the next step", 'not yet', 'wait', 'is the timer done', 'should I start the timer', 'why start the timer',
  '你好', '謝謝', '好', '嗯', 'ok', 'hello', 'B 做完了', '12 個樣本', '改成三重複', '加一個對照組', 'A B C D 好了', '我要做 BCA', '找 Bradford 的說明書'];

const at = process.argv.indexOf('--model');
const router = createRouter({ log: line => console.error(line), ...(at > 0 ? { model: process.argv[at + 1] } : {}) });
await router.warm();

async function table(title: string, lines: string[], want: boolean) {
  console.log(`\n${title}`);
  let wrong = 0;
  for (const text of lines) {
    const started = Date.now();
    const { best, other, routed } = await router.score(text);
    if (routed !== want) wrong++;
    console.log(`  ${routed === want ? 'ok  ' : 'MISS'} ${routed ? best.kind.padEnd(12) : 'model'.padEnd(12)} ${best.score.toFixed(3)} vs other ${other.toFixed(3)} (${(best.score - other).toFixed(3)}) ${Date.now() - started} ms  ${text}`);
  }
  return wrong;
}

console.log(`sure ${SURE}; threshold ${THRESHOLD} with margin ${MARGIN}`);
const missed = await table('Should be performed at once', SHOULD_ROUTE, true);
const leaked = await table('Should go to the model', SHOULD_NOT, false);
console.log(`\n${missed} of ${SHOULD_ROUTE.length} commands would go to the model instead; ${leaked} of ${SHOULD_NOT.length} other sentences would be performed by mistake.`);
