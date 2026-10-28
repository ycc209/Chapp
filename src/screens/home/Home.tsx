import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ChappHeader } from '../../components/chapp/ChappHeader.tsx';
import { SHEET_DURATION, SHEET_EASE } from '../../components/ui/Sheet.tsx';
import { BottomBar } from '../../components/voice/BottomBar.tsx';
import { cn } from '../../lib/cn.ts';
import { useSession } from '../../state/session.ts';
import { HomeCenter } from './HomeCenter.tsx';
import { PlusMenu } from './PlusMenu.tsx';
import { Sidebar } from './Sidebar.tsx';
import { TypingBar } from './TypingBar.tsx';
import { useConverse } from './useConverse.ts';

/**
 * The home screen: Chapp asks what we are running today, and listens. Its states, each an artboard: Main, Listening
 * (the words as they are heard), Home-Plus (the + menu), Sidebar (library and history), and typing (no artboard).
 *
 * For design review a state opens straight from the address: ?state=listening|plus|sidebar|typing, and for
 * listening &heard=…&interim=… (the words already settled, and the grey ones still being recognized).
 */
export function Home() {
  const [params, setParams] = useSearchParams();
  const [opening] = useState(() => params.get('state'));
  const [plus, setPlus] = useState(opening === 'plus');
  const [sidebar, setSidebar] = useState(opening === 'sidebar');
  const [typing, setTyping] = useState(opening === 'typing');
  const plusRef = useRef<HTMLButtonElement>(null);
  const { turn, send, newConversation } = useConverse('home');

  useEffect(() => {
    if (!opening) return;
    if (opening === 'listening') {
      const session = useSession.getState();
      session.setVoice('listening');
      session.setHeard(params.get('heard') ?? '', params.get('interim') ?? '');
    }
    // The state is open now; a reload should not reopen it.
    setParams({}, { replace: true });
  }, []);

  return (
    <div
      className={cn(
        'relative h-full overflow-hidden bg-bg transition-[translate,border-radius]',
        SHEET_DURATION,
        SHEET_EASE,
        // Sidebar.dc.html: the page slides right by the sidebar's width and rounds its corners.
        sidebar && 'translate-x-[318px] rounded-[44px]',
      )}
    >
      {/* Main.dc.html's content box: the bottom bar bleeds out of its padding to the screen's edges. */}
      <div className="flex h-full flex-col px-5 pt-[calc(196px+var(--screen-top))] pb-[var(--screen-bottom)]">
        <HomeCenter turn={turn} />
        {typing ? (
          <TypingBar
            plusOpen={plus}
            plusRef={plusRef}
            onPlus={() => setPlus(open => !open)}
            onSend={send}
            onClose={() => {
              setTyping(false);
              setPlus(false);
            }}
          />
        ) : (
          <BottomBar onPlus={() => setPlus(open => !open)} onKeyboard={() => setTyping(true)} onUtterance={send} />
        )}
      </div>
      <PlusMenu open={plus} onClose={() => setPlus(false)} coverPlus={!typing} plusRef={plusRef} />
      <ChappHeader onMenu={() => setSidebar(true)} />
      <Sidebar open={sidebar} onOpenChange={setSidebar} onNewConversation={newConversation} />
    </div>
  );
}
