/**
 * LA CONFRÉRIE — Member Contributions (UG-04)
 *
 * A member picks a creator, sends photos/videos to the bot privately and taps
 * Finish. The submission waits for an administrator. On approval the BOT copies
 * the messages into the creator's topic (copyMessages), so the posts belong to
 * the bot: the contributor cannot edit or delete them afterwards.
 * No media is stored by us — only message IDs.
 */

import { getClubName, getConfig } from "../config.ts";
import { logAuditEvent } from "../db/audit.ts";
import { getCreator, recordCreatorMediaUpload } from "../db/creators.ts";
import {
  getActiveContribution,
  getContribution,
  saveContribution,
  transitionContribution,
} from "../db/contributions.ts";
import { getActiveMigrationForCreator } from "../db/migrations.ts";
import { recordMediaIndex } from "../db/media_index.ts";
import { Contribution, ContributionItem } from "../types.ts";

export interface ContributionApiLike {
  sendMessage(chatId: number | string, text: string, other?: Record<string, unknown>): Promise<unknown>;
  copyMessages(
    chatId: number | string,
    fromChatId: number | string,
    messageIds: number[],
    other?: { message_thread_id?: number }
  ): Promise<{ message_id: number }[]>;
}

export async function startContribution(
  userId: number,
  creatorId: string
): Promise<{ ok: boolean; contribution?: Contribution; error?: string }> {
  const creator = await getCreator(creatorId);
  if (!creator || creator.status !== "active") return { ok: false, error: "Créateur introuvable." };

  // Starting a new session replaces an unfinished one.
  const existing = await getActiveContribution(userId);
  if (existing) {
    await saveContribution({ ...existing, status: "cancelled" });
  }
  const now = new Date().toISOString();
  const contribution: Contribution = {
    id: crypto.randomUUID(),
    userId,
    creatorId: creator.id,
    creatorName: creator.name,
    items: [],
    status: "collecting",
    createdAt: now,
    updatedAt: now,
  };
  await saveContribution(contribution);
  return { ok: true, contribution };
}

export async function addContributionItem(
  userId: number,
  item: ContributionItem
): Promise<{ added: boolean; count: number; newAlbum: boolean; contribution?: Contribution }> {
  const c = await getActiveContribution(userId);
  if (!c) return { added: false, count: 0, newAlbum: false };
  if (c.items.some((i) => i.messageId === item.messageId)) {
    return { added: false, count: c.items.length, newAlbum: false, contribution: c };
  }
  const last = c.items[c.items.length - 1];
  const newAlbum = !(item.mediaGroupId && last?.mediaGroupId === item.mediaGroupId);
  c.items.push(item);
  await saveContribution(c);
  return { added: true, count: c.items.length, newAlbum, contribution: c };
}

export async function cancelContribution(userId: number): Promise<boolean> {
  const c = await getActiveContribution(userId);
  if (!c) return false;
  await saveContribution({ ...c, status: "cancelled" });
  return true;
}

/** Member taps Finish: submit for review and alert administrators with a preview. */
export async function finishContribution(
  api: ContributionApiLike,
  userId: number
): Promise<{ ok: boolean; contribution?: Contribution; error?: string }> {
  const c = await getActiveContribution(userId);
  if (!c) return { ok: false, error: "Vous n'avez aucune contribution en cours." };
  if (c.items.length === 0) return { ok: false, error: "Envoyez d'abord au moins une photo ou une vidéo." };

  const submitted = await transitionContribution(c.id, ["collecting"], (x) => {
    x.status = "pending";
    x.submittedAt = new Date().toISOString();
  });
  if (!submitted) return { ok: false, error: "Cette contribution a déjà été soumise." };
  await logAuditEvent(
    "contribution_submitted",
    { contributionId: submitted.id, creatorId: submitted.creatorId, items: submitted.items.length },
    userId,
    userId
  );

  // Alert admins (best effort): preview copy + review buttons.
  const ids = [...submitted.items.map((i) => i.messageId)].sort((a, b) => a - b);
  for (const adminId of getConfig().ADMIN_USER_IDS) {
    try {
      await api.copyMessages(adminId, userId, ids);
      await api.sendMessage(
        adminId,
        `📥 *Nouvelle contribution pour ${submitted.creatorName}*\n` +
        `${submitted.items.length} élément(s) de l'utilisateur \`${userId}\` — aperçu ci-dessus.\n` +
        `Approuvez pour publier dans le sujet du créateur, ou refusez.`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [[
              { text: "✅ Approuver et publier", callback_data: `cadm:ok:${submitted.id}` },
              { text: "❌ Refuser", callback_data: `cadm:no:${submitted.id}` },
            ]],
          },
        }
      );
    } catch (err) {
      console.error(`[Contributions] Could not notify admin ${adminId}:`, err);
    }
  }
  return { ok: true, contribution: submitted };
}

export async function rejectContribution(
  api: ContributionApiLike,
  id: string,
  adminId: number
): Promise<{ ok: boolean; error?: string }> {
  const updated = await transitionContribution(id, ["pending", "failed"], (x) => {
    x.status = "rejected";
    x.reviewedBy = adminId;
    x.reviewedAt = new Date().toISOString();
  });
  if (!updated) return { ok: false, error: "Cette contribution n'est plus en attente d'examen." };
  await logAuditEvent("contribution_rejected", { contributionId: id }, adminId, updated.userId);
  await api.sendMessage(
    updated.userId,
    `Merci pour votre contribution pour *${updated.creatorName}*. Elle n'a pas été acceptée cette fois-ci.`,
    { parse_mode: "Markdown" }
  ).catch(() => {});
  return { ok: true };
}

export async function approveContribution(
  api: ContributionApiLike,
  id: string,
  adminId: number
): Promise<{ ok: boolean; error?: string; published?: number }> {
  const current = await getContribution(id);
  if (!current) return { ok: false, error: "Contribution introuvable." };
  const creator = await getCreator(current.creatorId);
  if (!creator) return { ok: false, error: "Le créateur n'existe plus." };

  // Don't add content to a topic that is mid-migration (it would be missed by the copy).
  const mig = await getActiveMigrationForCreator(creator.id);
  if (mig && ["copying", "needs_review", "ready_to_finalize", "paused"].includes(mig.status)) {
    return { ok: false, error: `${creator.name} fait l'objet d'une migration (${mig.status.replace(/_/g, " ")}). Approuvez après sa finalisation ou son annulation.` };
  }

  // Claim: only one approval can ever publish this contribution.
  const claimed = await transitionContribution(id, ["pending", "failed"], (x) => {
    x.status = "publishing";
    x.reviewedBy = adminId;
    x.reviewedAt = new Date().toISOString();
  });
  if (!claimed) return { ok: false, error: "Cette contribution n'est plus en attente d'examen." };

  const ids = claimed.items.map((i) => i.messageId).sort((a, b) => a - b);
  let copies: { message_id: number }[];
  try {
    copies = await api.copyMessages(creator.chatId, claimed.userId, ids, { message_thread_id: creator.topicId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String((err as { description?: string })?.description ?? err);
    await transitionContribution(id, ["publishing"], (x) => {
      x.status = "failed";
      x.note = `Échec de la publication : ${msg}`;
    });
    return { ok: false, error: `Échec de la publication : ${msg}` };
  }

  if (copies.length !== ids.length) {
    // Some originals no longer exist (e.g., the member deleted them); do not retry blindly.
    await transitionContribution(id, ["publishing"], (x) => {
      x.status = "needs_review";
      x.publishedMessageIds = copies.map((c) => c.message_id);
      x.note = `Demandés : ${ids.length}, publiés par Telegram : ${copies.length}. Vérifiez le sujet.`;
    });
    if (copies.length > 0) await recordPublished(creator.id, creator.chatId, creator.topicId, claimed, copies);
    return { ok: false, error: `Seulement ${copies.length} élément(s) sur ${ids.length} ont pu être publiés (les originaux ont peut-être été supprimés). Vérifiez le sujet.`, published: copies.length };
  }

  await transitionContribution(id, ["publishing"], (x) => {
    x.status = "approved";
    x.publishedMessageIds = copies.map((c) => c.message_id);
  });
  await recordPublished(creator.id, creator.chatId, creator.topicId, claimed, copies);
  await logAuditEvent(
    "contribution_approved",
    { contributionId: id, creatorId: creator.id, items: ids.length },
    adminId,
    claimed.userId
  );
  await api.sendMessage(
    claimed.userId,
    `✅ Votre contribution pour *${creator.name}* a été approuvée et publiée dans ${getClubName()}. Merci !`,
    { parse_mode: "Markdown" }
  ).catch(() => {});
  return { ok: true, published: copies.length };
}

/** The bot does not receive updates for its own posts, so index them here. */
async function recordPublished(
  creatorId: string,
  chatId: number,
  topicId: number,
  c: Contribution,
  copies: { message_id: number }[]
): Promise<void> {
  const sorted = [...c.items].sort((a, b) => a.messageId - b.messageId);
  const now = new Date().toISOString();
  for (let i = 0; i < copies.length; i++) {
    const src = sorted[i];
    await recordMediaIndex({
      creatorId,
      chatId,
      topicId,
      messageId: copies[i].message_id,
      kind: src.kind,
      mediaGroupId: src.mediaGroupId ? `contrib:${c.id}:${src.mediaGroupId}` : undefined,
      hasCaption: false,
      source: "contribution",
      recordedAt: now,
    });
  }
  await recordCreatorMediaUpload(chatId, topicId); // updates "last content update" + directory
}
