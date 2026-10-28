import { useEffect } from 'react';
import { useLocation } from 'react-router';
import { useRun } from '../state/run.ts';

// The screens that work on the run itself.
const RUN_SCREENS = /^\/(?:plan|run|results|share|kit)(?:\/|$)/;

/** Opening a run screen brings a run that New conversation set aside back into the conversation. */
export function useRunComesBack() {
  const { pathname } = useLocation();
  useEffect(() => {
    if (RUN_SCREENS.test(pathname) && useRun.getState().aside) useRun.getState().setAside(false);
  }, [pathname]);
}
