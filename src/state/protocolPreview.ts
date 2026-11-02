import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { ProtocolPreview } from '../../shared/ai.ts';

type Previews = {
  previews: Record<string, ProtocolPreview>;
  receive: (preview: ProtocolPreview) => void;
};

/** Viewing a manual never adopts it. Sparse events keep the readable part if a later stage fails. */
export const useProtocolPreviews = create<Previews>()(persist(set => ({
  previews: {},
  receive: event => set(({ previews }) => {
    if (!event.id) return {};
    const before = previews[event.id];
    if (before && before.state !== 'reading' && event.state === 'reading') return {};
    const update = Object.fromEntries(Object.entries(event).filter(([, value]) => value !== undefined));
    const next = { ...before, ...update } as ProtocolPreview;
    if (next.state === 'ready') delete next.error;
    next.progress = [...new Set([...(before?.progress ?? []), ...(event.progress ?? [])])].slice(-12);
    const entries = Object.entries(previews).filter(([id]) => id !== event.id);
    return { previews: Object.fromEntries([...entries, [event.id, next]].slice(-12)) };
  }),
}), {
  name: 'chapp.protocol.previews',
  storage: createJSONStorage(() => sessionStorage),
  partialize: state => ({ previews: state.previews }),
  merge: (saved, current) => {
    const cached = (saved as Partial<Previews> | undefined)?.previews ?? {};
    const entries = Object.entries(cached).filter(([id, value]) => value?.id === id && ['reading', 'ready', 'error'].includes(value.state)).slice(-12);
    return { ...current, previews: Object.fromEntries(entries.map(([id, preview]) => [id, preview.state === 'reading'
      ? { ...preview, state: 'error', error: 'Reading was interrupted when this page reloaded. Ask Chapp to open the manual again.' }
      : preview])) };
  },
}));
