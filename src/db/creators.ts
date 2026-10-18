/**
 * Underground Manager — Creator Repository
 * Manages forum topics representing creators in TOKEBEC VIP COLLECTIONS.
 */

import { getKv } from "./kv.ts";
import { Creator } from "../types.ts";
import { markDirectoryDirty } from "./directory.ts";

export function normalizeCreatorName(name: string): string {
  return name.trim().toLowerCase();
}

export async function saveCreator(creator: Creator): Promise<void> {
  const kv = await getKv();
  const atomic = kv.atomic();

  atomic.set(["creators", creator.id], creator);
  atomic.set(["creators_by_topic", creator.chatId, creator.topicId], creator.id);
  atomic.set(["creators_by_name", creator.normalizedName], creator.id);

  const res = await atomic.commit();
  if (!res.ok) {
    throw new Error(`Failed to commit creator save for ${creator.name}`);
  }

  await markDirectoryDirty();
}

export async function getCreator(id: string): Promise<Creator | null> {
  const kv = await getKv();
  const res = await kv.get<Creator>(["creators", id]);
  return res.value ?? null;
}

export async function getCreatorByTopic(
  chatId: number,
  topicId: number
): Promise<Creator | null> {
  const kv = await getKv();
  const idRes = await kv.get<string>(["creators_by_topic", chatId, topicId]);
  if (!idRes.value) return null;
  return getCreator(idRes.value);
}

export async function getCreatorByName(name: string): Promise<Creator | null> {
  const normalized = normalizeCreatorName(name);
  const kv = await getKv();
  const idRes = await kv.get<string>(["creators_by_name", normalized]);
  if (!idRes.value) return null;
  return getCreator(idRes.value);
}

export async function listCreators(filter?: {
  status?: "active" | "archived";
  hasContentOnly?: boolean;
}): Promise<Creator[]> {
  const kv = await getKv();
  const iter = kv.list<Creator>({ prefix: ["creators"] });
  const results: Creator[] = [];

  for await (const entry of iter) {
    const creator = entry.value;
    if (!creator) continue;

    if (filter?.status && creator.status !== filter.status) {
      continue;
    }
    if (filter?.hasContentOnly && !creator.hasContent) {
      continue;
    }
    results.push(creator);
  }

  // Sort alphabetically by name
  return results.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  );
}

export async function updateCreatorName(
  id: string,
  newName: string
): Promise<Creator | null> {
  const kv = await getKv();
  const current = await getCreator(id);
  if (!current) return null;

  const oldNormalized = current.normalizedName;
  const newNormalized = normalizeCreatorName(newName);
  const now = new Date().toISOString();

  const updated: Creator = {
    ...current,
    name: newName.trim(),
    normalizedName: newNormalized,
    updatedAt: now,
  };

  const atomic = kv.atomic();
  atomic.set(["creators", id], updated);
  if (oldNormalized !== newNormalized) {
    atomic.delete(["creators_by_name", oldNormalized]);
  }
  atomic.set(["creators_by_name", newNormalized], id);

  const res = await atomic.commit();
  if (!res.ok) {
    throw new Error(`Failed to update creator name for ${id}`);
  }

  await markDirectoryDirty();
  return updated;
}

export async function recordCreatorMediaUpload(
  chatId: number,
  topicId: number
): Promise<Creator | null> {
  const kv = await getKv();
  const creator = await getCreatorByTopic(chatId, topicId);
  if (!creator) return null;

  const now = new Date().toISOString();
  const updated: Creator = {
    ...creator,
    hasContent: true,
    firstContentDetectedAt: creator.firstContentDetectedAt ?? now,
    lastContentUpdatedAt: now,
    updatedAt: now,
  };

  await kv.set(["creators", creator.id], updated);
  await markDirectoryDirty();
  return updated;
}

export async function archiveCreator(id: string): Promise<Creator | null> {
  const kv = await getKv();
  const creator = await getCreator(id);
  if (!creator) return null;

  const updated: Creator = {
    ...creator,
    status: "archived",
    updatedAt: new Date().toISOString(),
  };

  await kv.set(["creators", id], updated);
  await markDirectoryDirty();
  return updated;
}

export async function linkCreatorToWantedList(
  creatorId: string,
  wantedListId: string
): Promise<void> {
  const kv = await getKv();
  const creator = await getCreator(creatorId);
  if (!creator) return;

  const updated: Creator = {
    ...creator,
    wantedListId,
    updatedAt: new Date().toISOString(),
  };

  await kv.set(["creators", creatorId], updated);
}
