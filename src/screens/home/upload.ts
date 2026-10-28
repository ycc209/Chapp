import { create } from 'zustand';
import type { ProtocolIntro } from '../../../shared/ai.ts';
import { api } from '../../api/client.ts';

/**
 * A kit manual the user picked from the + menu (Home-Plus.dc.html's Upload), being read into a protocol by the server
 * (POST /api/import-protocol). It starts the moment the file is picked, so the Overview it opens on only watches it.
 * Kept in memory for this page load: a reload shows the protocol as it is, without the reading.
 */
export type Upload = {
  id: string;
  /** The file's name, shown as what the user gave Chapp. */
  name: string;
  /** What Chapp said while reading ("Reading the manual", "Turning it into steps"), in order. */
  lines: string[];
  /** What the kit is, read within seconds, while its steps are still being read. */
  intro?: ProtocolIntro;
  /** The protocol it became, once read and saved. */
  protocolId?: string;
  /** Why it could not be read, fit to show. */
  error?: string;
};

export const useUploads = create<{ uploads: Record<string, Upload> }>(() => ({ uploads: {} }));

const update = (id: string, change: (u: Upload) => Partial<Upload>) =>
  useUploads.setState(s => {
    const u = s.uploads[id];
    return u ? { uploads: { ...s.uploads, [id]: { ...u, ...change(u) } } } : s;
  });

let count = 0;

/** Sends the PDF to be read; returns the id the Overview follows it by (location.state.upload). */
export function startUpload(pdf: File): string {
  const id = `upload-${Date.now().toString(36)}-${++count}`;
  useUploads.setState(s => ({ uploads: { ...s.uploads, [id]: { id, name: pdf.name || 'manual.pdf', lines: [] } } }));
  const heard = (line: string) => update(id, u => ({ lines: [...u.lines, line] }));
  api.importProtocol(pdf, pdf.name, heard, undefined, intro => update(id, () => ({ intro }))).then(
    imported => update(id, () => ({ protocolId: imported.protocol.id })),
    (error: unknown) => update(id, () => ({ error: error instanceof Error ? error.message : String(error) })),
  );
  return id;
}
