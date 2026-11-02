import { START_CARD, type Action } from '../../shared/ai.ts';

const CJK = /[぀-ヿ㐀-䶿一-鿿]/;
const ZH_REPLICATES = ['', '一次就好。', '二重複。', '三重複。', '四重複。'];

/**
 * What Chapp says once the app has carried out a bench operation the front assistant asked for: one short line per
 * operation, in the language the user spoke. The app composes it from the actions it performed, so the turn ends
 * with the receipt instead of a second model call (measured at 1.3 s on 2026-10-31): LiveKit's agents do the same
 * when a tool returns nothing, and OpenAI's latency guide puts "make fewer requests" first. The chat log shows
 * what changed beside it, read back from the run.
 */
export function confirmation(actions: Action[], userText: string, receipts: string[] = []): string {
  const zh = CJK.test(userText);
  return actions.map((action, i) => line(action, zh, receipts[i] ?? '')).join(zh ? '' : ' ');
}

function line(action: Action, zh: boolean, receipt: string): string {
  switch (action.type) {
    case 'startRun':
      if (receipt.startsWith(START_CARD)) return zh ? '這是這次的設定。按開始，或說「好」就開始。' : 'Here is the plan. Tap Start, or say yes.';
      return zh ? '開始囉。' : 'Starting.';
    case 'nextStep': return zh ? '好，下一步。' : 'Next step.';
    case 'previousStep': return zh ? '好，回上一步。' : 'Back one step.';
    case 'markDone': return zh ? `好，${action.id} 記下了。` : `${action.id} done.`;
    case 'startTimer': return zh ? '計時開始。' : 'Timer started.';
    case 'stopTimer': return zh ? '計時先停。' : 'Timer paused.';
    case 'resumeTimer': return zh ? '計時繼續。' : 'Timer resumed.';
    case 'setSamples': return zh ? `${action.samples} 個樣本。` : `${action.samples} sample${action.samples === 1 ? '' : 's'}.`;
    case 'setReplicates': return zh ? ZH_REPLICATES[action.replicates] ?? `${action.replicates} 重複。` : `${action.replicates} replicate${action.replicates === 1 ? '' : 's'}.`;
    case 'setStepTime': return zh ? '這次改好了。' : 'Changed for this run.';
    case 'redo': return zh ? `${action.id} 再做一次。` : `${action.id} again.`;
    case 'moveWell': return zh ? `${action.from} 換好了。` : `${action.from} moved.`;
    case 'addWell':
    case 'addCondition': return zh ? '加好了。' : 'Added.';
    case 'navigate': return zh ? '好。' : 'Okay.';
    case 'answer': return zh ? (action.yes ? '好。' : '好，不用。') : 'Okay.';
    case 'findProtocol': return zh ? '找找看。' : 'Looking it up.';
    case 'takePhoto': return zh ? '相機開了。' : 'The camera is open.';
    case 'useSample': return zh ? '載入範例讀值了。' : 'Sample readings loaded.';
    case 'undo': return zh ? '復原了。' : 'Undone.';
    case 'openProtocol': return zh ? '打開了。' : 'Opened.';
  }
}
