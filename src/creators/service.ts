/**
 * Underground Manager — Creator & Forum Topic Service
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
import { Creator } from "../types.ts";

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
  const config = getConfig();

  // Only manage topics in TOKEBEC VIP COLLECTIONS
  if (chatId !== config.VIP_COLLECTIONS_CHAT_ID) {
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
    createdAt: now,
    updatedAt: now,
  };

  // Check if there is an existing Wanted List candidate for this creator
  const wantedCandidate = await getWantedCandidateByName(name);
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
  const config = getConfig();
  if (chatId !== config.VIP_COLLECTIONS_CHAT_ID) {
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

export async function handleMediaUpload(
  chatId: number,
  topicId: number,
  senderUserId: number,
  /** Telegram message.date (unix seconds): the real upload time. */
  messageDateUnix?: number
): Promise<Creator | null> {
  const config = getConfig();

  // Only monitor media uploads inside TOKEBEC VIP COLLECTIONS
  if (chatId !== config.VIP_COLLECTIONS_CHAT_ID) {
    return null;
  }

  // Only authorized administrators or system accounts may update collection status
  if (!isAdministrator(senderUserId)) {
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
      createdAt: now,
      updatedAt: now,
    };
    await saveCreator(creator);
  }

  // Check matching wanted candidate
  const wanted = await getWantedCandidateByName(trimmed);
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
