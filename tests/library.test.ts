import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProtocolSummary } from '../shared/protocol.ts';
import { bringIn, kitPhotos, librarySections, saveProtocol, unsaveProtocol, useKits, useMine, useRoom, type Entry } from '../src/state/library.ts';
import { runStarted, useRun } from '../src/state/run.ts';
import { NO_EDITS } from '../src/components/lab/model.ts';

// My Library (src/state/library.ts): what is this phone's, what is saved, and each kit's photos, kept in step with the
// run (src/state/run.ts). A Map stands in for localStorage.

function phone({ full = false } = {}) {
  const kept = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => kept.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (full) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      kept.set(k, v);
    },
    removeItem: (k: string) => kept.delete(k),
  });
  return kept;
}

const summary = (id: string, title: string, catalogs: string[] = []): ProtocolSummary => ({ id, title, kit: `${title} Kit`, catalogs, procedure: 'Microplate', steps: 7, updated: 0 });
const LIST = [summary('atp', 'ATP Assay', ['ab83355']), summary('bca', 'Pierce BCA Protein Assay', ['23225', '23227']), summary('bradford', 'Pierce Bradford Protein Assay', ['23200'])];

beforeEach(() => {
  phone();
  useMine.setState({ protocols: {} });
  useKits.setState({ kits: {} });
  useRoom.setState({ full: false });
  useRun.setState({ protocolId: null, step: 0, done: {}, timers: {}, readings: {}, photos: {}, edits: NO_EDITS });
});
afterEach(() => vi.unstubAllGlobals());

describe('librarySections', () => {
  it('puts each protocol in one list: saved, then used here, then the rest Chapp has read', () => {
    const mine: Record<string, Entry> = {
      bca: { usedAt: 5, savedAt: 9 },
      bradford: { usedAt: 7, savedAt: null },
      atp: { usedAt: 3, savedAt: null },
    };
    const { saved, recent, others } = librarySections(LIST, mine);
    expect(saved.map(r => r.id)).toEqual(['bca']);
    expect(recent.map(r => r.id)).toEqual(['bradford', 'atp']);
    expect(others).toEqual([]);
    expect(librarySections(LIST, {}).others.map(r => r.id)).toEqual(['atp', 'bca', 'bradford']);
  });

  it('orders Saved by when it was saved, and keeps one gone from this computer by its saved title', () => {
    const { saved } = librarySections(LIST, { bca: { usedAt: null, savedAt: 1 }, old: { usedAt: null, savedAt: 2, title: 'Old Kit' } });
    expect(saved.map(r => [r.id, r.title, r.summary === null])).toEqual([
      ['old', 'Old Kit', true],
      ['bca', 'Pierce BCA Protein Assay', false],
    ]);
  });

  it('searches titles, kit names and catalog numbers in every list', () => {
    const s = librarySections(LIST, { bca: { usedAt: 1, savedAt: 1 } }, '23200');
    expect([...s.saved, ...s.recent, ...s.others].map(r => r.id)).toEqual(['bradford']);
    expect(librarySections(LIST, { bca: { usedAt: 1, savedAt: 1 } }, 'bca').saved.map(r => r.id)).toEqual(['bca']);
  });
});

describe('the run and its kit', () => {
  it('keeps each kit’s photos with it, and brings them back when that kit is the run again', () => {
    useRun.getState().setProtocol('bca');
    useRun.getState().setPhoto('reagent-a', 'A.jpg');
    expect(kitPhotos('bca')).toEqual({ 'reagent-a': 'A.jpg' });

    // Another kit: none of BCA's photos, even for a bottle with the same id.
    useRun.getState().setProtocol('bradford');
    expect(useRun.getState().photos).toEqual({});
    useRun.getState().setPhoto('reagent-a', 'Coomassie.jpg');

    useRun.getState().setProtocol('bca');
    expect(useRun.getState().photos).toEqual({ 'reagent-a': 'A.jpg' });
    expect(kitPhotos('bradford')).toEqual({ 'reagent-a': 'Coomassie.jpg' });
  });

  it('counts every protocol the run used as this phone’s', () => {
    useRun.getState().setProtocol('atp');
    useRun.getState().setProtocol('bca');
    const mine = useMine.getState().protocols;
    expect(Object.keys(mine).sort()).toEqual(['atp', 'bca']);
    expect(mine.bca!.usedAt).toBeGreaterThanOrEqual(mine.atp!.usedAt!);
    expect(mine.bca!.savedAt).toBeNull();
  });

  it('knows when a run is under way', () => {
    const s = useRun.getState();
    expect(runStarted(s)).toBe(false);
    expect(runStarted({ ...s, done: { A: true } })).toBe(true);
    expect(runStarted({ ...s, edits: { moved: {}, added: [{ name: 'control', wells: ['H1'] }] } })).toBe(true);
  });
});

describe('Save to library', () => {
  it('saves and takes out again, staying in Recent when the phone used it', () => {
    const kept = phone();
    useRun.getState().setProtocol('bca');
    expect(saveProtocol('bca', { title: 'Pierce BCA Protein Assay' })).toBe(true);
    expect(JSON.parse(kept.get('chapp.mine')!).state.protocols.bca.title).toBe('Pierce BCA Protein Assay');
    expect(librarySections(LIST, useMine.getState().protocols).saved.map(r => r.id)).toEqual(['bca']);
    unsaveProtocol('bca');
    const after = librarySections(LIST, useMine.getState().protocols);
    expect(after.saved).toEqual([]);
    expect(after.recent.map(r => r.id)).toEqual(['bca']);
  });

  it('takes a protocol never used here back to the rest when it is taken out', () => {
    saveProtocol('atp');
    unsaveProtocol('atp');
    expect(useMine.getState().protocols).toEqual({});
  });

  it('says so when the phone has no room', () => {
    phone({ full: true });
    expect(saveProtocol('bca')).toBe(false);
    expect(useRoom.getState().full).toBe(true);
  });
});

describe('bringIn', () => {
  it('brings in what the earlier build saved and the run as it is', () => {
    const kept = phone();
    kept.set('chapp.saved', JSON.stringify({ state: { kits: { atp: { savedAt: 4, photos: { probe: 'P.jpg' } } } }, version: 0 }));
    bringIn({ protocolId: 'bca', photos: { 'reagent-a': 'A.jpg' } });
    expect(useMine.getState().protocols.atp).toMatchObject({ savedAt: 4 });
    expect(useMine.getState().protocols.bca!.usedAt).not.toBeNull();
    expect(kitPhotos('atp')).toEqual({ probe: 'P.jpg' });
    expect(kitPhotos('bca')).toEqual({ 'reagent-a': 'A.jpg' });
    expect(kept.has('chapp.saved')).toBe(false);
  });
});
