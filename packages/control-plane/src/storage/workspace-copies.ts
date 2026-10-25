/**
 * Workspace copies: the sandbox's project files (its `/workspace`, plus the
 * agent's conversation), archived by the sandbox and kept in the media store
 * next to the session's media. A saved sandbox lives in a provider snapshot;
 * when that snapshot is gone, a fresh sandbox unpacks the newest copy instead
 * of starting empty.
 *
 *   sessions/<session>/workspace/<time>-<id>.tar.zst   (or .tar.gz)
 *
 * The time is fixed-width UTC, so keys sort oldest first by name too.
 */

import type { DirectObjectTransfer, StoredObjectSummary } from "./direct-transfer";

/** How many copies a session keeps; older ones are deleted when a new one lands. */
export const WORKSPACE_COPIES_KEPT = 3;
/** The largest copy accepted. */
export const WORKSPACE_COPY_MAX_BYTES = 16 * 1024 * 1024 * 1024;
/** How long the URL a fresh sandbox downloads its copy from stays valid. */
export const WORKSPACE_COPY_DOWNLOAD_TTL_SECONDS = 60 * 60;

export const WORKSPACE_COPY_EXTENSIONS = ["tar.zst", "tar.gz"] as const;
export type WorkspaceCopyExtension = (typeof WORKSPACE_COPY_EXTENSIONS)[number];

function workspaceCopyPrefix(sessionId: string): string {
  return `sessions/${sessionId}/workspace/`;
}

export function buildWorkspaceCopyKey(
  sessionId: string,
  copyId: string,
  extension: WorkspaceCopyExtension,
  nowMs: number
): string {
  // 20261002T030405678Z: fixed width, to the millisecond, so names sort by time.
  const stamp = new Date(nowMs).toISOString().replace(/[-:.]/g, "");
  return `${workspaceCopyPrefix(sessionId)}${stamp}-${copyId}.${extension}`;
}

/** Whether `key` is a copy of this session's workspace, in a shape this module writes. */
export function isWorkspaceCopyKey(sessionId: string, key: string): boolean {
  const prefix = workspaceCopyPrefix(sessionId);
  if (!key.startsWith(prefix)) return false;
  return /^\d{8}T\d{9}Z-[A-Za-z0-9-]+\.tar\.(zst|gz)$/.test(key.slice(prefix.length));
}

/** The session's copies, oldest first. */
async function listWorkspaceCopies(
  direct: DirectObjectTransfer,
  sessionId: string
): Promise<StoredObjectSummary[]> {
  const copies = await direct.list(workspaceCopyPrefix(sessionId));
  return copies
    .filter((copy) => isWorkspaceCopyKey(sessionId, copy.key))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** A URL the newest copy can be downloaded from, or null when the session has none. */
export async function latestWorkspaceCopyUrl(
  direct: DirectObjectTransfer,
  sessionId: string
): Promise<string | null> {
  const latest = (await listWorkspaceCopies(direct, sessionId)).at(-1);
  if (!latest) return null;
  return direct.signGet(latest.key, { expiresInSeconds: WORKSPACE_COPY_DOWNLOAD_TTL_SECONDS });
}

/** Deletes all but the newest `keep` copies; returns the keys it deleted. */
export async function pruneWorkspaceCopies(
  direct: DirectObjectTransfer,
  deleteObject: (key: string) => Promise<void>,
  sessionId: string,
  keep = WORKSPACE_COPIES_KEPT
): Promise<string[]> {
  const copies = await listWorkspaceCopies(direct, sessionId);
  const stale = copies.slice(0, Math.max(0, copies.length - keep)).map((copy) => copy.key);
  for (const key of stale) await deleteObject(key);
  return stale;
}
