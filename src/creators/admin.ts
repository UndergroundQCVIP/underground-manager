/**
 * LA CONFRÉRIE — Administrator Creator Tools (UG-04)
 * Manual media inventory, inventory attestation, retirement and directory repair.
 */

import { getConfig } from "../config.ts";
import { getKv } from "../db/kv.ts";
import { logAuditEvent } from "../db/audit.ts";
import {
  creatorCollection,
  getCreator,
  getCreatorByName,
  listCreators,
  patchCreatorFields,
  relocateCreator,
} from "../db/creators.ts";
import { markDirectoryDirty } from "../db/directory.ts";
import { listMediaIndex, parseTopicMessageLink, recordMediaIndex } from "../db/media_index.ts";
import { getActiveMigrationForCreator } from "../db/migrations.ts";
import { Creator } from "../types.ts";

export async function resolveCreator(input: string): Promise<Creator | null> {
  const trimmed = input.trim();
  return (await getCreator(trimmed)) ?? (await getCreatorByName(trimmed));
}

export interface IndexMediaResult {
  added: number;
  alreadyIndexed: number;
  rejected: { link: string; reason: string }[];
}

/**
 * Manually inventory older media by topic message links
 * (https://t.me/c/<chat>/<topic>/<message>). The topic segment in each link is
 * checked against the creator's mapping, so a message from another creator's
 * topic can never be added (and later copied) by mistake.
 */
export async function indexMediaFromLinks(
  adminId: number,
  creator: Creator,
  links: string[]
): Promise<IndexMediaResult> {
  const result: IndexMediaResult = { added: 0, alreadyIndexed: 0, rejected: [] };
  const existing = new Set((await listMediaIndex(creator.id)).map((e) => `${e.chatId}:${e.topicId}:${e.messageId}`));

  for (const link of links) {
    const parsed = parseTopicMessageLink(link);
    if (!parsed) {
      result.rejected.push({ link, reason: "Ce n'est pas un lien de message de sujet (attendu : https://t.me/c/<forum>/<sujet>/<message>)." });
      continue;
    }
    if (parsed.chatId !== creator.chatId || parsed.topicId !== creator.topicId) {
      result.rejected.push({ link, reason: `Appartient à un autre forum ou sujet que celui de ${creator.name}.` });
      continue;
    }
    const key = `${parsed.chatId}:${parsed.topicId}:${parsed.messageId}`;
    if (existing.has(key)) {
      result.alreadyIndexed++;
      continue;
    }
    await recordMediaIndex({
      creatorId: creator.id,
      chatId: parsed.chatId,
      topicId: parsed.topicId,
      messageId: parsed.messageId,
      kind: "unknown",
      hasCaption: false,
      source: "manual",
      recordedAt: new Date().toISOString(),
    });
    existing.add(key);
    result.added++;
  }

  if (result.added > 0) {
    await logAuditEvent("media_indexed", { creatorId: creator.id, added: result.added }, adminId);
  }
  return result;
}

/** Administrator attests that every media message of this creator is now inventoried. */
export async function attestInventoryComplete(adminId: number, creator: Creator): Promise<Creator | null> {
  const count = (await listMediaIndex(creator.id, { chatId: creator.chatId, topicId: creator.topicId })).length;
  if (count === 0) return null;
  return await patchCreatorFields(creator.id, { inventoryStatus: "complete", inventoryAttestedBy: adminId });
}

export async function setRetirement(creator: Creator, isoDateOrClear: string): Promise<Creator | null> {
  if (isoDateOrClear.toLowerCase() === "clear") {
    return await patchCreatorFields(creator.id, { retiredAt: undefined });
  }
  const d = new Date(isoDateOrClear);
  if (isNaN(d.getTime())) return null;
  return await patchCreatorFields(creator.id, { retiredAt: d.toISOString() });
}

export interface RepairReport {
  checked: number;
  indexesRepaired: number;
  duplicateNames: string[];
}

/** Rebuild creator lookup indexes from the authoritative creator records. */
export async function repairDirectory(): Promise<RepairReport> {
  const kv = await getKv();
  const creators = await listCreators();
  let indexesRepaired = 0;
  const seen = new Map<string, string>();
  const duplicateNames: string[] = [];

  for (const c of creators) {
    const topicIdx = await kv.get<string>(["creators_by_topic", c.chatId, c.topicId]);
    if (topicIdx.value !== c.id) {
      await kv.set(["creators_by_topic", c.chatId, c.topicId], c.id);
      indexesRepaired++;
    }
    const nameIdx = await kv.get<string>(["creators_by_name", c.normalizedName]);
    if (nameIdx.value !== c.id) {
      await kv.set(["creators_by_name", c.normalizedName], c.id);
      indexesRepaired++;
    }
    const other = seen.get(c.normalizedName);
    if (other && other !== c.id) duplicateNames.push(c.name);
    seen.set(c.normalizedName, c.id);
  }
  await markDirectoryDirty();
  return { checked: creators.length, indexesRepaired, duplicateNames };
}

export function collectionLabel(c: Creator): string {
  return creatorCollection(c) === "retro" ? "Retro" : "Regular";
}

/**
 * Fallback when Telegram content protection blocks copying: the administrator
 * republishes the media in a Retro topic from authorized source files, then
 * links that topic to the EXISTING creator (same internal ID, no duplicate).
 */
export async function relinkCreatorToRetroTopic(
  adminId: number,
  creator: Creator,
  retroTopicId: number
): Promise<{ ok: boolean; error?: string }> {
  const config = getConfig();
  if (!config.TELEGRAM_RETRO_FORUM_CHAT_ID) return { ok: false, error: "Le forum Retro n'est pas configuré." };
  if (creatorCollection(creator) !== "regular") return { ok: false, error: "Le créateur est déjà dans la collection Retro." };
  if (creator.rightsStatus !== "verified") {
    return { ok: false, error: "Les droits de publication et de distribution ne sont pas vérifiés pour ce créateur (lancez « Passer à Retro » pour les confirmer)." };
  }
  const job = await getActiveMigrationForCreator(creator.id);
  if (job && ["copying", "needs_review", "ready_to_finalize", "finalized"].includes(job.status)) {
    return { ok: false, error: `Une migration est ${job.status.replace(/_/g, " ")} ; terminez-la ou annulez-la d'abord.` };
  }
  const { getCreatorByTopic } = await import("../db/creators.ts");
  const occupied = await getCreatorByTopic(config.TELEGRAM_RETRO_FORUM_CHAT_ID, retroTopicId);
  if (occupied && occupied.id !== creator.id) {
    return { ok: false, error: `Ce sujet Retro appartient déjà à ${occupied.name}.` };
  }
  await relocateCreator(creator.id, {
    chatId: config.TELEGRAM_RETRO_FORUM_CHAT_ID,
    topicId: retroTopicId,
    collection: "retro",
  });
  await logAuditEvent(
    "creator_collection_changed",
    { creatorId: creator.id, from: "regular", to: "retro", method: "manual_republish", topicId: retroTopicId },
    adminId
  );
  return { ok: true };
}
