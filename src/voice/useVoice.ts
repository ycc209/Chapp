import { useEffect, useRef } from 'react';
import { useSession } from '../state/session.ts';
import { attachHandler, cancelListening, endConversation, finishListening, holdWasTap, startListening } from './controller.ts';

/**
 * The microphone for a bar on screen. `voice` is the session's ('idle' | 'listening' | 'talking'); each thing the user
 * finishes saying goes to `onUtterance` (a tap's one sentence, or each turn of a conversation).
 *
 *   tap()      idle → listening: one thing, sent after a pause
 *   hold()     idle → holding: Tap to speak pressed; everything said until it is let go
 *   send()     listening or holding: stop now and send what was said
 *   asTap()    holding → listening: let go too soon to be a hold, so it was a tap
 *   cancel()   holding: let go slid up, send nothing
 *   talk()     idle → talking: turn after turn, paused while Chapp speaks
 *   end()      talking (or listening): stop, send nothing
 *
 * Call tap(), hold() and talk() inside the user's gesture: browsers open the microphone only then.
 */
export function useVoice(onUtterance: (text: string) => void) {
  const voice = useSession(s => s.voice);
  const latest = useRef(onUtterance);
  useEffect(() => {
    latest.current = onUtterance;
  });
  useEffect(() => attachHandler(text => latest.current(text)), []);
  return {
    voice,
    tap: () => startListening('tap'),
    hold: () => startListening('hold'),
    asTap: holdWasTap,
    cancel: cancelListening,
    talk: () => startListening('talk'),
    send: finishListening,
    end: endConversation,
  };
}
