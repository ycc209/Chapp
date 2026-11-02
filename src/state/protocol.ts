import { useCallback, useEffect, useState } from 'react';
import { Protocol, type ProtocolSummary } from '../../shared/protocol.ts';

/**
 * Every protocol on this computer (GET /api/protocols), the newest first: null while it loads. Asked once per mount;
 * `remove` takes one out of the list once the server has deleted it (Library).
 */
export function useProtocolList(): { list: ProtocolSummary[] | null; error: string | null; remove: (id: string) => void } {
  const [state, setState] = useState<{ list: ProtocolSummary[] | null; error: string | null }>({ list: null, error: null });
  const remove = useCallback((id: string) => {
    loads.delete(id);
    setState(s => ({ ...s, list: s.list?.filter(p => p.id !== id) ?? null }));
  }, []);
  useEffect(() => {
    let live = true;
    fetch('/api/protocols')
      .then(async res => {
        if (!res.ok) throw new Error(`Your protocols failed to load (${res.status}).`);
        return (await res.json()) as ProtocolSummary[];
      })
      .then(
        list => live && setState({ list, error: null }),
        (error: unknown) => live && setState({ list: null, error: error instanceof Error ? error.message : String(error) }),
      );
    return () => {
      live = false;
    };
  }, []);
  return { ...state, remove };
}

// One request per protocol per page load: every screen of a run reads the same document.
const loads = new Map<string, Promise<Protocol>>();
const loaded = new Map<string, Protocol>();

/** The document, once a screen has loaded it this page load; null before (what a tap on the run writes needs it at once). */
export const loadedProtocol = (id: string | null): Protocol | null => (id ? loaded.get(id) ?? null : null);

export function load(id: string): Promise<Protocol> {
  let p = loads.get(id);
  if (!p) {
    p = fetch(`/api/protocols/${id}`)
      .then(async res => {
        if (!res.ok) throw new Error(res.status === 404 ? 'This protocol is not on this computer.' : `Protocol failed to load (${res.status}).`);
        const doc = Protocol.parse(await res.json());
        loaded.set(id, doc);
        return doc;
      })
      .catch(error => {
        loads.delete(id); // let the next screen try again
        throw error;
      });
    loads.set(id, p);
  }
  return p;
}

/**
 * The protocol document (chapp.protocol/1) the screens draw from: null while it loads, then the parsed document, or
 * an error message. Run-dependent numbers come from shared/calc.ts with the plan in useRun().
 */
export function useProtocol(id: string | null): { protocol: Protocol | null; error: string | null } {
  const [state, setState] = useState<{ id: string | null; protocol: Protocol | null; error: string | null }>({ id: null, protocol: null, error: null });
  useEffect(() => {
    if (!id) return;
    let live = true;
    load(id).then(
      protocol => live && setState({ id, protocol, error: null }),
      (error: unknown) => live && setState({ id, protocol: null, error: error instanceof Error ? error.message : String(error) }),
    );
    return () => {
      live = false;
    };
  }, [id]);
  return state.id === id ? { protocol: state.protocol, error: state.error } : { protocol: null, error: null };
}
