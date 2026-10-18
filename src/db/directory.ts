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
    }
  );
}

export async function saveDirectorySyncState(
  state: DirectorySyncState
): Promise<void> {
  const kv = await getKv();
  await kv.set(DIRECTORY_STATE_KEY, state);
}

export async function markDirectoryDirty(): Promise<void> {
  const kv = await getKv();
  const current = await getDirectorySyncState();
  if (!current.isDirty) {
    await kv.set(DIRECTORY_STATE_KEY, { ...current, isDirty: true });
  }
}

export async function clearDirectoryDirty(
  newContentHash: string,
  publishedMessageIds: number[]
): Promise<void> {
  const kv = await getKv();
  const state: DirectorySyncState = {
    lastSyncAt: new Date().toISOString(),
    lastContentHash: newContentHash,
    publishedMessageIds,
    isDirty: false,
  };
  await kv.set(DIRECTORY_STATE_KEY, state);
}
