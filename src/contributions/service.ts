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
  if (!creator || creator.status !== "active") return { ok: false, error: "Creator not found." };

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
  if (!c) return { ok: false, error: "You have no open contribution." };
  if (c.items.length === 0) return { ok: false, error: "Send at least one photo or video first." };

  const submitted = await transitionContribution(c.id, ["collecting"], (x) => {
    x.status = "pending";
    x.submittedAt = new Date().toISOString();
  });
  if (!submitted) return { ok: false, error: "This contribution was already submitted." };
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
        `📥 *New contribution for ${submitted.creatorName}*\n` +
        `${submitted.items.length} item(s) from user \`${userId}\` — preview above.\n` +
        `Approve to publish into the creator's topic, or reject.`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [[
              { text: "✅ Approve & publish", callback_data: `cadm:ok:${submitted.id}` },
              { text: "❌ Reject", callback_data: `cadm:no:${submitted.id}` },
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
  if (!updated) return { ok: false, error: "This contribution is no longer awaiting review." };
  await logAuditEvent("contribution_rejected", { contributionId: id }, adminId, updated.userId);
  await api.sendMessage(
    updated.userId,
    `Thanks for your contribution for *${updated.creatorName}*. It was not accepted this time.`,
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
  if (!current) return { ok: false, error: "Contribution not found." };
  const creator = await getCreator(current.creatorId);
  if (!creator) return { ok: false, error: "Creator no longer exists." };

  // Don't add content to a topic that is mid-migration (it would be missed by the copy).
  const mig = await getActiveMigrationForCreator(creator.id);
  if (mig && ["copying", "needs_review", "ready_to_finalize", "paused"].includes(mig.status)) {
    return { ok: false, error: `${creator.name} is being migrated (${mig.status.replace(/_/g, " ")}). Approve after it is finalized or cancelled.` };
  }

  // Claim: only one approval can ever publish this contribution.
  const claimed = await transitionContribution(id, ["pending", "failed"], (x) => {
    x.status = "publishing";
    x.reviewedBy = adminId;
    x.reviewedAt = new Date().toISOString();
  });
  if (!claimed) return { ok: false, error: "This contribution is no longer awaiting review." };

  const ids = claimed.items.map((i) => i.messageId).sort((a, b) => a - b);
  let copies: { message_id: number }[];
  try {
    copies = await api.copyMessages(creator.chatId, claimed.userId, ids, { message_thread_id: creator.topicId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String((err as { description?: string })?.description ?? err);
    await transitionContribution(id, ["publishing"], (x) => {
      x.status = "failed";
      x.note = `Publishing failed: ${msg}`;
    });
    return { ok: false, error: `Publishing failed: ${msg}` };
  }

  if (copies.length !== ids.length) {
    // Some originals no longer exist (e.g., the member deleted them); do not retry blindly.
    await transitionContribution(id, ["publishing"], (x) => {
      x.status = "needs_review";
      x.publishedMessageIds = copies.map((c) => c.message_id);
      x.note = `Requested ${ids.length}, Telegram published ${copies.length}. Check the topic.`;
    });
    if (copies.length > 0) await recordPublished(creator.id, creator.chatId, creator.topicId, claimed, copies);
    return { ok: false, error: `Only ${copies.length} of ${ids.length} items could be published (originals may have been deleted). Check the topic.`, published: copies.length };
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
    `✅ Your contribution for *${creator.name}* was approved and published in ${getClubName()}. Thank you!`,
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
