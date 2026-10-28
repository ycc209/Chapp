import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Which of this phone's protocols the user has put in the shared library (Share-QR's "Add to library", Library's
 * "Upload"). The shared library itself is not built yet (the sidebar marks it Soon): for now this only remembers the
 * choice on the phone, so both screens agree on what they show.
 */
type SharedLibrary = {
  ids: string[];
  add: (protocolId: string) => void;
};

export const useSharedLibrary = create<SharedLibrary>()(
  persist(
    set => ({
      ids: [],
      add: protocolId => set(s => (s.ids.includes(protocolId) ? s : { ids: [...s.ids, protocolId] })),
    }),
    { name: 'chapp.library' },
  ),
);
