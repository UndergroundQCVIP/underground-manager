/**
 * LA CONFRÉRIE — Member Contributions (UG-04, extended in UG-05)
 *
 * A contributor picks an existing creator (or proposes a new one), sends
 * photos/videos to the bot privately and taps Finish. The submission waits for
 * an administrator, who decides separately (1) whether to publish and (2)
 * whether to reward the contributor with temporary access.
 *
 * On approval the BOT copies the messages into the creator's topic
 * (copyMessages), so the posts belong to the bot: the contributor cannot edit
 * or delete them afterwards. Only message IDs are stored, never media.
 *
 * Reward safety: a reward is only ever granted AFTER a fully successful
 * publication, at most once per submission (see rewards.ts).
 */

import { getClubName, getConfig } from "../config.ts";
import { logAuditEvent } from "../db/audit.ts";
import {
  creatorCollection,
  getCreator,
  getCreatorByName,
  listCreators,
  normalizeCreatorName,
  patchCreatorFields,
  recordCreatorMediaUpload,
} from "../db/creators.ts";
import {
  getActiveContribution,
  getContribution,
  saveContribution,
  transitionContribution,
} from "../db/contributions.ts";
import { getActiveMigrationForCreator } from "../db/migrations.ts";
import { recordMediaIndex } from "../db/media_index.ts";
import { contributionRewardsEnabled } from "../membership/mode.ts";
import { handleForumTopicCreated } from "../creators/service.ts";
import {
  CollectionCategory,
  Contribution,
  ContributionDecision,
  ContributionItem,
  Creator,
} from "../types.ts";
import { fmtDay, grantContributionReward, scopesLabel, validateRewardParams } from "./rewards.ts";

export interface ContributionApiLike {
  sendMessage(chatId: number | string, text: string, other?: Record<string, unknown>): Promise<unknown>;
  copyMessages(
    chatId: number | string,
    fromChatId: number | string,
    messageIds: number[],
    other?: { message_thread_id?: number }
  ): Promise<{ message_id: number }[]>;
  /** Needed only to approve a NEW creator proposal. */
  createForumTopic?(chatId: number | string, name: string): Promise<{ message_thread_id: number }>;
}

// ---------------------------------------------------------------------------
// Contributor side: sessions
// ---------------------------------------------------------------------------

export async function startContribution(
  userId: number,
  creatorId: string
): Promise<{ ok: boolean; contribution?: Contribution; error?: string }> {
  const creator = await getCreator(creatorId);
  if (!creator || creator.status !== "active") return { ok: false, error: "Créateur introuvable." };

  // Starting a new session replaces an unfinished one.
  const existing = await getActiveContribution(userId);
  if (existing) {
    await saveContribution({ ...existing, status: "cancelled", itemCount: existing.items.length, items: [] });
  }
  const now = new Date().toISOString();
  const contribution: Contribution = {
    id: crypto.randomUUID(),
    userId,
    creatorId: creator.id,
    creatorName: creator.name,
    items: [],
    status: "collecting",
    kind: "existing",
    createdAt: now,
    updatedAt: now,
  };
  await saveContribution(contribution);
  return { ok: true, contribution };
}

function editDistanceAtMostOne(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** Creators whose name equals, contains, or is one typo away from the proposed name. */
export async function findSimilarCreators(name: string): Promise<Creator[]> {
  const n = normalizeCreatorName(name);
  if (!n) return [];
  const all = await listCreators();
  return all.filter((c) => {
    const o = c.normalizedName;
    if (o === n) return true;
    if (n.length >= 4 && o.length >= 4 && (o.includes(n) || n.includes(o))) return true;
    return n.length >= 4 && editDistanceAtMostOne(o, n);
  });
}

export async function startNewCreatorContribution(
  userId: number
): Promise<{ ok: boolean; contribution: Contribution }> {
  const existing = await getActiveContribution(userId);
  if (existing) await saveContribution({ ...existing, status: "cancelled", itemCount: existing.items.length, items: [] });
  const now = new Date().toISOString();
  const contribution: Contribution = {
    id: crypto.randomUUID(),
    userId,
    creatorId: "",
    creatorName: "",
    items: [],
    status: "collecting",
    kind: "new",
    step: "name",
    createdAt: now,
    updatedAt: now,
  };
  await saveContribution(contribution);
  return { ok: true, contribution };
}

export async function submitProposalName(
  userId: number,
  rawName: string
): Promise<{ ok: boolean; error?: string; duplicates?: Creator[]; contribution?: Contribution }> {
  const c = await getActiveContribution(userId);
  if (!c || c.kind !== "new" || c.step !== "name") return { ok: false, error: "Aucune proposition de créateur en cours." };
  const name = rawName.replace(/\s+/g, " ").trim();
  if (name.length < 2 || name.length > 60) {
    return { ok: false, error: "Le nom doit contenir entre 2 et 60 caractères." };
  }
  const duplicates = await findSimilarCreators(name);
  c.proposal = { name, collection: "regular", duplicateCandidateIds: duplicates.map((d) => d.id) };
  c.creatorName = name;
  c.step = "url";
  await saveContribution(c);
  return { ok: true, duplicates, contribution: c };
}

export async function submitProposalUrl(
  userId: number,
  raw: string | null
): Promise<{ ok: boolean; error?: string }> {
  const c = await getActiveContribution(userId);
  if (!c || c.kind !== "new" || c.step !== "url" || !c.proposal) return { ok: false, error: "Étape invalide." };
  if (raw !== null) {
    let parsed: URL | null = null;
    try {
      parsed = new URL(raw.trim());
    } catch { /* invalid */ }
    if (!parsed || !["http:", "https:"].includes(parsed.protocol) || raw.length > 200) {
      return { ok: false, error: "Entrez un lien valide commençant par http:// ou https://, ou passez cette étape." };
    }
    c.proposal.profileUrl = parsed.toString();
  }
  c.step = "collection";
  await saveContribution(c);
  return { ok: true };
}

export async function submitProposalCollection(
  userId: number,
  collection: CollectionCategory
): Promise<{ ok: boolean; error?: string }> {
  const c = await getActiveContribution(userId);
  if (!c || c.kind !== "new" || c.step !== "collection" || !c.proposal) return { ok: false, error: "Étape invalide." };
  c.proposal.collection = collection;
  c.step = "media";
  await saveContribution(c);
  return { ok: true };
}

/** The contributor chose an existing creator instead of proposing a duplicate. */
export async function switchToExistingCreator(
  userId: number,
  creatorId: string
): Promise<{ ok: boolean; contribution?: Contribution; error?: string }> {
  const c = await getActiveContribution(userId);
  const creator = await getCreator(creatorId);
  if (!c || !creator) return { ok: false, error: "Créateur introuvable." };
  c.kind = "existing";
  c.creatorId = creator.id;
  c.creatorName = creator.name;
  c.proposal = undefined;
  c.step = undefined;
  await saveContribution(c);
  return { ok: true, contribution: c };
}

export async function addContributionItem(
  userId: number,
  item: ContributionItem
): Promise<{ added: boolean; count: number; newAlbum: boolean; contribution?: Contribution }> {
  const c = await getActiveContribution(userId);
  if (!c) return { added: false, count: 0, newAlbum: false };
  // A new-creator proposal accepts media only once its details are complete.
  if (c.kind === "new" && c.step !== "media") return { added: false, count: 0, newAlbum: false };
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
  await saveContribution({ ...c, status: "cancelled", itemCount: c.items.length, items: [] });
  return true;
}

export function reviewKeyboard(id: string, isNew: boolean) {
  const rows = [
    [{ text: "🎁 Approuver et récompenser", callback_data: `cadm:rw:${id}` }],
    [{ text: "✅ Approuver sans récompense", callback_data: `cadm:nr:${id}` }],
    [{ text: "❌ Refuser", callback_data: `cadm:no:${id}` }],
  ];
  if (isNew) rows.unshift([{ text: "🔎 Examiner la proposition de créateur", callback_data: `cadm:view:${id}` }]);
  return { inline_keyboard: rows };
}

/** Member taps Finish: submit for review and alert administrators with a preview. */
export async function finishContribution(
  api: ContributionApiLike,
  userId: number
): Promise<{ ok: boolean; contribution?: Contribution; error?: string }> {
  const c = await getActiveContribution(userId);
  if (!c) return { ok: false, error: "Vous n'avez aucune contribution en cours." };
  if (c.kind === "new" && (c.step !== "media" || !c.proposal)) {
    return { ok: false, error: "Complétez d'abord les informations du créateur (nom, lien, collection)." };
  }
  if (c.items.length === 0) return { ok: false, error: "Envoyez d'abord au moins une photo ou une vidéo." };

  const submitted = await transitionContribution(c.id, ["collecting"], (x) => {
    x.status = "pending";
    x.step = undefined;
    x.submittedAt = new Date().toISOString();
  });
  if (!submitted) return { ok: false, error: "Cette contribution a déjà été soumise." };
  await logAuditEvent(
    "contribution_submitted",
    { contributionId: submitted.id, creatorId: submitted.creatorId, kind: submitted.kind ?? "existing", items: submitted.items.length },
    userId,
    userId
  );

  // Alert admins (best effort): preview copy + review buttons.
  const ids = [...submitted.items.map((i) => i.messageId)].sort((a, b) => a - b);
  const isNew = submitted.kind === "new";
  for (const adminId of getConfig().ADMIN_USER_IDS) {
    try {
      await api.copyMessages(adminId, userId, ids);
      await api.sendMessage(
        adminId,
        isNew
          ? `📥 *Nouvelle contribution — NOUVEAU créateur « ${submitted.creatorName} »* (${submitted.proposal?.collection === "retro" ? "Retro" : "Regular"})\n` +
            `${submitted.items.length} élément(s) de l'utilisateur \`${userId}\` — aperçu ci-dessus.\n` +
            ((submitted.proposal?.duplicateCandidateIds.length ?? 0) > 0 ? `⚠️ Doublon possible détecté — examinez la proposition.\n` : "") +
            `Examinez l'identité du créateur et les droits avant d'approuver.`
          : `📥 *Nouvelle contribution pour ${submitted.creatorName}*\n` +
            `${submitted.items.length} élément(s) de l'utilisateur \`${userId}\` — aperçu ci-dessus.\n` +
            `Approuvez (avec ou sans récompense) ou refusez.`,
        { parse_mode: "Markdown", reply_markup: reviewKeyboard(submitted.id, isNew) }
      );
    } catch (err) {
      console.error(`[Contributions] Could not notify admin ${adminId}:`, err);
    }
  }
  return { ok: true, contribution: submitted };
}

// ---------------------------------------------------------------------------
// Administrator side: proposal corrections and reward draft
// ---------------------------------------------------------------------------

export async function adminUpdateProposal(
  id: string,
  patch: {
    name?: string;
    collection?: CollectionCategory;
    useExistingCreatorId?: string | null;
    identityRightsConfirmed?: boolean;
  }
): Promise<{ ok: boolean; error?: string; contribution?: Contribution }> {
  const c = await getContribution(id);
  if (!c || c.kind !== "new" || !c.proposal) return { ok: false, error: "Ce n'est pas une proposition de nouveau créateur." };
  const dupIds = patch.name !== undefined ? (await findSimilarCreators(patch.name)).map((d) => d.id) : undefined;
  const updated = await transitionContribution(id, ["pending", "failed"], (x) => {
    const p = x.proposal!;
    if (patch.name !== undefined) {
      p.name = patch.name.replace(/\s+/g, " ").trim();
      x.creatorName = p.name;
      p.duplicateCandidateIds = dupIds ?? p.duplicateCandidateIds;
    }
    if (patch.collection) p.collection = patch.collection;
    if (patch.useExistingCreatorId !== undefined) {
      p.useExistingCreatorId = patch.useExistingCreatorId ?? undefined;
      if (patch.useExistingCreatorId) p.identityRightsConfirmed = p.identityRightsConfirmed ?? false;
    }
    if (patch.identityRightsConfirmed !== undefined) p.identityRightsConfirmed = patch.identityRightsConfirmed;
  });
  if (!updated) return { ok: false, error: "Cette contribution n'est plus modifiable." };
  return { ok: true, contribution: updated };
}

export async function setRewardDraft(
  id: string,
  patch: { scopes?: CollectionCategory[]; days?: number }
): Promise<Contribution | null> {
  return await transitionContribution(id, ["pending", "failed"], (x) => {
    x.draft = { scopes: patch.scopes ?? x.draft?.scopes ?? [], days: patch.days ?? x.draft?.days ?? 30 };
  });
}

// ---------------------------------------------------------------------------
// Reject
// ---------------------------------------------------------------------------

export async function rejectContribution(
  api: ContributionApiLike,
  id: string,
  adminId: number,
  reason?: string
): Promise<{ ok: boolean; error?: string }> {
  const cleanReason = reason?.trim().slice(0, 300) || undefined;
  const updated = await transitionContribution(id, ["pending", "failed"], (x) => {
    x.status = "rejected";
    x.reviewedBy = adminId;
    x.reviewedAt = new Date().toISOString();
    x.rejectionReason = cleanReason;
    x.rewardStatus = "none";
    // Retention: a rejected submission keeps no message references, only a count.
    x.itemCount = x.items.length;
    x.items = [];
  });
  if (!updated) return { ok: false, error: "Cette contribution n'est plus en attente d'examen." };
  await logAuditEvent("contribution_rejected", { contributionId: id, reason: cleanReason }, adminId, updated.userId);
  await api.sendMessage(
    updated.userId,
    `Votre contribution n'a pas été approuvée.` + (cleanReason ? `\n\nRaison : ${cleanReason}` : ""),
  ).catch(() => {});
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Approve (+ optional reward)
// ---------------------------------------------------------------------------

type Resolved = { creator: Creator } | { error: string };

/** Find or create the creator (and topic) a submission is published to. Retry-safe. */
async function resolveTargetCreator(api: ContributionApiLike, c: Contribution, adminId: number): Promise<Resolved> {
  if (c.kind !== "new" || !c.proposal) {
    const creator = await getCreator(c.creatorId);
    return creator ? { creator } : { error: "Le créateur n'existe plus." };
  }
  const p = c.proposal;

  if (p.useExistingCreatorId) {
    const creator = await getCreator(p.useExistingCreatorId);
    return creator ? { creator } : { error: "Le créateur existant sélectionné n'existe plus." };
  }
  if (p.createdCreatorId) {
    const creator = await getCreator(p.createdCreatorId);
    if (creator) return { creator };
  }

  const config = getConfig();
  const chatId = p.collection === "retro" ? config.TELEGRAM_RETRO_FORUM_CHAT_ID : config.VIP_COLLECTIONS_CHAT_ID;
  if (!chatId) return { error: `Le forum ${p.collection === "retro" ? "Retro" : "Regular"} n'est pas configuré.` };
  if (!api.createForumTopic) return { error: "Création de sujet indisponible." };
  if (await getCreatorByName(p.name)) {
    return { error: `Un créateur nommé « ${p.name} » existe déjà : sélectionnez-le comme doublon au lieu d'en créer un nouveau.` };
  }

  const topic = await api.createForumTopic(chatId, p.name);
  const creator = await handleForumTopicCreated(chatId, topic.message_thread_id, p.name);
  if (!creator) return { error: "Le créateur n'a pas pu être inscrit." };
  await patchCreatorFields(creator.id, {
    rightsStatus: "verified",
    rightsVerifiedBy: adminId,
    rightsVerifiedAt: new Date().toISOString(),
  });
  await logAuditEvent("creator_rights_verified", { creatorId: creator.id, via: "contribution", contributionId: c.id }, adminId);
  // Remember the creator immediately so a retry never creates a second topic.
  await transitionContribution(c.id, ["publishing"], (x) => {
    x.proposal!.createdCreatorId = creator.id;
    x.creatorId = creator.id;
  });
  return { creator };
}

export function approveValidation(c: Contribution, decision: ContributionDecision): string | null {
  if (c.kind === "new") {
    if (!c.proposal?.useExistingCreatorId && !c.proposal?.identityRightsConfirmed) {
      return "Confirmez d'abord l'identité du créateur et les droits de publication.";
    }
    if (c.proposal?.useExistingCreatorId && !c.proposal.identityRightsConfirmed) {
      return "Confirmez d'abord les droits de publication.";
    }
  }
  if (decision.type === "reward") {
    return validateRewardParams(decision.scopes, decision.days);
  }
  return null;
}

export async function approveContribution(
  api: ContributionApiLike,
  id: string,
  adminId: number,
  decision: ContributionDecision = { type: "no_reward" }
): Promise<{ ok: boolean; error?: string; published?: number; rewardError?: string }> {
  const current = await getContribution(id);
  if (!current) return { ok: false, error: "Contribution introuvable." };

  const invalid = approveValidation(current, decision);
  if (invalid) return { ok: false, error: invalid };
  if (decision.type === "reward" && !(await contributionRewardsEnabled())) {
    return { ok: false, error: "Les récompenses par contribution sont désactivées dans le mode d'adhésion actuel." };
  }

  // Don't add content to a topic that is mid-migration (it would be missed by the copy).
  const targetId = current.proposal?.useExistingCreatorId ?? current.proposal?.createdCreatorId ?? current.creatorId;
  if (targetId) {
    const mig = await getActiveMigrationForCreator(targetId);
    if (mig && ["copying", "needs_review", "ready_to_finalize", "paused"].includes(mig.status)) {
      const name = (await getCreator(targetId))?.name ?? current.creatorName;
      return { ok: false, error: `${name} fait l'objet d'une migration (${mig.status.replace(/_/g, " ")}). Approuvez après sa finalisation ou son annulation.` };
    }
  }

  // Claim: only one approval can ever publish this contribution. The decision is stored with it.
  const claimed = await transitionContribution(id, ["pending", "failed"], (x) => {
    x.status = "publishing";
    x.reviewedBy = adminId;
    x.reviewedAt = new Date().toISOString();
    x.decision = decision;
    x.rewardStatus = decision.type === "reward" ? "pending" : "none";
  });
  if (!claimed) return { ok: false, error: "Cette contribution n'est plus en attente d'examen." };

  const fail = async (message: string) => {
    await transitionContribution(id, ["publishing"], (x) => {
      x.status = "failed";
      x.note = message;
    });
    return { ok: false as const, error: message };
  };

  let resolved: Resolved;
  try {
    resolved = await resolveTargetCreator(api, claimed, adminId);
  } catch (err) {
    return await fail(`Échec de la préparation du créateur : ${errText(err)}`);
  }
  if ("error" in resolved) return await fail(resolved.error);
  const creator = resolved.creator;

  const fresh = (await getContribution(id)) ?? claimed;
  const mig2 = await getActiveMigrationForCreator(creator.id);
  if (mig2 && ["copying", "needs_review", "ready_to_finalize", "paused"].includes(mig2.status)) {
    return await fail(`${creator.name} fait l'objet d'une migration (${mig2.status.replace(/_/g, " ")}).`);
  }

  const ids = fresh.items.map((i) => i.messageId).sort((a, b) => a - b);
  let copies: { message_id: number }[];
  try {
    copies = await api.copyMessages(creator.chatId, fresh.userId, ids, { message_thread_id: creator.topicId });
  } catch (err) {
    return await fail(`Échec de la publication : ${errText(err)}`);
  }

  if (copies.length !== ids.length) {
    // Some originals no longer exist (e.g., the member deleted them); do not retry blindly,
    // and NEVER reward until an administrator resolves the publication result.
    await transitionContribution(id, ["publishing"], (x) => {
      x.status = "needs_review";
      x.publishedMessageIds = copies.map((c) => c.message_id);
      x.rewardStatus = decision.type === "reward" ? "pending" : "none";
      x.note = `Demandés : ${ids.length}, publiés par Telegram : ${copies.length} (Telegram n'indique pas lesquels manquent). Vérifiez le sujet. Aucune récompense n'est accordée avant votre résolution.`;
    });
    if (copies.length > 0) await recordPublished(creator.id, creator.chatId, creator.topicId, fresh, copies);
    return {
      ok: false,
      error: `Seulement ${copies.length} élément(s) sur ${ids.length} ont pu être publiés (les originaux ont peut-être été supprimés). Vérifiez le sujet, puis résolvez la contribution. Aucune récompense accordée.`,
      published: copies.length,
    };
  }

  await transitionContribution(id, ["publishing"], (x) => {
    x.status = "approved";
    x.publishedMessageIds = copies.map((c) => c.message_id);
  });
  await recordPublished(creator.id, creator.chatId, creator.topicId, fresh, copies);
  await logAuditEvent(
    "contribution_approved",
    { contributionId: id, creatorId: creator.id, items: ids.length, reward: decision.type === "reward" },
    adminId,
    fresh.userId
  );

  const rewardError = await finalizeApproved(api, id, adminId);
  return { ok: true, published: copies.length, rewardError };
}

/** Admin verified a partially published submission: accept it and apply the stored decision. */
export async function resolvePartialPublication(
  api: ContributionApiLike,
  id: string,
  adminId: number
): Promise<{ ok: boolean; error?: string; rewardError?: string }> {
  const resolved = await transitionContribution(id, ["needs_review"], (x) => {
    x.status = "approved";
    x.note = `${x.note ?? ""} Résolu par l'administrateur ${adminId}.`.trim();
  });
  if (!resolved) return { ok: false, error: "Cette contribution n'est pas en attente de résolution." };
  await logAuditEvent("contribution_resolved", { contributionId: id }, adminId, resolved.userId);
  const rewardError = await finalizeApproved(api, id, adminId);
  return { ok: true, rewardError };
}

/** Retry a reward that was approved but could not be applied (e.g., transient storage error). */
export async function retryContributionReward(
  api: ContributionApiLike,
  id: string,
  adminId: number
): Promise<{ ok: boolean; error?: string }> {
  const c = await getContribution(id);
  if (!c || c.status !== "approved" || c.rewardStatus !== "pending") {
    return { ok: false, error: "Aucune récompense en attente pour cette contribution." };
  }
  const rewardError = await finalizeApproved(api, id, adminId);
  return rewardError ? { ok: false, error: rewardError } : { ok: true };
}

/**
 * After a SUCCESSFUL publication: apply the reward (if one was decided) and
 * notify the contributor. Idempotent — callable again after a failure.
 */
async function finalizeApproved(api: ContributionApiLike, id: string, adminId: number): Promise<string | undefined> {
  const c = await getContribution(id);
  if (!c || c.status !== "approved") return undefined;
  const decision = c.decision ?? { type: "no_reward" as const };

  if (decision.type === "no_reward") {
    if (c.rewardStatus !== "none") await transitionContribution(id, ["approved"], (x) => { x.rewardStatus = "none"; });
    await api.sendMessage(
      c.userId,
      `Votre contribution a été approuvée et publiée.\n\nAucun jour d'adhésion supplémentaire n'a été accordé pour cet envoi.\n\nMerci de contribuer à ${getClubName()}.`
    ).catch(() => {});
    return undefined;
  }

  try {
    const { reward, alreadyGranted } = await grantContributionReward({
      contributionId: id,
      userId: c.userId,
      scopes: decision.scopes,
      days: decision.days,
      adminId,
    });
    await transitionContribution(id, ["approved"], (x) => { x.rewardStatus = "granted"; });
    if (!alreadyGranted) {
      const dates = reward.scopes.map((s) => ({ s, d: reward.expiresAt[s] }));
      const allSame = new Set(dates.map((x) => x.d)).size === 1;
      const expiryLine = allSame
        ? `Votre accès expire le : ${fmtDay(dates[0].d!)}`
        : dates.map((x) => `Accès ${x.s === "retro" ? "Retro" : "Regular"} jusqu'au : ${fmtDay(x.d!)}`).join("\n");
      await api.sendMessage(
        c.userId,
        `Votre contribution a été approuvée et publiée.\n\nRécompense : ${reward.days} jours\nAccès : ${scopesLabel(reward.scopes)}\n${expiryLine}\n\nMerci de contribuer à ${getClubName()}.`
      ).catch(() => {});
    }
    return undefined;
  } catch (err) {
    await transitionContribution(id, ["approved"], (x) => {
      x.rewardStatus = "pending";
      x.note = `Récompense non appliquée : ${errText(err)}`;
    });
    return `Le contenu est publié, mais la récompense n'a pas pu être appliquée (${errText(err)}). Réessayez depuis la fiche de la contribution.`;
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String((err as { description?: string })?.description ?? err);
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

