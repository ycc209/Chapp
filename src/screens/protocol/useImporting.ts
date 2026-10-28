import { useEffect, useState } from 'react';
import { useSession } from '../../state/session.ts';
import { useUploads } from '../home/upload.ts';
import type { Finding, Stage } from './useFinding.ts';

/**
 * The Overview for a manual the user uploaded (Home-Plus.dc.html's Upload): the same stages as Chapp finding one on
 * the web (useFinding), with reading in place of searching. 0 while the server reads it, each thing Chapp says shown
 * as it comes ("Reading the manual", "Turning it into steps"), and within seconds what the kit is (its intro: the
 * answer and At a glance); then once it is a protocol, the whole of it (after an intro), or 1 the answer, 2 at a glance
 * and 3 the whole protocol, each held 1.4 s as in Overview.dc.html. Null when there is no upload to follow (none was
 * started, or the page was reloaded since): the protocol shows on its own.
 */
const STEP_MS = 1400;
export const READING_STATUS = ['Reading the manual', 'Turning it into steps'] as const;

export function useImporting(uploadId: string | null): (Finding & { name: string }) | null {
  const upload = useUploads(s => (uploadId ? s.uploads[uploadId] : undefined));
  const [stage, setStage] = useState<Stage>(0);
  const read = Boolean(upload?.protocolId);
  const failed = upload?.error;
  const introduced = Boolean(upload?.intro);

  // Once read, the protocol comes in as the design's found → at a glance → whole; after an intro, whole at once.
  useEffect(() => {
    if (!read) return;
    if (introduced) {
      setStage(3);
      return;
    }
    setStage(1);
    const timers = [window.setTimeout(() => setStage(2), STEP_MS), window.setTimeout(() => setStage(3), 2 * STEP_MS)];
    return () => timers.forEach(clearTimeout);
  }, [read]);

  // The line under Chapp's name says what it is doing, its face thinks until the end (and is sad if it failed).
  const status = !upload || stage === 3 || failed ? '' : read || introduced ? READING_STATUS[1] : (upload.lines.at(-1) ?? READING_STATUS[0]);
  useEffect(() => {
    if (!upload) return;
    const session = useSession.getState();
    session.setStatus(status);
    session.setExpression(failed ? 'sad' : stage < 3 ? 'thinking' : 'neutral');
  }, [upload !== undefined, status, failed, stage]);
  useEffect(
    () => () => {
      const s = useSession.getState();
      if ((READING_STATUS as readonly string[]).includes(s.status)) s.setStatus('');
      if (s.expression === 'thinking' || s.expression === 'sad') s.setExpression('neutral');
    },
    [],
  );

  if (!upload) return null;
  if (failed) return { name: upload.name, stage: 1, progress: upload.lines, notFound: `I couldn't read that manual. ${failed.replace(/[.!?]?$/, '.')}` };
  return {
    name: upload.name,
    stage: read ? stage : 0,
    progress: upload.lines.length ? upload.lines : [READING_STATUS[0]],
    notFound: null,
    ...(upload.protocolId ? { protocolId: upload.protocolId } : {}),
    ...(upload.intro ? { intro: upload.intro } : {}),
  };
}
