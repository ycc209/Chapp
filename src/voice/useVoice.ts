import { useEffect, useRef } from 'react';
import { useSession } from '../state/session.ts';
import { attachHandler, endConversation, finishListening, startListening } from './controller.ts';

/**
 * The microphone for a bar on screen. `voice` is the session's ('idle' | 'listening' | 'talking'); each thing the user
 * finishes saying goes to `onUtterance` (a tap's one sentence, or each turn of a conversation).
 *
 *   tap()   idle → listening: one thing, sent after a pause
 *   talk()  idle → talking: turn after turn, paused while Chapp speaks
 *   send()  listening: stop now and send what was said
 *   end()   talking (or listening): stop, send nothing
 *
 * Call tap() and talk() inside the user's gesture: browsers open the microphone only then.
 */
export function useVoice(onUtterance: (text: string) => void) {
  const voice = useSession(s => s.voice);
  const latest = useRef(onUtterance);
  useEffect(() => {
    latest.current = onUtterance;
  });
  useEffect(() => attachHandler(text => latest.current(text)), []);
  return { voice, tap: () => startListening('tap'), talk: () => startListening('talk'), send: finishListening, end: endConversation };
}
