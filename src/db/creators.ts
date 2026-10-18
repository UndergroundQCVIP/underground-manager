/**
 * Underground Manager — Creator Repository
 * Manages forum topics representing creators in TOKEBEC VIP COLLECTIONS.
 */

import { getKv } from "./kv.ts";
import { Creator } from "../types.ts";
import { markDirectoryDirty } from "./directory.ts";

/** Case- and whitespace-insensitive (NFKC) key used to de-duplicate creator names. */
export function normalizeCreatorName(name: string): string {
  return name
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
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

/** Compare-and-set update of a creator record (retries on concurrent writes). */
async function patchCreator(
  id: string,
  fn: (current: Creator) => Creator | null
): Promise<Creator | null> {
  const kv = await getKv();
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await kv.get<Creator>(["creators", id]);
    if (!res.value) return null;
    const next = fn(res.value);
    if (!next) return res.value;

    const atomic = kv.atomic().check(res).set(["creators", id], next);
    if (next.normalizedName !== res.value.normalizedName) {
      atomic.delete(["creators_by_name", res.value.normalizedName]);
      atomic.set(["creators_by_name", next.normalizedName], id);
    }
    const commit = await atomic.commit();
    if (commit.ok) return next;
  }
  throw new Error(`Creator ${id} could not be updated (persistent write conflict)`);
}

export async function updateCreatorName(
  id: string,
  newName: string
): Promise<Creator | null> {
  const trimmed = newName.trim();
  const updated = await patchCreator(id, (cur) => ({
    ...cur,
    name: trimmed,
    normalizedName: normalizeCreatorName(trimmed),
    updatedAt: new Date().toISOString(),
  }));
  if (updated) await markDirectoryDirty();
  return updated;
}

/**
 * Records an authorized photo/video upload. `contentAt` is the message's own
 * timestamp (not "now"), and the stored last-update never moves backwards, so a
 * late-delivered or out-of-order update cannot rewind the date shown publicly.
 */
export async function recordCreatorMediaUpload(
  chatId: number,
  topicId: number,
  contentAt: Date = new Date()
): Promise<Creator | null> {
  const existing = await getCreatorByTopic(chatId, topicId);
  if (!existing) return null;

  const at = contentAt.toISOString();
  const updated = await patchCreator(existing.id, (cur) => {
    const last = cur.lastContentUpdatedAt;
    const first = cur.firstContentDetectedAt;
    return {
      ...cur,
      hasContent: true,
      firstContentDetectedAt: first && first < at ? first : at,
      lastContentUpdatedAt: last && last > at ? last : at,
      updatedAt: new Date().toISOString(),
    };
  });
  if (updated) await markDirectoryDirty();
  return updated;
}

export async function archiveCreator(id: string): Promise<Creator | null> {
  const updated = await patchCreator(id, (cur) => ({
    ...cur,
    status: "archived",
    updatedAt: new Date().toISOString(),
  }));
  if (updated) await markDirectoryDirty();
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
