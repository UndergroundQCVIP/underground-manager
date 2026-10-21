/**
 * LA CONFRÉRIE — Directory Sync State Repository
 */

import { getKv } from "./kv.ts";
import { CollectionCategory, DirectoryCollectionState, DirectorySyncState } from "../types.ts";

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

/** Checkpoint one collection without overwriting concurrent uploads or the other collection. */
export async function checkpointDirectoryCollection(
  collection: CollectionCategory,
  patch: Partial<DirectoryCollectionState>,
  completedSeq?: number
): Promise<void> {
  const kv = await getKv();
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await kv.get<DirectorySyncState>(DIRECTORY_STATE_KEY);
    const current = res.value ?? { publishedMessageIds: [], isDirty: true, dirtySeq: 0 };
    const collections = { ...current.collections };
    collections[collection] = {
      publishedMessageIds: collection === "regular" && !current.collections
        ? current.publishedMessageIds : [],
      ...collections[collection],
      ...patch,
      ...(completedSeq !== undefined ? {
        syncedSeq: completedSeq,
        lastSyncAt: new Date().toISOString(),
        lastError: undefined,
      } : {}),
    };
    const slots = [collections.regular, collections.retro];
    const next: DirectorySyncState = {
      ...current,
      collections,
      publishedMessageIds: slots.flatMap((s) => s?.publishedMessageIds ?? []),
      isDirty: slots.some((s) => !s || s.lastError || s.syncedSeq !== (current.dirtySeq ?? 0)),
      lastSyncAt: completedSeq !== undefined ? new Date().toISOString() : current.lastSyncAt,
      lastAttemptAt: new Date().toISOString(),
      lastError: slots.find((s) => s?.lastError)?.lastError,
    };
    const commit = await kv.atomic().check(res).set(DIRECTORY_STATE_KEY, next).commit();
    if (commit.ok) return;
  }
  throw new Error("Could not checkpoint directory collection (write conflict)");
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
