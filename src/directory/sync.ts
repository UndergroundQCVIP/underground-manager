/**
 * LA CONFRÉRIE — Public Creator Directory Synchronization
 * Maintains separate, compact Regular and Retro listings with independent refreshes.
 */

import { getClubName, getConfig } from "../config.ts";
import { creatorCollection, listCreators } from "../db/creators.ts";
import {
  checkpointDirectoryCollection,
  getDirectorySyncState,
} from "../db/directory.ts";
import { logAuditEvent } from "../db/audit.ts";
import { CollectionCategory, Creator } from "../types.ts";
import type { MessageEntity } from "@grammyjs/types";
import { directoryNavKeyboard, syncNavigationMessages } from "../navigation/service.ts";
import { listMediaIndex } from "../db/media_index.ts";
import { getKv } from "../db/kv.ts";
import { withDirectoryLock } from "./lock.ts";
import { formatTorontoDate } from "../util/time.ts";
import { isMessageGone, isMessageNotModified, sha256Hex } from "../wanted/service.ts";

export interface DirectoryApiLike {
  sendMessage(
    chatId: number | string,
    text: string,
    options?: Record<string, unknown>
  ): Promise<{ message_id: number }>;
  editMessageText(
    chatId: number | string,
    messageId: number,
    text: string,
    options?: Record<string, unknown>
  ): Promise<unknown>;
  pinChatMessage(
    chatId: number | string,
    messageId: number
  ): Promise<unknown>;
  deleteMessage?(chatId: number | string, messageId: number): Promise<unknown>;
}

export function formatCreatorDate(isoString?: string): string {
  if (!isoString) return "Disponible";
  return formatTorontoDate(isoString, { month: "short", day: "numeric", year: "numeric" });
}

/** Creators whose first content appeared in the last 7 days are flagged 🆕 in the list. */
export const NEW_CREATOR_DAYS = 7;

export function isNewCreator(c: Creator, now: Date = new Date()): boolean {
  if (!c.firstContentDetectedAt) return false;
  const age = now.getTime() - new Date(c.firstContentDetectedAt).getTime();
  return age >= -60_000 && age < NEW_CREATOR_DAYS * 86_400_000;
}

/** Stable key of which creators are currently flagged new (used to detect flag changes). */
export function newCreatorsKey(creators: Creator[], now: Date = new Date()): string {
  return creators.filter((c) => isNewCreator(c, now)).map((c) => c.id).sort().join(",");
}

export const COLLECTION_LABELS: Record<CollectionCategory, string> = {
  regular: "toujours en activité",
  retro: "qui ne sont plus en activité",
};

/** Creators past an optional retirement date are no longer listed publicly. */
export function isRetired(c: Creator, nowMs = Date.now()): boolean {
  return !!c.retiredAt && new Date(c.retiredAt).getTime() <= nowMs;
}

/** Count unique indexed messages in the creator's CURRENT topic (never the old migration source). */
export async function directoryContentCounts(creators: Creator[]): Promise<Map<string, number>> {
  return new Map(await Promise.all(creators.map(async (c) => [
    c.id,
    (await listMediaIndex(c.id, { chatId: c.chatId, topicId: c.topicId })).length,
  ] as const)));
}

export const DIRECTORY_RENDER_VERSION = 4;
export interface DirectoryMessage {
  collection: CollectionCategory;
  text: string;
  entities: MessageEntity[];
}

export function datedDirectoryPage<T extends { text: string }>(message: T, refreshedAt: string, page = 0, pages = 1): T {
  const date = formatTorontoDate(refreshedAt, {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  return { ...message, text: message.text.trimEnd() + `\n\nMis à jour : ${date} (Montréal)` +
    (pages > 1 ? ` · Page ${page + 1}/${pages}` : "") };
}

type DirectoryOptions = { collection?: CollectionCategory; contentCounts?: ReadonlyMap<string, number> };

/** Text and explicit Telegram entities: usernames/names are never interpreted as markup. */
export function buildDirectoryMessages(
  allCreators: Creator[],
  botUsername: string,
  optsOrNow: DirectoryOptions | Date = {},
  nowArg?: Date
): DirectoryMessage[] {
  const opts = optsOrNow instanceof Date ? {} : optsOrNow;
  if (opts.collection && opts.collection !== "regular" && opts.collection !== "retro") return [];
  const now = optsOrNow instanceof Date ? optsOrNow : nowArg ?? new Date();
  const creators = allCreators
    .filter((c) => c.status === "active" && c.hasContent && !isRetired(c, now.getTime()))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  const categories: CollectionCategory[] = opts.collection ? [opts.collection] : ["regular", "retro"];
  const chunks: DirectoryMessage[] = [];
  for (const collection of categories) {
    const listed = creators.filter((c) => creatorCollection(c) === collection);
    const countLabel = (c: Creator): string => {
      const count = opts.contentCounts?.get(c.id);
      if (count === undefined || (count === 0 && c.inventoryStatus !== "complete")) return "?";
      return `${count}${c.inventoryStatus === "complete" ? "" : "+"}`;
    };
    const partial = listed.some((c) => /[+?]/.test(countLabel(c)));
    const prefix = "Voici la liste des créateurs ";
    const label = COLLECTION_LABELS[collection];
    const joinLink = `https://t.me/${botUsername}?start=join`;
    const introduction = `${prefix}${label} que nous avons chez ${getClubName()}.\n`;
    const joinLabel = "Rejoindre la plateforme";
    const header = introduction + joinLabel + "\n" +
      (partial ? `(? = total inconnu ; + = inventaire partiel)\n` : "") +
      (listed.some((c) => isNewCreator(c, now)) ? `🆕 = ajout récent\n` : "") + "\n";
    const freshChunk = (): DirectoryMessage => ({ collection, text: header, entities: [
      { type: "bold", offset: prefix.length, length: label.length },
      { type: "text_link", offset: introduction.length, length: joinLabel.length, url: joinLink },
    ] });
    let chunk = freshChunk();
    let rows = 0;
    if (!listed.length) chunk.text += "Aucun créateur disponible pour le moment.\n";
    for (const c of listed) {
      const name = c.name.replace(/\s+/g, " ").trim();
      const badge = isNewCreator(c, now) ? "🆕 " : "";
      const row = `${badge}${name} (${countLabel(c)})\n`;
      // Bound both visible text and entity count; long URLs no longer consume lines.
      if (chunk.text.length + row.length > 3500 || rows >= 80) {
        chunk.text = chunk.text.trimEnd();
        chunks.push(chunk);
        chunk = freshChunk();
        rows = 0;
      }
      chunk.entities.push({ type: "text_link", offset: chunk.text.length + badge.length,
        length: name.length, url: `https://t.me/${botUsername}?start=creator_${c.id}` });
      chunk.text += row;
      rows++;
    }
    chunk.text = chunk.text.trimEnd();
    chunks.push(chunk);
  }
  return chunks;
}

/** Plain-text compatibility helper; publishers must use the accompanying entities. */
export function buildDirectorySections(
  creators: Creator[], botUsername: string, optsOrNow: DirectoryOptions | Date = {}, now?: Date
): string[] {
  return buildDirectoryMessages(creators, botUsername, optsOrNow, now).map((m) => m.text);
}

export function computeContentHash(chunks: readonly (string | DirectoryMessage)[]): Promise<string> {
  return sha256Hex(JSON.stringify(chunks));
}

/** Used at startup and by the minute worker, so fixes/dirty content reach the actual channel. */
export async function syncDirectoryIfNeeded(api: DirectoryApiLike): Promise<SyncDirectoryResult> {
  const channelId = getConfig().PUBLIC_DIRECTORY_CHAT_ID;
  if (!channelId) return { updated: false, publishedCount: 0, reason: "channel_not_configured" };
  const state = await getDirectorySyncState();
  const stale = (["regular", "retro"] as const).some((c) =>
    state.collections?.[c]?.renderVersion !== DIRECTORY_RENDER_VERSION ||
    state.collections?.[c]?.channelId !== channelId);
  if (!state.isDirty && !stale) return { updated: false, publishedCount: 0, reason: "not_dirty" };
  return await syncPublicDirectory(api);
}

export interface SyncDirectoryResult {
  updated: boolean;
  publishedCount: number;
  reason?: string;
  error?: string;
}

/** Links to the actual saved channel posts, including every continuation chunk. */
export async function directoryPostLinks(collection?: CollectionCategory): Promise<{ label: string; url: string }[]> {
  const channelId = getConfig().PUBLIC_DIRECTORY_CHAT_ID;
  if (!String(channelId).startsWith("-100")) return [];
  const state = await getDirectorySyncState();
  const collections: CollectionCategory[] = collection ? [collection] : ["regular", "retro"];
  return collections.flatMap((category) => {
    const slot = state.collections?.[category];
    if (slot?.channelId !== channelId) return [];
    return slot.publishedMessageIds.map((id, i, ids) => ({
      label: `📚 ${category === "regular" ? "En activité" : "Plus en activité"}${ids.length > 1 ? ` (${i + 1}/${ids.length})` : ""}`,
      url: `https://t.me/c/${String(channelId).slice(4)}/${id}`,
    }));
  });
}

/** Refresh just one collection, or both for the scheduled synchronization. */
export async function syncPublicDirectory(
  api: DirectoryApiLike,
  force = false,
  collection?: CollectionCategory
): Promise<SyncDirectoryResult> {
  if (collection && collection !== "regular" && collection !== "retro") {
    return { updated: false, publishedCount: 0, reason: "private_collection" };
  }
  if (!getConfig().PUBLIC_DIRECTORY_CHAT_ID) {
    return { updated: false, publishedCount: 0, reason: "channel_not_configured" };
  }
  const result = await directoryJob(async () => {
    const state = await getDirectorySyncState();
    // Upgrade the legacy combined posts once, reusing their IDs for Regular.
    const migrating = !state.collections && state.publishedMessageIds.length > 0;
    const categories: CollectionCategory[] = collection && !migrating ? [collection] : ["regular", "retro"];
    let publishedCount = 0;
    let updated = false;
    let reason = "not_dirty";
    const errors: string[] = [];
    for (const category of categories) {
      const result = await syncCollection(api, force, category);
      if (result.error) errors.push(`${COLLECTION_LABELS[category]}: ${result.error}`);
      publishedCount += result.publishedCount;
      updated ||= result.updated;
      reason = result.reason ?? reason;
    }
    if (errors.length) return { updated: false, publishedCount, error: errors.join("; ") };
    return { updated, publishedCount, ...(updated ? {} : { reason }) };
  });
  if (result.updated) {
    // A deleted/recreated directory post changes its URL in the Accueil menu too.
    await syncNavigationMessages(api, { only: "accueil" }).catch(error => console.error("[Accueil navigation]", error));
  }
  return result;
}

async function directoryJob(job: () => Promise<SyncDirectoryResult>): Promise<SyncDirectoryResult> {
  const result = await withDirectoryLock(job);
  return result.result ?? { updated: false, publishedCount: 0, reason: "sync_in_progress" };
}

const pageKey = (collection: CollectionCategory, generation: string, page: number) =>
  ["directory_page", collection, generation, page];

/** Reads only the saved public snapshot; private creator topics can never enter a page. */
export async function showDirectoryPage(
  api: DirectoryApiLike, chatId: number, messageId: number, collection: CollectionCategory, page: number,
): Promise<SyncDirectoryResult> {
  if (chatId !== getConfig().PUBLIC_DIRECTORY_CHAT_ID || !["regular", "retro"].includes(collection)) {
    return { updated: false, publishedCount: 0, reason: "wrong_destination" };
  }
  return await directoryJob(async () => {
    const slot = (await getDirectorySyncState()).collections?.[collection];
    if (!slot || slot.channelId !== chatId || slot.publishedMessageIds[0] !== messageId ||
      !slot.pageGeneration || !slot.refreshedAt || !Number.isSafeInteger(page) || page < 0 || page >= (slot.pageCount ?? 0)) {
      return { updated: false, publishedCount: 0, reason: "stale_page" };
    }
    const message = (await (await getKv()).get<DirectoryMessage>(pageKey(collection, slot.pageGeneration, page))).value;
    if (!message) return { updated: false, publishedCount: 0, reason: "stale_page" };
    try {
      await api.editMessageText(chatId, messageId, datedDirectoryPage(message, slot.refreshedAt, page, slot.pageCount).text, {
        entities: message.entities, link_preview_options: { is_disabled: true },
        reply_markup: directoryNavKeyboard(collection, page, slot.pageCount),
      });
    } catch (error) { if (!isMessageNotModified(error)) throw error; }
    await checkpointDirectoryCollection(collection, { activePage: page });
    return { updated: true, publishedCount: 1 };
  });
}

async function syncCollection(
  api: DirectoryApiLike,
  force: boolean,
  collection: CollectionCategory
): Promise<SyncDirectoryResult> {
  const config = getConfig();
  const channelId = config.PUBLIC_DIRECTORY_CHAT_ID;
  const state = await getDirectorySyncState();
  const slot = state.collections?.[collection];
  const seqAtStart = state.dirtySeq ?? 0;
  const creators = await listCreators({ status: "active", hasContentOnly: true, collection });
  const newKey = `${newCreatorsKey(creators)}|${creators.filter((c) => !isRetired(c)).map((c) => c.id).sort().join(",")}`;
  const currentLayout = slot?.renderVersion === DIRECTORY_RENDER_VERSION && slot?.channelId === channelId;
  if (!force && currentLayout && slot && slot.syncedSeq === seqAtStart && slot.lastNewKey === newKey && !slot.lastError) {
    return { updated: false, publishedCount: 0, reason: "not_dirty" };
  }
  const chunks = buildDirectoryMessages(creators, config.BOT_USERNAME, {
    collection,
    contentCounts: await directoryContentCounts(creators),
  });
  const contentHash = await computeContentHash(chunks);
  const existingIds = slot?.channelId !== undefined && slot.channelId !== channelId ? [] :
    slot?.publishedMessageIds ?? (collection === "regular" && !state.collections ? state.publishedMessageIds : []);
  if (!force && currentLayout && slot?.lastContentHash === contentHash && !slot.lastError) {
    await checkpointDirectoryCollection(collection, { lastContentHash: contentHash, lastNewKey: newKey }, seqAtStart);
    return { updated: false, publishedCount: 0, reason: "content_identical" };
  }

  // Cache pages separately to stay within the KV value limit, even for very large lists.
  const kv = await getKv();
  for (const [page, message] of chunks.entries()) await kv.set(pageKey(collection, contentHash, page), message);
  const refreshedAt = new Date().toISOString();
  const publishedIds: number[] = [];
  try {
    // Telegram has a message size limit. Pagination keeps exactly one managed post per list.
    const message = datedDirectoryPage(chunks[0], refreshedAt, 0, chunks.length);
    const options = {
      entities: message.entities,
      link_preview_options: { is_disabled: true },
      reply_markup: directoryNavKeyboard(collection, 0, chunks.length),
    };
    if (existingIds[0]) {
      try {
        await api.editMessageText(channelId, existingIds[0], message.text, options);
        publishedIds.push(existingIds[0]);
      } catch (err) {
        if (isMessageNotModified(err)) publishedIds.push(existingIds[0]);
        else if (isMessageGone(err)) publishedIds.push((await api.sendMessage(channelId, message.text, options)).message_id);
        else throw err;
      }
    } else publishedIds.push((await api.sendMessage(channelId, message.text, options)).message_id);
    // Save the root before cleanup so an interrupted sync reuses it on retry.
    await checkpointDirectoryCollection(collection, {
      publishedMessageIds: [...publishedIds, ...existingIds.slice(1)],
      pageCount: chunks.length, activePage: 0, pageGeneration: contentHash, refreshedAt,
    });
    for (const id of existingIds.slice(1)) {
      if (api.deleteMessage) {
        try { await api.deleteMessage(channelId, id); }
        catch (err) {
          const error = String(err).toLowerCase();
          if (isMessageGone(err) || error.includes("message to delete not found")) continue;
          if (!error.includes("can't be deleted") && !error.includes("cannot be deleted")) throw err;
          // Telegram may refuse deletion of older posts. Remove the obsolete list by editing it.
          try {
            await api.editMessageText(channelId, id, "📚 Ce répertoire a été regroupé. Consultez les messages épinglés.", {
              reply_markup: directoryNavKeyboard(collection),
            });
          } catch (editError) {
            if (!isMessageGone(editError) && !isMessageNotModified(editError)) throw editError;
          }
        }
      }
    }
    if (publishedIds[0] !== existingIds[0]) {
      await api.pinChatMessage(channelId, publishedIds[0]).catch(() => {});
    }
    await checkpointDirectoryCollection(collection, {
      publishedMessageIds: publishedIds,
      renderVersion: DIRECTORY_RENDER_VERSION,
      channelId,
      lastContentHash: contentHash,
      lastNewKey: newKey,
      pageCount: chunks.length,
      activePage: 0,
      pageGeneration: contentHash,
      refreshedAt,
    }, seqAtStart);
    if (slot?.pageGeneration && slot.pageGeneration !== contentHash) {
      for (let page = 0; page < (slot.pageCount ?? 0); page++) await kv.delete(pageKey(collection, slot.pageGeneration, page));
    }
    await logAuditEvent("directory_synced", {
      collection, creatorsCount: creators.length, messageChunks: publishedIds.length, channelId,
    }, 0);
    return { updated: true, publishedCount: publishedIds.length };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`Directory synchronization failed (${collection}):`, error);
    await checkpointDirectoryCollection(collection, {
      publishedMessageIds: [...publishedIds, ...existingIds.slice(publishedIds.length)],
      lastError: error.slice(0, 300),
    });
    return { updated: false, publishedCount: 0, error };
  }
}
