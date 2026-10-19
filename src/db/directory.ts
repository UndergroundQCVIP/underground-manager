/**
 * Underground Manager — Directory Sync State Repository
 */

import { getKv } from "./kv.ts";
import { DirectorySyncState } from "../types.ts";

const DIRECTORY_STATE_KEY = ["directory_sync_state"];

export async function getDirectorySyncState(): Promise<DirectorySyncState> {
  const kv = await getKv();
  const res = await kv.get<DirectorySyncState>(DIRECTORY_STATE_KEY);
  return (
    res.value ?? {
      publishedMessageIds: [],
      isDirty: false,
      dirtySeq: 0,
    }
  );
}

export async function saveDirectorySyncState(
  state: DirectorySyncState
): Promise<void> {
  const kv = await getKv();
  await kv.set(DIRECTORY_STATE_KEY, state);
}

/**
 * Flags the directory as needing a refresh. Every call bumps `dirtySeq` so a sync
 * that is already running cannot clear a change made while it was in flight.
 */
export async function markDirectoryDirty(): Promise<void> {
  const kv = await getKv();
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await kv.get<DirectorySyncState>(DIRECTORY_STATE_KEY);
    const current: DirectorySyncState = res.value ?? {
      publishedMessageIds: [],
      isDirty: false,
      dirtySeq: 0,
    };
    const commit = await kv
      .atomic()
      .check(res)
      .set(DIRECTORY_STATE_KEY, {
        ...current,
        isDirty: true,
        dirtySeq: (current.dirtySeq ?? 0) + 1,
      })
      .commit();
    if (commit.ok) return;
  }
  throw new Error("Could not mark the creator directory dirty (write conflict)");
}

/**
 * Records a completed sync. The dirty flag is only cleared if no change was
 * recorded since the sync started (`seqAtStart`).
 */
export async function clearDirectoryDirty(
  newContentHash: string,
  publishedMessageIds: number[],
  seqAtStart?: number,
  newKey?: string
): Promise<void> {
  const kv = await getKv();
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await kv.get<DirectorySyncState>(DIRECTORY_STATE_KEY);
    const current = res.value;
    const seqNow = current?.dirtySeq ?? 0;
    const changedDuringSync = seqAtStart !== undefined && seqNow !== seqAtStart;
    const state: DirectorySyncState = {
      lastSyncAt: new Date().toISOString(),
      lastContentHash: newContentHash,
      publishedMessageIds,
      isDirty: changedDuringSync,
      dirtySeq: seqNow,
      lastNewKey: newKey ?? current?.lastNewKey,
    };
    const commit = await kv.atomic().check(res).set(DIRECTORY_STATE_KEY, state).commit();
    if (commit.ok) return;
  }
  throw new Error("Could not record directory sync state (write conflict)");
}
