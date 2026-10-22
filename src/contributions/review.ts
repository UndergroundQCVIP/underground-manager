/** Shared moderation cards are refreshed from durable contribution state. */
import { getConfig } from "../config.ts";
import { getKv } from "../db/kv.ts";
import {
  getContribution,
  transitionContribution,
} from "../db/contributions.ts";
import { withJobLease } from "../ops/locks.ts";
import { type Contribution, WANTED_REQUEST_CLASSES } from "../types.ts";
import type { ContributionApiLike } from "./service.ts";

export function reviewCard(c: Contribution) {
  const states = {
    pending: "⏳ À examiner",
    publishing: "🔄 Publication en cours",
    approved: "✅ Approuvée",
    rejected: "❌ Refusée",
    failed: "⚠️ Échec de publication",
    needs_review: "🟠 Publication à vérifier",
    collecting: "Brouillon",
    cancelled: "Annulée",
  };
  const reward = c.decision?.type === "reward"
    ? `${c.decision.days} jours — ${c.decision.scopes.join(" + ")} (${
      c.rewardStatus ?? "en attente"
    })`
    : "aucune";
  const text = [
    `${states[c.status]} — ${c.creatorName}`,
    `Collection : ${c.proposal?.collection ?? "créateur existant"}`,
    `Contribution : ${c.id}`,
    `Contributeur : ${c.userId} · Éléments : ${c.itemCount ?? c.items.length}`,
    c.wantedRequest
      ? `Liste recherchée — ${
        WANTED_REQUEST_CLASSES[c.wantedRequest.category]
      } · Profil : ${c.wantedRequest.profileUrl}`
      : "",
    c.profileScreenshotMessageId
      ? "Capture du profil social incluse — à publier avec le contenu."
      : "",
    c.proposal?.profileUrl ? `Profil : ${c.proposal.profileUrl}` : "",
    c.reviewedBy
      ? `Décision : administrateur ${c.reviewedBy} · ${c.reviewedAt ?? ""}`
      : "Vérifier identité, majorité, consentement et droits de diffusion avant publication.",
    `Récompense : ${reward}`,
    c.rejectionReason ? `Raison : ${c.rejectionReason}` : "",
    c.note ? `Note : ${c.note}` : "",
  ].filter(Boolean).join("\n").slice(0, 3900);
  const rows = [[{
    text: "🔎 Examiner / actualiser",
    callback_data: `cadm:view:${c.id}`,
  }]];
  if (c.status === "pending" || c.status === "failed") {
    rows.push(
      [{
        text: "🎁 Approuver et récompenser",
        callback_data: `cadm:rw:${c.id}`,
      }],
      [{
        text: "✅ Approuver sans récompense",
        callback_data: `cadm:nr:${c.id}`,
      }],
      [{ text: "❌ Refuser", callback_data: `cadm:no:${c.id}` }],
    );
  }
  return {
    text,
    options: {
      reply_markup: { inline_keyboard: rows },
      link_preview_options: { is_disabled: true },
    },
  };
}

export async function notifyContributionReview(
  api: ContributionApiLike,
  id: string,
): Promise<void> {
  await withJobLease(`review_notification:${id}`, 90_000, async () => {
    const c = await getContribution(id);
    if (!c || c.status !== "pending" || c.reviewMessages?.length) return;
    const config = getConfig();
    const deliver = async (chatId: number) => {
      // Preview failures must not hide the moderation request.
      try {
        for (let i = 0; i < c.items.length; i += 50) {
          await api.copyMessages(
            chatId,
            c.userId,
            c.items.slice(i, i + 50).map((it) => it.messageId).sort((a, b) =>
              a - b
            ),
          );
        }
      } catch (error) {
        console.error("[Review] Preview unavailable:", error);
      }
      const card = reviewCard(c);
      const sent = await api.sendMessage(chatId, card.text, card.options) as {
        message_id?: number;
      } | undefined;
      if (sent?.message_id) {
        await transitionContribution(id, [
          "pending",
          "publishing",
          "approved",
          "failed",
          "rejected",
          "needs_review",
        ], (x) => {
          x.reviewMessages = [...(x.reviewMessages ?? []), {
            chatId,
            messageId: sent.message_id!,
          }];
        });
      }
    };
    if (config.TELEGRAM_ADMIN_REVIEW_CHAT_ID) {
      try {
        await deliver(config.TELEGRAM_ADMIN_REVIEW_CHAT_ID);
        return;
      } catch (error) {
        console.error(
          "[Review] Shared group unavailable; using admin inboxes:",
          error,
        );
      }
    }
    for (const admin of config.ADMIN_USER_IDS) {
      try {
        await deliver(admin);
      } catch (error) {
        console.error("[Review] Admin notification failed:", error);
      }
    }
  });
}

export async function syncContributionReview(
  api: ContributionApiLike,
  id: string,
): Promise<void> {
  if (!api.editMessageText) return;
  await withJobLease(`review_cards:${id}`, 60_000, async () => {
    const kv = await getKv();
    const dirty = await kv.get(["contribution_review_dirty", id]);
    const entry = await kv.get<Contribution>(["contributions", id]);
    if (!entry.value || !dirty.versionstamp) return;
    if (
      entry.value.status === "pending" && !entry.value.reviewMessages?.length
    ) return;
    const card = reviewCard(entry.value);
    for (const ref of entry.value.reviewMessages ?? []) {
      try {
        await api.editMessageText!(
          ref.chatId,
          ref.messageId,
          card.text,
          card.options,
        );
      } catch (error) {
        if (!String(error).includes("message is not modified")) throw error;
      }
    }
    await kv.atomic().check(dirty).check(entry).delete(dirty.key).commit();
  });
}

export async function flushContributionReviews(
  api: ContributionApiLike,
): Promise<void> {
  const kv = await getKv();
  for await (
    const entry of kv.list({ prefix: ["contribution_review_dirty"] })
  ) {
    const id = String(entry.key[1]);
    try {
      await notifyContributionReview(api, id);
      await syncContributionReview(api, id);
    } catch (error) {
      console.error("[Review] Card update will retry:", error);
    }
  }
}
