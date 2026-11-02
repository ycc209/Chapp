import { useEffect } from 'react';
import { useLocation } from 'react-router';
import { useChatLog } from '../state/conversationLog.ts';
import { useRun } from '../state/run.ts';
import { openThread, useThreads } from '../state/threads.ts';

// The screens that work on the run itself.
const RUN_SCREENS = /^\/(?:plan|run|results|share|kit)(?:\/|$)/;

/**
 * Opening a run screen while New conversation set the run aside goes back to the run's own conversation, so what is
 * said there is said in the experiment's (state/threads.ts). Not while Chapp is answering: the answer stays where it
 * was asked.
 */
export function useRunComesBack() {
  const { pathname } = useLocation();
  useEffect(() => {
    if (!RUN_SCREENS.test(pathname) || !useRun.getState().aside) return;
    if (useChatLog.getState().exchanges.some(e => e.phase === 'thinking')) return;
    const { runThread } = useThreads.getState();
    if (runThread) openThread(runThread);
    else useRun.getState().setAside(false);
  }, [pathname]);
}
