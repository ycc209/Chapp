import { create } from 'zustand';
import { api } from '../../api/client.ts';

/**
 * Time's up on the lock screen (Timer-Done) from the phone's side: the service worker (public/sw.js), the push
 * subscription, and the timer handed to the server (server/push.ts), which sends the push at the end time, so it
 * arrives with Chapp closed or the phone locked.
 *
 * Where it cannot work, the timer step says so instead of promising it:
 *   ready        notifications allowed: every timer started is sent to the server
 *   ask          not asked yet: a tap has to ask (browsers only ask from a tap, never from a voice command)
 *   home-screen  an iPhone or iPad in Safari: iOS 16.4+ pushes only to an app added to the Home Screen
 *   denied       notifications turned off for Chapp
 *   unsupported  no service worker or Push API here (an old browser, or plain http on the local network)
 *   failed       the subscription or the server did not take the timer
 */
export type PushState = 'ready' | 'ask' | 'home-screen' | 'denied' | 'unsupported' | 'failed';

type Nav = Navigator & { standalone?: boolean };

/** An iPhone or iPad, including iPadOS that says it is a Mac. */
export const isIos = (nav: Pick<Navigator, 'userAgent' | 'platform' | 'maxTouchPoints'> = navigator) =>
  /iPhone|iPad|iPod/.test(nav.userAgent) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);

/** What this browser allows now, from what it has: the Push API, the permission, and on iOS, the Home Screen. */
export function pushSupport(env: {
  nav: Pick<Nav, 'userAgent' | 'platform' | 'maxTouchPoints' | 'standalone'> & { serviceWorker?: unknown };
  secure: boolean;
  standalone: boolean;
  pushApi: boolean;
  permission: NotificationPermission | null;
}): PushState {
  const ios = isIos(env.nav);
  const installed = env.standalone || env.nav.standalone === true;
  if (ios && !installed) return 'home-screen';
  if (!env.secure || !env.nav.serviceWorker || !env.pushApi || env.permission === null) return 'unsupported';
  if (env.permission === 'denied') return 'denied';
  return env.permission === 'granted' ? 'ready' : 'ask';
}

function currentSupport(): PushState {
  if (typeof window === 'undefined') return 'unsupported';
  return pushSupport({
    nav: navigator as Nav,
    secure: window.isSecureContext,
    standalone: window.matchMedia?.('(display-mode: standalone)').matches ?? false,
    pushApi: 'PushManager' in window,
    permission: 'Notification' in window ? Notification.permission : null,
  });
}

export const usePush = create<{ state: PushState; set: (state: PushState) => void }>()(set => ({ state: currentSupport(), set: state => set({ state }) }));

// Allowed or blocked in Settings while Chapp was in the background: look again when it comes back.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const now = currentSupport();
    const was = usePush.getState().state;
    if (now !== was && !(was === 'failed' && now === 'ready')) usePush.getState().set(now);
  });
}

const keyBytes = (b64url: string) => {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), c => c.charCodeAt(0));
};
const sameKey = (a: ArrayBuffer | null, b: Uint8Array) => !!a && a.byteLength === b.length && new Uint8Array(a).every((x, i) => x === b[i]);

/** The service worker, registered once. */
let registering: Promise<ServiceWorkerRegistration> | null = null;
const registration = () => (registering ??= navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready));

/** This browser's push subscription for the server's key: the one it has, or a new one once notifications are allowed. */
async function subscription(): Promise<PushSubscription | null> {
  if (currentSupport() !== 'ready') return null;
  const reg = await registration();
  const key = keyBytes((await api.pushKey()).publicKey);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe().catch(() => false);
    sub = null;
  }
  return sub ?? reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
}

/**
 * From a tap: ask for notifications (the browser's own prompt; it has to be the first thing the tap does), then
 * subscribe. Returns what the step should say next.
 */
export function enablePush(): Promise<PushState> {
  if (!('Notification' in window)) return Promise.resolve(currentSupport());
  return Notification.requestPermission()
    .then(() => {
      const now = currentSupport();
      if (now !== 'ready') return now;
      return subscription().then(sub => (sub ? 'ready' : 'failed') as PushState, () => 'failed' as PushState);
    })
    .then(state => {
      usePush.getState().set(state);
      return state;
    });
}

// The timers handed to the server, by id → their end, so a reload neither sends one twice nor cancels one not sent.
const SENT = 'chapp.push.sent';
const sent = (): Record<string, number> => {
  try {
    return JSON.parse(localStorage.getItem(SENT) ?? '{}') as Record<string, number>;
  } catch {
    return {};
  }
};
const remember = (id: string, endsAt: number | null) => {
  try {
    const all = sent();
    if (endsAt === null) delete all[id];
    else all[id] = endsAt;
    localStorage.setItem(SENT, JSON.stringify(all));
  } catch {
    // Private mode: the timer still goes out, it just may be sent again after a reload.
  }
};

/** Every timer handed to the server, by key → its end (state/alarms.ts calls off the ones stopped). */
export const sentTimers = sent;

/** Is the server going to push this timer's end? Then the page need not show its own notification too. */
export const pushWaiting = (id: string, endsAt: number) => sent()[id] === endsAt;

/** Hands a running timer to the server, which pushes Time's up at `endsAt`. Quietly nothing where push cannot work. */
export async function pushTimer(t: { id: string; endsAt: number; title: string; body: string; url: string }): Promise<boolean> {
  if (sent()[t.id] === t.endsAt) return true;
  try {
    const sub = await subscription();
    if (!sub) return false;
    await api.pushTimer({ subscription: sub.toJSON(), ...t });
    remember(t.id, t.endsAt);
    return true;
  } catch {
    usePush.getState().set('failed');
    return false;
  }
}

/** The timer was stopped or ended by hand: no push for it. */
export async function cancelPushTimer(id: string): Promise<void> {
  if (sent()[id] === undefined) return;
  remember(id, null);
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (sub) await api.pushCancel(sub.endpoint, id);
  } catch {
    // The server will send it anyway; the in-page Time's up has already shown.
  }
}
