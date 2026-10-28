import { TimerNotice } from '../../components/lab/index.ts';

/**
 * Timer-Done, "Time's up": the lock-screen notification as the design draws it, shown in the app when the incubation
 * ends while Chapp is open (a real push to the lock screen is phase 2). Open Chapp goes on to reading the plate.
 */
export function TimeUp({ title, body, onOpen }: { title: string; body: string; onOpen: () => void }) {
  return (
    <div
      role="alertdialog"
      aria-label="Time’s up"
      className="absolute inset-0 z-[9] flex flex-col gap-2.5 bg-[#101114] px-3 pt-[calc(120px+var(--screen-top))] pb-[var(--screen-bottom)] text-white animate-in fade-in duration-300"
    >
      <TimerNotice title={title} body={body} />
      <div className="grow" />
      <button
        type="button"
        onClick={onOpen}
        className="flex min-h-[52px] cursor-pointer items-center self-center rounded-full border-0 bg-white/16 px-6 font-[inherit] text-[17px] leading-[22px] font-[650] text-white outline-none focus-visible:ring-2 focus-visible:ring-white"
      >
        Open Chapp
      </button>
    </div>
  );
}
