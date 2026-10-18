/**
 * Underground Manager — Public Creator Directory Synchronization
 * Maintains pinned, alphabetically sorted creator listings in the public directory channel.
 */

import { getConfig } from "../config.ts";
import { listCreators } from "../db/creators.ts";
import {
  clearDirectoryDirty,
  getDirectorySyncState,
  saveDirectorySyncState,
} from "../db/directory.ts";
import { logAuditEvent } from "../db/audit.ts";
import { Creator } from "../types.ts";
import { escapeMd } from "../util/markdown.ts";
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
  if (!isoString) return "Available";
  return formatTorontoDate(isoString, { month: "short", day: "numeric", year: "numeric" });
}

export function buildDirectorySections(
  creators: Creator[],
  botUsername: string
): string[] {
  if (creators.length === 0) {
    return [
      `💎 *UNDERGROUND | CREATOR DIRECTORY*\n\n` +
      `_No public collections are currently available._\n` +
      `_New collections are added regularly by our curators._`,
    ];
  }

  const nowFormatted = formatTorontoDate(new Date(), {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  // Group creators by initial letter
  const grouped: Record<string, Creator[]> = {};
  for (const c of creators) {
    const first = (c.name.normalize("NFD")[0] || "#").toUpperCase();
    const letter = /[A-Z]/.test(first) ? first : "#";
    if (!grouped[letter]) {
      grouped[letter] = [];
    }
    grouped[letter].push(c);
  }

  const sortedLetters = Object.keys(grouped).sort();
  const chunks: string[] = [];

  let currentChunk =
    `💎 *UNDERGROUND | CREATOR DIRECTORY*\n` +
    `_Curated archives in TOKEBEC VIP COLLECTIONS_\n` +
    `📅 *Directory Updated:* ${nowFormatted}\n` +
    `🔒 _Subscribe via Underground Manager for instant access_\n\n`;

  for (const letter of sortedLetters) {
    let sectionText = `*${letter}*\n`;
    for (const c of grouped[letter]) {
      const updateStr = formatCreatorDate(c.lastContentUpdatedAt);
      const deepLink = `https://t.me/${botUsername}?start=creator_${c.id}`;
      sectionText += `• *${escapeMd(c.name)}* — ${updateStr} [🔍 View](${deepLink})\n`;
    }
    sectionText += "\n";

    // If adding this section exceeds Telegram safe chunk size (3500 chars), push and start new chunk
    if (currentChunk.length + sectionText.length > 3500) {
      chunks.push(currentChunk.trim());
      currentChunk = `💎 *UNDERGROUND | CREATOR DIRECTORY (Cont.)*\n\n${sectionText}`;
    } else {
      currentChunk += sectionText;
    }
  }

  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

export function computeContentHash(chunks: string[]): Promise<string> {
  return sha256Hex(chunks.join("---CHUNK---"));
}

export interface SyncDirectoryResult {
  updated: boolean;
  publishedCount: number;
  reason?: string;
  error?: string;
}

export async function syncPublicDirectory(
  api: DirectoryApiLike,
  force = false
): Promise<SyncDirectoryResult> {
  const config = getConfig();
  const channelId = config.PUBLIC_DIRECTORY_CHAT_ID;

  if (!channelId) {
    return { updated: false, publishedCount: 0, reason: "channel_not_configured" };
  }

  const syncState = await getDirectorySyncState();

  // If not forced and not dirty, skip to preserve low API consumption
  if (!force && !syncState.isDirty) {
    return { updated: false, publishedCount: 0, reason: "not_dirty" };
  }
  const seqAtStart = syncState.dirtySeq ?? 0;

  // Fetch only active creators with confirmed media content
  const creators = await listCreators({
    status: "active",
    hasContentOnly: true,
  });

  const chunks = buildDirectorySections(creators, config.BOT_USERNAME);
  // Hash the creator-driven content, not the "Updated: <today>" header, so a
  // day passing never by itself triggers an edit.
  const contentHash = await computeContentHash(
    chunks.map((c) => c.replace(/📅 \*Directory Updated:\*[^\n]*\n/, ""))
  );

  if (!force && syncState.lastContentHash === contentHash) {
    // Content is identical, clear dirty flag and skip editing
    await clearDirectoryDirty(contentHash, syncState.publishedMessageIds, seqAtStart);
    return { updated: false, publishedCount: 0, reason: "content_identical" };
  }

  const publishedIds: number[] = [];
  const existingIds = syncState.publishedMessageIds || [];

  try {
    for (let i = 0; i < chunks.length; i++) {
      const chunkText = chunks[i];
      const options = { parse_mode: "Markdown", disable_web_page_preview: true };

      if (i < existingIds.length) {
        const msgId = existingIds[i];
        try {
          await api.editMessageText(channelId, msgId, chunkText, options);
          publishedIds.push(msgId);
        } catch (err) {
          if (isMessageNotModified(err)) {
            publishedIds.push(msgId); // already shows exactly this text
          } else if (isMessageGone(err)) {
            // Only a message that no longer exists is replaced. Any other failure
            // (rate limit, network) aborts so a retry cannot post duplicates.
            const newMsg = await api.sendMessage(channelId, chunkText, options);
            publishedIds.push(newMsg.message_id);
          } else {
            throw err;
          }
        }
      } else {
        const newMsg = await api.sendMessage(channelId, chunkText, options);
        publishedIds.push(newMsg.message_id);
      }
    }

    // Remove stale trailing messages left over when the directory shrank.
    if (api.deleteMessage) {
      for (const staleId of existingIds.slice(chunks.length)) {
        try {
          await api.deleteMessage(channelId, staleId);
        } catch { /* already gone */ }
      }
    }

    // Pin only when the first message changed: every pin posts a service message.
    if (publishedIds.length > 0 && publishedIds[0] !== existingIds[0]) {
      try {
        await api.pinChatMessage(channelId, publishedIds[0]);
      } catch {
        // Non-critical if bot lacks pin permission
      }
    }

    await clearDirectoryDirty(contentHash, publishedIds, seqAtStart);

    await logAuditEvent(
      "directory_synced",
      {
        creatorsCount: creators.length,
        messageChunks: publishedIds.length,
        channelId,
      },
      0
    );

    return { updated: true, publishedCount: publishedIds.length };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("Directory synchronization failed:", errorMsg);
    // Keep any messages created before the failure so the retry edits them
    // instead of posting a second copy.
    if (publishedIds.length > 0) {
      const merged = [...publishedIds, ...existingIds.slice(publishedIds.length)];
      await clearDirectoryDirtyKeepDirty(syncState, merged).catch(() => {});
    }
    return {
      updated: false,
      publishedCount: 0,
      error: errorMsg,
    };
  }
}

async function clearDirectoryDirtyKeepDirty(
  state: Awaited<ReturnType<typeof getDirectorySyncState>>,
  messageIds: number[]
): Promise<void> {
  await saveDirectorySyncState({ ...state, publishedMessageIds: messageIds, isDirty: true });
}
