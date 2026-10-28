import { StoredShare, type SharedSetup } from '../../../shared/share.ts';

/** The share routes (server/share.ts). A non-2xx answer throws with the server's message. */

async function call(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(path, init);
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const error = new Error((body as { error?: string } | null)?.error || `${res.status} ${res.statusText}`.trim());
    (error as Error & { status: number }).status = res.status;
    throw error;
  }
  return body;
}

export async function postShare(setup: SharedSetup, signal?: AbortSignal): Promise<string> {
  const body = await call('/api/share', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(setup), signal });
  return (body as { id: string }).id;
}

export async function getShare(id: string, signal?: AbortSignal): Promise<StoredShare> {
  return StoredShare.parse(await call(`/api/share/${encodeURIComponent(id)}`, { signal }));
}

/** True for the 404 of a share that is not on this server (an old code, or one from another computer). */
export const isMissing = (error: unknown) => (error as { status?: number } | null)?.status === 404;
