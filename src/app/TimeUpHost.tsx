import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { openAlarm, quietAlarm, useAlarms } from '../state/alarms.ts';
import { openThread } from '../state/threads.ts';
import { TimeUp } from '../screens/run/TimeUp.tsx';

/**
 * Time's up over whatever screen is open (state/alarms.ts rings it), for any experiment's timer; Open Chapp goes on
 * in that experiment. With gloves on in the run whose timer it is, the run speaks for itself and no screen covers it.
 */
export function TimeUpHost() {
  const ringing = useAlarms(s => s.ringing);
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const gloves = Boolean(ringing?.alarm.live) && pathname.startsWith('/run') && new URLSearchParams(search).get('gloves') === '1';
  useEffect(() => {
    if (ringing && gloves) quietAlarm();
  }, [ringing, gloves]);
  if (!ringing || gloves) return null;
  return <TimeUp title={ringing.text.title} body={ringing.text.body} onOpen={() => openAlarm(navigate)} />;
}

/** A lock-screen Time's up opens its own experiment (?experiment=…), then the address goes back to the step alone. */
export function useExperimentLink() {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    const params = new URLSearchParams(search);
    const id = params.get('experiment');
    if (!id) return;
    openThread(id);
    params.delete('experiment');
    const rest = params.toString();
    navigate(`${pathname}${rest ? `?${rest}` : ''}`, { replace: true });
  }, [pathname, search, navigate]);
}
