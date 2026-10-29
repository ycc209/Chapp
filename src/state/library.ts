import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import type { ProtocolSummary } from '../../shared/protocol.ts';

/**
 * This phone's library (My Library), kept on the phone:
 *
 *   mine   each protocol that was this phone's run (found, uploaded, photographed, opened, scanned from a labmate):
 *          when it was last used, and when the user saved it (Save to library), if they did.
 *   kits   the user's photos of each kit's bottles, by protocol and component. Taken once, they come back whenever
 *          that kit is the run again; kept apart from the run, so a tick or a reading never rewrites every photo.
 *
 * The run keeps both up to date (state/run.ts): its photos are always its protocol's kit, and every protocol it runs
 * is this phone's. Saving only puts a protocol in Saved; its kit photos are kept either way.
 */

export type Entry = { usedAt: number | null; savedAt: number | null; title?: string };
type Kit = Record<string, string>;

/** Set when the phone had no room for a write (mostly photos): Library says so. */
export const useRoom = create(() => ({ full: false }));

/** localStorage that never throws: a full or blocked one keeps nothing, and useRoom says so. */
const quiet: StateStorage = {
  getItem: name => {
    try {
      return localStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem: (name, value) => {
    try {
      localStorage.setItem(name, value);
    } catch {
      useRoom.setState({ full: true });
    }
  },
  removeItem: name => {
    try {
      localStorage.removeItem(name);
    } catch {
      // Nothing to remove.
    }
  },
};

const MINE = 'chapp.mine';

export const useMine = create<{ protocols: Record<string, Entry> }>()(
  persist(() => ({ protocols: {} }), { name: MINE, storage: createJSONStorage(() => quiet) }),
);

export const useKits = create<{ kits: Record<string, Kit> }>()(
  persist(() => ({ kits: {} }), { name: 'chapp.kits', storage: createJSONStorage(() => quiet) }),
);

const entry = (id: string): Entry => useMine.getState().protocols[id] ?? { usedAt: null, savedAt: null };
const put = (id: string, e: Entry | null) =>
  useMine.setState(s => {
    const protocols = { ...s.protocols };
    if (e && (e.usedAt !== null || e.savedAt !== null)) protocols[id] = e;
    else delete protocols[id];
    return { protocols };
  });

/** The protocol became this phone's run now. */
export const markUsed = (id: string, at = Date.now()) => put(id, { ...entry(id), usedAt: at });

/** Save to library. False when the phone could not keep it. */
export function saveProtocol(id: string, { title, at = Date.now() }: { title?: string; at?: number } = {}): boolean {
  put(id, { ...entry(id), savedAt: at, ...(title ? { title } : {}) });
  try {
    return JSON.parse(localStorage.getItem(MINE) ?? 'null')?.state?.protocols?.[id]?.savedAt === at;
  } catch {
    return false;
  }
}

/** Out of Saved; still in Recent when this phone used it. Returns when it had been saved, for Undo. */
export function unsaveProtocol(id: string): number | null {
  const was = entry(id).savedAt;
  put(id, { ...entry(id), savedAt: null });
  return was;
}

/** The user's photos of this protocol's kit ({} when they have none). */
export const kitPhotos = (id: string): Kit => useKits.getState().kits[id] ?? {};

/** Keeps the run's photos as its protocol's kit (none: forgets it). */
export function rememberKit(id: string, photos: Kit) {
  if (useKits.getState().kits[id] === photos) return;
  useKits.setState(s => {
    const kits = { ...s.kits };
    if (Object.keys(photos).length) kits[id] = photos;
    else delete kits[id];
    return { kits };
  });
}

/** A protocol as a row of My Library: its card from the server, or only what the phone knows when it is gone there. */
export type LibraryRow = Entry & { id: string; title: string; summary: ProtocolSummary | null };

/**
 * My Library's three lists: Saved (the last saved first), Recent (used on this phone and not saved, the last used
 * first) and every other protocol Chapp has read on this computer (as the server lists them). A protocol is in one
 * list only. A search keeps those whose title, kit name or a catalog number has it.
 */
export function librarySections(list: ProtocolSummary[], mine: Record<string, Entry>, query = '') {
  const known = new Map(list.map(p => [p.id, p]));
  const row = (id: string): LibraryRow => {
    const summary = known.get(id) ?? null;
    const e = mine[id] ?? { usedAt: null, savedAt: null };
    return { id, ...e, title: summary?.title ?? e.title ?? id, summary };
  };
  const q = query.trim().toLowerCase();
  const found = (r: LibraryRow) => !q || [r.title, r.summary?.kit ?? '', ...(r.summary?.catalogs ?? [])].some(s => s.toLowerCase().includes(q));
  const ids = Object.keys(mine);
  const saved = ids.filter(id => mine[id]!.savedAt !== null).sort((a, b) => mine[b]!.savedAt! - mine[a]!.savedAt!);
  const recent = ids
    .filter(id => mine[id]!.savedAt === null && mine[id]!.usedAt !== null)
    .sort((a, b) => mine[b]!.usedAt! - mine[a]!.usedAt!);
  const others = list.filter(p => !mine[p.id]).map(p => p.id);
  return { saved: saved.map(row).filter(found), recent: recent.map(row).filter(found), others: others.map(row).filter(found) };
}

/**
 * Brings what the phone had before the library in: the protocols saved with an earlier build (chapp.saved, with their
 * photos), and the run's own protocol and photos.
 */
export function bringIn(run: { protocolId: string | null; photos: Kit }) {
  try {
    const old = JSON.parse(localStorage.getItem('chapp.saved') ?? 'null')?.state?.kits as Record<string, { savedAt: number; photos: Kit }> | undefined;
    for (const [id, kit] of Object.entries(old ?? {})) {
      if (entry(id).savedAt === null) put(id, { ...entry(id), savedAt: kit.savedAt });
      if (!useKits.getState().kits[id] && Object.keys(kit.photos ?? {}).length) rememberKit(id, kit.photos);
    }
    if (old) localStorage.removeItem('chapp.saved');
  } catch {
    // No earlier library, or no storage.
  }
  if (!run.protocolId) return;
  if (entry(run.protocolId).usedAt === null) markUsed(run.protocolId);
  // The run's photos are its kit as it stands now.
  if (Object.keys(run.photos).length) rememberKit(run.protocolId, run.photos);
}
