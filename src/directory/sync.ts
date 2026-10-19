/**
 * LA CONFRÉRIE — Public Creator Directory Synchronization
 * Maintains ONE pinned, alphabetically sorted listing of Regular and Retro creators.
 */

import { getClubName, getConfig } from "../config.ts";
import { creatorCollection, listCreators } from "../db/creators.ts";
import {
  clearDirectoryDirty,
  getDirectorySyncState,
} from "../db/directory.ts";
import { logAuditEvent } from "../db/audit.ts";
import { CollectionCategory, Creator } from "../types.ts";

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

export const COLLECTION_LABELS: Record<CollectionCategory, string> = {
  regular: "Regular",
  retro: "Retro",
};

/** Creators past an optional retirement date are no longer listed publicly. */
export function isRetired(c: Creator, nowMs = Date.now()): boolean {
  return !!c.retiredAt && new Date(c.retiredAt).getTime() <= nowMs;
}

export function buildDirectorySections(
  allCreators: Creator[],
  botUsername: string,
  opts: { collection?: CollectionCategory } = {}
): string[] {
  const club = getClubName();
  const creators = allCreators
    .filter((c) => !isRetired(c))
    .filter((c) => !opts.collection || creatorCollection(c) === opts.collection)
    // Alphabetical across both categories
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

  if (creators.length === 0) {
    return [
      `💎 *${club} | CREATOR DIRECTORY*\n\n` +
      `_No public collections are currently available._\n` +
      `_New collections are added regularly by our curators._`,
    ];
  }

  const nowFormatted = new Date().toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const filterNote = opts.collection ? ` — ${COLLECTION_LABELS[opts.collection]} only` : "";
  let currentChunk =
    `💎 *${club} | CREATOR DIRECTORY*${filterNote}\n` +
    `📅 *Directory Updated:* ${nowFormatted}\n` +
    `🔒 _Open the ${club} bot to check your access_\n\n`;

  const chunks: string[] = [];
  const push = (block: string) => {
    // Keep each Telegram message under the safe chunk size
    if (currentChunk.length + block.length > 3500) {
      chunks.push(currentChunk.trim());
      currentChunk = `💎 *${club} | CREATOR DIRECTORY (Cont.)*\n\n${block}`;
    } else {
      currentChunk += block;
    }
  };

  // One section per forum, each alphabetical (A–Z) and labelled
  const sections: { collection: CollectionCategory; heading: string }[] = [
    { collection: "regular", heading: `📚 *REGULAR — TOKEBEC VIP COLLECTIONS*` },
    { collection: "retro", heading: `🎞️ *RETRO — RETRO | ${club}*` },
  ];
  for (const section of sections) {
    const inSection = creators.filter((c) => creatorCollection(c) === section.collection);
    if (inSection.length === 0) continue;

    push(`${section.heading} (${inSection.length})\n\n`);

    const grouped: Record<string, Creator[]> = {};
    for (const c of inSection) {
      const letter = (c.name[0] || "#").toUpperCase();
      (grouped[letter] ??= []).push(c);
    }
    for (const letter of Object.keys(grouped).sort()) {
      let sectionText = `*${letter}*\n`;
      for (const c of grouped[letter]) {
        const updateStr = formatCreatorDate(c.lastContentUpdatedAt);
        const deepLink = `https://t.me/${botUsername}?start=creator_${c.id}`;
        const label = COLLECTION_LABELS[creatorCollection(c)];
        sectionText += `• *${c.name}* — ${label} — ${updateStr} [🔍 View](${deepLink})\n`;
      }
      push(sectionText + "\n");
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
