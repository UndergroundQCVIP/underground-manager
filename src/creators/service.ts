/**
 * LA CONFRÉRIE — Creator & Forum Topic Service
 * Orchestrates topic detection, media upload tracking, and wanted list linking.
 */

import { getConfig, isAdministrator } from "../config.ts";
import {
  archiveCreator,
  getCreator,
  getCreatorByName,
  getCreatorByTopic,
  listCreators,
  normalizeCreatorName,
  recordCreatorMediaUpload,
  saveCreator,
  updateCreatorName,
} from "../db/creators.ts";
import {
  getWantedCandidateByName,
  updateWantedStatus,
} from "../db/wanted.ts";
import { logAuditEvent } from "../db/audit.ts";
import { recordMediaIndex } from "../db/media_index.ts";
import { Creator, CreatorCollection, MediaIndexEntry } from "../types.ts";

/** Which collection a managed creator forum belongs to (null = unmanaged chat). */
export function collectionForChat(chatId: number): CreatorCollection | null {
  const config = getConfig();
  if (chatId === config.VIP_COLLECTIONS_CHAT_ID) return "regular";
  if (config.TELEGRAM_RETRO_FORUM_CHAT_ID && chatId === config.TELEGRAM_RETRO_FORUM_CHAT_ID) {
    return "retro";
  }
  if (config.TELEGRAM_AMATEUR_FORUM_CHAT_ID && chatId === config.TELEGRAM_AMATEUR_FORUM_CHAT_ID) return "amateur";
  return null;
}

// System / General topics that must never be registered as creators
const EXCLUDED_TOPIC_NAMES = new Set([
  "general",
  "announcements",
  "admin",
  "rules",
  "support",
  "help",
  "vip rules",
  "general chat",
]);

export async function handleForumTopicCreated(
  chatId: number,
  topicId: number,
  rawName: string
): Promise<Creator | null> {
  // Only manage topics in the Regular or Retro creator forums
  const collection = collectionForChat(chatId);
  if (!collection) {
    return null;
  }

  const name = rawName.trim();
  const normalized = normalizeCreatorName(name);

  // Exclude general/system topics
  if (EXCLUDED_TOPIC_NAMES.has(normalized)) {
    return null;
  }

  // Check if topic is already registered
  const existingByTopic = await getCreatorByTopic(chatId, topicId);
  if (existingByTopic) {
    return existingByTopic;
  }

  // Check if creator with same normalized name exists
  let creatorId: string = crypto.randomUUID();
  const existingByName = await getCreatorByName(name);

  // UG-04: ONE unified directory. A same-named topic appearing in the Retro
  // forum (e.g. created by the migration service, or pre-created by an admin
  // before a move) must never create a duplicate or overwrite the existing
  // creator record. Only the migration finalization step relocates a creator.
  if (collection === "retro" && existingByName) {
    return existingByName;
  }
  if (existingByName && (collection === "amateur" || existingByName.collection === "amateur")) {
    throw new Error("Ce nom est déjà associé à un autre sujet. Utilisez un nom distinct pour la collection privée.");
  }
  if (existingByName) {
    creatorId = existingByName.id;
  }

  const now = new Date().toISOString();
  const creator: Creator = {
    id: creatorId,
    name,
    normalizedName: normalized,
    chatId,
    topicId,
    topicCreatedAt: now,
    hasContent: false,
    status: "active",
    collection,
    rightsStatus: "unverified",
    // Tracked from the moment the topic was created, so uploads are all indexed.
    inventoryStatus: "complete",
    createdAt: now,
    updatedAt: now,
  };

  // Check if there is an existing Wanted List candidate for this creator
  const wantedCandidate = collection === "amateur" ? null : await getWantedCandidateByName(name);
  if (wantedCandidate) {
    creator.wantedListId = wantedCandidate.id;
    await updateWantedStatus(
      wantedCandidate.id,
      "available",
      `Connected to forum topic ${topicId}`,
      creator.id
    );
    await logAuditEvent(
      "wanted_status_updated",
      {
        candidateId: wantedCandidate.id,
        newStatus: "available",
        creatorId: creator.id,
      },
      0
    );
  }

  await saveCreator(creator);

  await logAuditEvent(
    "creator_registered",
    {
      creatorId: creator.id,
      name: creator.name,
      chatId,
      topicId,
      linkedWantedId: creator.wantedListId,
    },
    0
  );

  return creator;
}

export async function handleForumTopicEdited(
  chatId: number,
  topicId: number,
  rawNewName: string
): Promise<Creator | null> {
  if (!collectionForChat(chatId)) {
    return null;
  }

  const creator = await getCreatorByTopic(chatId, topicId);
  if (!creator) return null;

  const newName = rawNewName.trim();
  if (creator.name === newName) return creator;

  const updated = await updateCreatorName(creator.id, newName);

  await logAuditEvent(
    "creator_renamed",
    {
      creatorId: creator.id,
      oldName: creator.name,
      newName,
      topicId,
    },
    0
  );

  return updated;
}

export interface UploadedMediaInfo {
  messageId: number;
  kind: "photo" | "video";
  mediaGroupId?: string;
  hasCaption: boolean;
}

export async function handleMediaUpload(
  chatId: number,
  topicId: number,
  senderUserId: number,
  /** Telegram message.date (unix seconds): the real upload time. */
  messageDateUnix?: number,
  media?: UploadedMediaInfo,
  /**
   * The sender is known to be a group administrator posting anonymously ("as the group"):
   * Telegram then reports the group's anonymous bot as the user, which is not in ADMIN_USER_IDS.
   */
  options: { trustedAnonymousAdmin?: boolean } = {}
): Promise<Creator | null> {
  // Only monitor media uploads inside the Regular and Retro creator forums
  if (!collectionForChat(chatId)) {
    return null;
  }

  // Only authorized administrators or system accounts may update collection status
  if (!isAdministrator(senderUserId) && !options.trustedAnonymousAdmin) {
    return null;
  }

  // Find corresponding registered creator
  let creator = await getCreatorByTopic(chatId, topicId);

  // If topic wasn't registered yet, we do not guess name from media;
  // Admin must have created topic or register it.
  if (!creator) {
    return null;
  }

  const wasEmpty = !creator.hasContent;
  const contentAt = messageDateUnix ? new Date(messageDateUnix * 1000) : new Date();
  const updated = await recordCreatorMediaUpload(chatId, topicId, contentAt);

  // UG-04: keep the minimum necessary message inventory (IDs only) so this
  // collection can be copied between forums later.
  if (updated && media) {
    const entry: MediaIndexEntry = {
      creatorId: updated.id,
      chatId,
      topicId,
      messageId: media.messageId,
      kind: media.kind,
      mediaGroupId: media.mediaGroupId,
      hasCaption: media.hasCaption,
      source: "live",
      recordedAt: new Date().toISOString(),
    };
    await recordMediaIndex(entry);
  }

  if (updated) {
    await logAuditEvent(
      "creator_media_updated",
      {
        creatorId: updated.id,
        name: updated.name,
        topicId,
        firstContent: wasEmpty,
        senderUserId,
      },
      senderUserId
    );
  }

  return updated;
}

export async function registerOrRepairTopic(
  adminId: number,
  chatId: number,
  topicId: number,
  name: string
): Promise<Creator> {
  const trimmed = name.trim();
  const normalized = normalizeCreatorName(trimmed);
  const now = new Date().toISOString();

  let creator = await getCreatorByTopic(chatId, topicId);

  if (!creator) {
    const sameName = await getCreatorByName(trimmed);
    if (sameName && (sameName.collection === "amateur" || collectionForChat(chatId) === "amateur")) {
      throw new Error("Ce nom est déjà associé à un autre sujet. Utilisez un nom distinct pour la collection privée.");
    }
  }

  // One unified directory: a Retro topic may not duplicate a creator that already exists.
  if (!creator && (collectionForChat(chatId) === "retro" || collectionForChat(chatId) === "amateur")) {
    const sameName = await getCreatorByName(trimmed);
    if (sameName) {
      throw new Error(
        `« ${sameName.name} » existe déjà (${(sameName.collection ?? "regular") === "retro" ? "Retro" : "Regular"}). ` +
        `Utilisez « Passer à Retro » pour déplacer ce créateur, ou /relink_creator pour le relier à ce sujet.`
      );
    }
  }

  if (creator) {
    creator = (await updateCreatorName(creator.id, trimmed))!;
  } else {
    creator = {
      id: crypto.randomUUID(),
      name: trimmed,
      normalizedName: normalized,
      chatId,
      topicId,
      topicCreatedAt: now,
      hasContent: true, // Manually repaired by admin
      status: "active",
      collection: collectionForChat(chatId) ?? "regular",
      rightsStatus: "unverified",
      inventoryStatus: "partial", // Pre-existing media is not indexed
      createdAt: now,
      updatedAt: now,
    };
    await saveCreator(creator);
  }

  // Check matching wanted candidate
  const wanted = creator.collection === "amateur" ? null : await getWantedCandidateByName(trimmed);
  if (wanted) {
    await updateWantedStatus(wanted.id, "available", "Manually paired", creator.id);
  }

  await logAuditEvent(
    "creator_registered",
    {
      creatorId: creator.id,
      name: creator.name,
      chatId,
      topicId,
      manualRepair: true,
    },
    adminId
  );

  return creator;
}
