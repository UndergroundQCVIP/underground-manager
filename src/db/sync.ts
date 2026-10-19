/**
 * LA CONFRÉRIE — Access Synchronization State
 */

import { getKv } from "./kv.ts";
import { AccessSyncState, SpaceId } from "../types.ts";

export async function recordSyncState(state: AccessSyncState): Promise<void> {
  const kv = await getKv();
  const atomic = kv.atomic();
  atomic.set(["sync_state", state.userId, state.spaceId], state);
  atomic.set(["synced_users_index", state.userId], Date.now());
  await atomic.commit();
}

export async function getSyncState(
  userId: number,
  spaceId: SpaceId
): Promise<AccessSyncState | null> {
  const kv = await getKv();
  const res = await kv.get<AccessSyncState>(["sync_state", userId, spaceId]);
  return res.value ?? null;
}

export async function listSyncStatesForUser(userId: number): Promise<AccessSyncState[]> {
  const kv = await getKv();
  const iter = kv.list<AccessSyncState>({ prefix: ["sync_state", userId] });
  const results: AccessSyncState[] = [];
  for await (const entry of iter) {
    if (entry.value) {
      results.push(entry.value);
    }
  }
  return results;
}

export async function listAllSyncedUserIds(): Promise<number[]> {
  const kv = await getKv();
  const iter = kv.list<number>({ prefix: ["synced_users_index"] });
  const userIds: number[] = [];
  for await (const entry of iter) {
    const userId = entry.key[1] as number;
    if (userId) {
      userIds.push(userId);
    }
  }
  return userIds;
}
