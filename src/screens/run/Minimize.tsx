import { useNavigate } from 'react-router';
import { cn } from '../../lib/cn.ts';
import { useDock } from '../../state/dock.ts';

/**
 * At the top right of a run step: makes the run small and goes Home, the run floating there (src/app/RunDock.tsx) on
 * its step, with its timer, until a tap opens it again. `titles` are the run's steps, for the floating run to name.
 */
export function MinimizeRun({ titles, className }: { titles: string[]; className?: string }) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      aria-label="Make the run small and go Home"
      onClick={() => {
        useDock.getState().minimize(titles);
        navigate('/');
      }}
      className={cn(
        'absolute top-[calc(56px+var(--screen-top))] z-[6] flex size-11 items-center justify-center rounded-full text-ink outline-none focus-visible:ring-2 focus-visible:ring-blue',
        className,
      )}
    >
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="4.5" width="18" height="15" rx="3" />
        <rect x="11.5" y="11.5" width="6.5" height="5" rx="1.2" fill="currentColor" stroke="none" />
      </svg>
    </button>
  );
}
