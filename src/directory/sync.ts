/**
 * LA CONFRÉRIE — Public Creator Directory Synchronization
 * Maintains ONE pinned, alphabetically sorted listing of Regular and Retro creators.
 */

import { getClubName, getConfig } from "../config.ts";
import { creatorCollection, listCreators } from "../db/creators.ts";
import {
  clearDirectoryDirty,
  getDirectorySyncState,
  saveDirectorySyncState,
} from "../db/directory.ts";
import { logAuditEvent } from "../db/audit.ts";
import { CollectionCategory, Creator } from "../types.ts";
import { escapeMd } from "../util/markdown.ts";
import { directoryNavKeyboard } from "../navigation/service.ts";
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
  optsOrNow: { collection?: CollectionCategory } | Date = {},
  nowArg?: Date
): string[] {
  const opts = optsOrNow instanceof Date ? {} : optsOrNow;
  const now = optsOrNow instanceof Date ? optsOrNow : nowArg ?? new Date();
  const club = getClubName();
  const creators = allCreators
    .filter((c) => !isRetired(c, now.getTime()))
    .filter((c) => !opts.collection || creatorCollection(c) === opts.collection)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

  if (creators.length === 0) {
    return [
      `💎 *${club} | RÉPERTOIRE DES CRÉATEURS*\n\n` +
      `_Aucune collection publique n'est disponible actuellement._\n` +
      `_De nouvelles collections sont ajoutées régulièrement par nos conservateurs._`,
    ];
  }

  const anyNew = creators.some((c) => isNewCreator(c, now));
  const nowFormatted = formatTorontoDate(now, {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const filterNote = opts.collection ? ` — ${COLLECTION_LABELS[opts.collection]} seulement` : "";
  let currentChunk =
    `💎 *${club} | RÉPERTOIRE DES CRÉATEURS*${filterNote}\n` +
    `📅 *Répertoire mis à jour :* ${nowFormatted}\n` +
    `🔒 _Ouvrez le robot ${club} pour vérifier votre accès_\n` +
    (anyNew ? `🆕 _= ajout récent (${NEW_CREATOR_DAYS} derniers jours)_\n` : "") +
    `\n`;

  const chunks: string[] = [];
  const push = (block: string) => {
    // Keep each Telegram message under the safe chunk size
    if (currentChunk.length + block.length > 3500) {
      chunks.push(currentChunk.trim());
      currentChunk = `💎 *${club} | RÉPERTOIRE DES CRÉATEURS (suite)*\n\n${block}`;
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
      const first = (c.name.normalize("NFD")[0] || "#").toUpperCase();
      const letter = /[A-Z]/.test(first) ? first : "#";
      (grouped[letter] ??= []).push(c);
    }
    for (const letter of Object.keys(grouped).sort()) {
      let sectionText = `*${letter}*\n`;
      for (const c of grouped[letter]) {
        const updateStr = formatCreatorDate(c.lastContentUpdatedAt);
        const deepLink = `https://t.me/${botUsername}?start=creator_${c.id}`;
        const label = COLLECTION_LABELS[creatorCollection(c)];
        const badge = isNewCreator(c, now) ? "🆕 " : "• ";
        sectionText += `${badge}*${escapeMd(c.name)}* — ${label} — ${updateStr} [🔍 Voir](${deepLink})\n`;
      }
      push(sectionText + "\n");
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

  const seqAtStart = syncState.dirtySeq ?? 0;

  // Fetch only active creators with confirmed media content
  const creators = await listCreators({
    status: "active",
    hasContentOnly: true,
  });
  const newKey = newCreatorsKey(creators);

  // Skip (no Telegram calls) unless forced, changed, or a 🆕 flag has just expired.
  if (!force && !syncState.isDirty && (syncState.lastNewKey ?? "") === newKey) {
    return { updated: false, publishedCount: 0, reason: "not_dirty" };
  }

  const chunks = buildDirectorySections(creators, config.BOT_USERNAME);
  // Hash the creator-driven content, not the "Updated: <today>" header, so a
  // day passing never by itself triggers an edit.
  const contentHash = await computeContentHash(
    chunks.map((c) => c.replace(/📅 \*Répertoire mis à jour :\*[^\n]*\n/, ""))
  );

  if (!force && syncState.lastContentHash === contentHash) {
    // Content is identical, clear dirty flag and skip editing
    await clearDirectoryDirty(contentHash, syncState.publishedMessageIds, seqAtStart, newKey);
    return { updated: false, publishedCount: 0, reason: "content_identical" };
  }

  const publishedIds: number[] = [];
  const existingIds = syncState.publishedMessageIds || [];

  try {
    for (let i = 0; i < chunks.length; i++) {
      const chunkText = chunks[i];
      // The navigation keyboard is re-sent with every edit: editing a message without
      // a reply_markup would otherwise strip its buttons on the daily update.
      const options = {
        parse_mode: "Markdown",
        disable_web_page_preview: true,
        reply_markup: directoryNavKeyboard(),
      };

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

    await clearDirectoryDirty(contentHash, publishedIds, seqAtStart, newKey);

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
