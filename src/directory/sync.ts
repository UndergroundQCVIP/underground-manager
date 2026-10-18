/**
 * Underground Manager — Public Creator Directory Synchronization
 * Maintains pinned, alphabetically sorted creator listings in the public directory channel.
 */

import { getConfig } from "../config.ts";
import { listCreators } from "../db/creators.ts";
import {
  clearDirectoryDirty,
  getDirectorySyncState,
} from "../db/directory.ts";
import { logAuditEvent } from "../db/audit.ts";
import { Creator } from "../types.ts";

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
}

export function formatCreatorDate(isoString?: string): string {
  if (!isoString) return "Available";
  const date = new Date(isoString);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
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

  const nowFormatted = new Date().toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  // Group creators by initial letter
  const grouped: Record<string, Creator[]> = {};
  for (const c of creators) {
    const letter = (c.name[0] || "#").toUpperCase();
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
      sectionText += `• *${c.name}* — ${updateStr} [🔍 View](${deepLink})\n`;
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

export function computeContentHash(chunks: string[]): string {
  const combined = chunks.join("---CHUNK---");
  let hash = 0;
  for (let i = 0; i < combined.length; i++) {
    hash = (hash << 5) - hash + combined.charCodeAt(i);
    hash |= 0;
  }
  return String(hash);
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

  // Fetch only active creators with confirmed media content
  const creators = await listCreators({
    status: "active",
    hasContentOnly: true,
  });

  const chunks = buildDirectorySections(creators, config.BOT_USERNAME);
  const contentHash = computeContentHash(chunks);

  if (!force && syncState.lastContentHash === contentHash) {
    // Content is identical, clear dirty flag and skip editing
    await clearDirectoryDirty(contentHash, syncState.publishedMessageIds);
    return { updated: false, publishedCount: 0, reason: "content_identical" };
  }

  const publishedIds: number[] = [];

  try {
    const existingIds = syncState.publishedMessageIds || [];

    for (let i = 0; i < chunks.length; i++) {
      const chunkText = chunks[i];
      if (i < existingIds.length) {
        // Edit existing message
        const msgId = existingIds[i];
        try {
          await api.editMessageText(channelId, msgId, chunkText, {
            parse_mode: "Markdown",
            disable_web_page_preview: true,
          });
          publishedIds.push(msgId);
        } catch {
          // If edit fails (e.g. message deleted), send new message
          const newMsg = await api.sendMessage(channelId, chunkText, {
            parse_mode: "Markdown",
            disable_web_page_preview: true,
          });
          publishedIds.push(newMsg.message_id);
        }
      } else {
        // Send new message for additional chunk
        const newMsg = await api.sendMessage(channelId, chunkText, {
          parse_mode: "Markdown",
          disable_web_page_preview: true,
        });
        publishedIds.push(newMsg.message_id);
      }
    }

    // Pin first directory message
    if (publishedIds.length > 0) {
      try {
        await api.pinChatMessage(channelId, publishedIds[0]);
      } catch {
        // Non-critical if bot lacks pin permission
      }
    }

    await clearDirectoryDirty(contentHash, publishedIds);

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
    return {
      updated: false,
      publishedCount: 0,
      error: errorMsg,
    };
  }
}
