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

import { getClubName, getConfig, isAdministrator } from "../config.ts";
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
  listContributions,
  saveContribution,
  transitionContribution,
  appendContributionItem,
  getAlbumContribution,
} from "../db/contributions.ts";
import { withJobLease } from "../ops/locks.ts";
import { classifyTelegramError } from "../migration/service.ts";
import { getActiveMigrationForCreator } from "../db/migrations.ts";
import { recordMediaIndex } from "../db/media_index.ts";
import { contributionRewardsEnabled } from "../membership/mode.ts";
import { handleForumTopicCreated } from "../creators/service.ts";
import {
  CollectionCategory,
  CreatorCollection,
  Contribution,
  ContributionDecision,
  ContributionItem,
  Creator,
} from "../types.ts";
import { waitForAlbumReceipt, flushContributionReceipts } from "./intake.ts";
import { notifyContributionReview, syncContributionReview, flushContributionReviews } from "./review.ts";
import { fmtDay, grantContributionReward, scopesLabel, validateRewardParams } from "./rewards.ts";
import { awardContributionBonus } from "../referrals/service.ts";
import { awardContributionPoints } from "../points/service.ts";

export interface ContributionApiLike {
  sendMessage(chatId: number | string, text: string, other?: Record<string, unknown>): Promise<unknown>;
  copyMessages(
    chatId: number | string,
    fromChatId: number | string,
    messageIds: number[],
    other?: { message_thread_id?: number }
  ): Promise<{ message_id: number }[]>;
  editMessageText?(chatId: number | string, messageId: number, text: string, other?: Record<string, unknown>): Promise<unknown>;
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
  if (!creator || creator.collection === "amateur" || creator.status !== "active") return { ok: false, error: "Créateur introuvable." };

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
  userId: number,
  collection?: "amateur"
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
    submissionCollection: collection,
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
  const amateur = c.submissionCollection === "amateur";
  if (amateur && !validAmateurFullName(name)) return { ok: false, error: "Indiquez le prénom et le nom complets (2 à 60 caractères)." };
  const duplicates = amateur ? [] : await findSimilarCreators(name);
  c.proposal = { name, collection: amateur ? "amateur" : "regular", duplicateCandidateIds: duplicates.map((d) => d.id) };
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
  if (!c || c.kind !== "new" || (c.step !== "url" && !(c.submissionCollection === "amateur" && c.step === "profile_screenshot")) || !c.proposal) return { ok: false, error: "Étape invalide." };
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
  c.step = c.submissionCollection === "amateur" ? "media" : "collection";
  await saveContribution(c);
  return { ok: true };
}

export async function submitProposalCollection(
  userId: number,
  collection: CollectionCategory
): Promise<{ ok: boolean; error?: string }> {
  const c = await getActiveContribution(userId);
  if (!c || c.kind !== "new" || c.submissionCollection === "amateur" || c.step !== "collection" || !c.proposal) return { ok: false, error: "Étape invalide." };
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
  if (!c || !creator || creator.collection === "amateur" || c.submissionCollection === "amateur") return { ok: false, error: "Créateur introuvable." };
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
): Promise<{ added: boolean; count: number; newAlbum: boolean; closed?: boolean; contribution?: Contribution }> {
  // Album updates may arrive concurrently through separate webhook requests.
  for (let attempt = 0; attempt < 20; attempt++) {
    const bound = item.mediaGroupId ? await getAlbumContribution(userId, item.mediaGroupId) : null;
    const c = bound ?? await getActiveContribution(userId);
    if (!c) return { added: false, count: 0, newAlbum: false };
    if (c.items.some(i => i.messageId === item.messageId)) return { added: false, count: c.items.length, newAlbum: false, contribution: c };
    if (c.status !== "collecting" && c.status !== "pending") return { added: false, count: c.items.length, newAlbum: false, closed: true, contribution: c };
    if (c.status === "collecting" && c.kind === "new" && c.step !== "media") return { added: false, count: c.items.length, newAlbum: false, contribution: c };
    const last = c.items[c.items.length - 1];
    const newAlbum = !(item.mediaGroupId && last?.mediaGroupId === item.mediaGroupId);
    const updated = await appendContributionItem(c, item);
    if (updated) return { added: true, count: updated.items.length, newAlbum, contribution: updated };
    await new Promise(resolve => setTimeout(resolve, 2 + Math.random() * 8));
  }
  throw new Error("Plusieurs médias arrivent simultanément. Réessayez cet élément.");
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
  const active = await getActiveContribution(userId);
  if (!active) return { ok: false, error: "Vous n'avez aucune contribution en cours." };
  const deadline = Date.now() + 8000;
  let submitted: Contribution | null = null;
  while (Date.now() < deadline) {
    const c = await waitForAlbumReceipt(active.id, deadline);
    if (!c) return { ok: false, error: "La réception de l’album est encore en cours. Vos éléments sont conservés ; appuyez de nouveau sur Terminer dans quelques instants." };
    if (c.status !== "collecting") return { ok: false, error: "Cette contribution a déjà été soumise ou annulée." };
    if (c.kind === "new" && (c.step !== "media" || !c.proposal)) return { ok: false, error: "Complétez d'abord les informations du créateur." };
    const amateurError = validateAmateurSubmission(c);
    if (amateurError) return { ok: false, error: amateurError };
    if (c.items.length === 0) return { ok: false, error: "Envoyez d'abord au moins une photo ou une vidéo." };
    submitted = await transitionContribution(c.id, ["collecting"], x => {
      x.status = "pending";
      x.step = undefined;
      x.submittedAt = new Date().toISOString();
    }, c);
    if (submitted) break; // A racing append changes the snapshot and restarts the quiet window.
  }
  if (!submitted) return { ok: false, error: "La réception est encore en cours. Vos éléments sont conservés ; réessayez Terminer." };
  await logAuditEvent(
    "contribution_submitted",
    { contributionId: submitted.id, creatorId: submitted.creatorId, kind: submitted.kind ?? "existing", items: submitted.items.length },
    userId,
    userId
  );

  await notifyContributionReview(api, submitted.id).catch(error => console.error("[Review] Notification queued:", error));
  return { ok: true, contribution: (await getContribution(submitted.id)) ?? submitted };
}

// ---------------------------------------------------------------------------
// Administrator side: proposal corrections and reward draft
// ---------------------------------------------------------------------------

export async function adminUpdateProposal(
  id: string,
  patch: {
    name?: string;
    collection?: CreatorCollection;
    useExistingCreatorId?: string | null;
    identityRightsConfirmed?: boolean;
  }
): Promise<{ ok: boolean; error?: string; contribution?: Contribution }> {
  const c = await getContribution(id);
  if (!c || c.kind !== "new" || !c.proposal) return { ok: false, error: "Ce n'est pas une proposition de nouveau créateur." };
  if (patch.name !== undefined && (patch.name.trim().length < 2 || patch.name.trim().length > 60 ||
    (c.submissionCollection === "amateur" && !validAmateurFullName(patch.name)))) return { ok: false, error: "Nom complet invalide." };
  if (patch.collection && ((c.submissionCollection === "amateur") !== (patch.collection === "amateur"))) return { ok: false, error: "La collection Amateur ne peut pas être changée." };
  if (patch.useExistingCreatorId) {
    const target = await getCreator(patch.useExistingCreatorId);
    if (!target || (creatorCollection(target) === "amateur") !== (c.proposal.collection === "amateur")) return { ok: false, error: "Collection du créateur incompatible." };
  }
  const dupIds = patch.name !== undefined && c.submissionCollection !== "amateur" ? (await findSimilarCreators(patch.name)).map((d) => d.id) : undefined;
  const updated = await transitionContribution(id, ["pending", "failed"], (x) => {
    const p = x.proposal!;
    if (patch.name !== undefined || patch.collection || patch.useExistingCreatorId !== undefined) p.identityRightsConfirmed = false;
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
  }, c);
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
    x.profileScreenshotMessageId = undefined;
    x.lateAlbumMessageIds = undefined;
    x.reviewMessages = x.reviewMessages?.map(({ chatId, messageId }) => ({ chatId, messageId }));
  });
  if (!updated) return { ok: false, error: "Cette contribution n'est plus en attente d'examen." };
  await logAuditEvent("contribution_rejected", { contributionId: id, reason: cleanReason }, adminId, updated.userId);
  await api.sendMessage(
    updated.userId,
    `Votre contribution n'a pas été approuvée.` + (cleanReason ? `\n\nRaison : ${cleanReason}` : ""),
  ).catch(() => {});
  await syncContributionReview(api, id).catch(() => {});
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Approve (+ optional reward)
// ---------------------------------------------------------------------------

type Resolved = { creator: Creator } | { error: string };

/** Find or create the creator (and topic) a submission is published to. Retry-safe. */
async function resolveTargetCreator(api: ContributionApiLike, c: Contribution, adminId: number): Promise<Resolved> {
  if (c.proposal?.collection !== "amateur") return await resolveTargetCreatorUnlocked(api, c, adminId);
  const lease = await withJobLease(`amateur_target:${normalizeCreatorName(c.proposal.name)}`, 90000,
    () => resolveTargetCreatorUnlocked(api, c, adminId));
  return lease.result ?? { error: "Ce créateur est en cours de préparation par un autre administrateur. Réessayez." };
}
async function resolveTargetCreatorUnlocked(api: ContributionApiLike, c: Contribution, adminId: number): Promise<Resolved> {
  if (c.kind !== "new" || !c.proposal) {
    const creator = await getCreator(c.creatorId);
    return creator && creator.collection !== "amateur" ? { creator } : { error: "Le créateur n'existe plus." };
  }
  const p = c.proposal;

  if (p.useExistingCreatorId) {
    const creator = await getCreator(p.useExistingCreatorId);
    return creator && (creatorCollection(creator) === "amateur") === (p.collection === "amateur") && creator.status === "active" ? { creator } : { error: "Le créateur existant sélectionné n'existe plus ou appartient à une autre collection." };
  }
  if (p.createdCreatorId) {
    const creator = await getCreator(p.createdCreatorId);
    if (creator && creatorCollection(creator) === p.collection) return { creator };
  }

  const config = getConfig();
  const chatId = p.collection === "amateur" ? config.TELEGRAM_AMATEUR_FORUM_CHAT_ID : p.collection === "retro" ? config.TELEGRAM_RETRO_FORUM_CHAT_ID : config.VIP_COLLECTIONS_CHAT_ID;
  if (!chatId) return { error: `Le forum ${p.collection === "amateur" ? "Amateur" : p.collection === "retro" ? "Retro" : "En activité"} n'est pas configuré.` };
  if (!api.createForumTopic) return { error: "Création de sujet indisponible." };
  const existingByName = await getCreatorByName(p.name);
  if (existingByName && p.collection === "amateur" && creatorCollection(existingByName) === "amateur" && existingByName.status === "active") {
    await transitionContribution(c.id, ["publishing"], x => { x.proposal!.useExistingCreatorId = existingByName.id; x.creatorId = existingByName.id; });
    return { creator: existingByName };
  }
  if (existingByName) {
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

export function validAmateurFullName(name: string): boolean {
  return name.trim().length <= 60 && /^[\p{L}][\p{L}\p{M}’'-]*(?:\s+[\p{L}][\p{L}\p{M}’'-]*)+$/u.test(name.trim());
}
export function validateAmateurSubmission(c: Contribution): string | null {
  if (c.submissionCollection !== "amateur" && c.proposal?.collection !== "amateur") return null;
  if (c.submissionCollection !== "amateur" || c.proposal?.collection !== "amateur" || !validAmateurFullName(c.proposal.name)) return "Indiquez le prénom et le nom complets pour Amateur.";
  return null;
}

export function approveValidation(c: Contribution, decision: ContributionDecision): string | null {
  const amateurError = validateAmateurSubmission(c);
  if (amateurError) return amateurError;
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
): Promise<PublishOutcome> {
  const current = await waitForAlbumReceipt(id);
  if (!current) return { ok: false, error: "La réception de l’album est encore en cours. Réessayez dans quelques instants." };

  if ((current.submissionCollection === "amateur" || (decision.type === "reward" && decision.scopes.includes("amateur"))) && !isAdministrator(adminId)) return { ok: false, error: "Administrateur requis pour Amateur." };
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
  }, current);
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

  const outcome = await runPublishing(api, id, adminId);
  await syncContributionReview(api, id).catch(() => {});
  return outcome;
}

// ---------------------------------------------------------------------------
// Publishing engine: album-safe batches, durable progress, lease, rate-limit aware
// ---------------------------------------------------------------------------

const PUBLISH_BATCH = 50; // Telegram allows up to 100 per copyMessages call
const REQUEST_PUBLISH_BUDGET_MS = 8_000; // inside a webhook request
const WORKER_PUBLISH_BUDGET_MS = 25_000; // inside the cron worker
const LEASE_MS = 90_000;

/** Pack messages into batches of at most `size`, never splitting an album. */
export function chunkContributionItems(items: ContributionItem[], size = PUBLISH_BATCH): ContributionItem[][] {
  const sorted = [...items].sort((a, b) => a.messageId - b.messageId);
  const units: ContributionItem[][] = [];
  for (const it of sorted) {
    const last = units[units.length - 1];
    if (it.mediaGroupId && last && last[0].mediaGroupId === it.mediaGroupId) last.push(it);
    else units.push([it]);
  }
  const batches: ContributionItem[][] = [];
  let cur: ContributionItem[] = [];
  for (const u of units) {
    if (cur.length > 0 && cur.length + u.length > size) {
      batches.push(cur);
      cur = [];
    }
    cur = cur.concat(u);
  }
  if (cur.length) batches.push(cur);
  return batches;
}

async function acquirePublishLease(id: string): Promise<Contribution | null> {
  const c = await getContribution(id);
  if (!c || c.status !== "publishing") return null;
  if (c.lockedUntil && c.lockedUntil > Date.now()) return null;
  return await transitionContribution(id, ["publishing"], (x) => {
    x.lockedUntil = Date.now() + LEASE_MS;
  });
}

export interface PublishOutcome {
  ok: boolean;
  error?: string;
  published?: number;
  rewardError?: string;
  /** More batches remain; the cron (or "continue") finishes them without re-copying anything. */
  inProgress?: boolean;
}

async function runPublishing(api: ContributionApiLike, id: string, adminId: number, budgetMs = REQUEST_PUBLISH_BUDGET_MS): Promise<PublishOutcome> {
  const leased = await acquirePublishLease(id);
  if (!leased) return { ok: true, inProgress: true, error: "Publication déjà en cours." };

  const release = () => transitionContribution(id, ["publishing", "failed", "needs_review", "approved"], (x) => { x.lockedUntil = undefined; });
  const fail = async (message: string): Promise<PublishOutcome> => {
    await transitionContribution(id, ["publishing"], (x) => {
      x.status = "failed";
      x.note = message;
      x.lockedUntil = undefined;
    });
    return { ok: false, error: message };
  };

  try {
    let resolved: Resolved;
    try {
      resolved = await resolveTargetCreator(api, leased, adminId);
    } catch (err) {
      return await fail(`Échec de la préparation du créateur : ${errText(err)}`);
    }
    if ("error" in resolved) return await fail(resolved.error);
    const creator = resolved.creator;

    const fresh = (await getContribution(id)) ?? leased;
    const mig = await getActiveMigrationForCreator(creator.id);
    if (mig && ["copying", "needs_review", "ready_to_finalize", "paused"].includes(mig.status)) {
      return await fail(`${creator.name} fait l'objet d'une migration (${mig.status.replace(/_/g, " ")}).`);
    }

    const batches = chunkContributionItems(fresh.items);
    const total = fresh.items.length;
    let consumed = 0;
    const deadline = Date.now() + budgetMs;

    for (const batch of batches) {
      const state = (await getContribution(id)) ?? fresh;
      if (consumed < (state.publishCursor ?? 0)) {
        consumed += batch.length; // already published in an earlier run
        continue;
      }
      if (state.retryAfter && state.retryAfter > Date.now()) return { ok: true, inProgress: true, published: consumed };
      if (Date.now() >= deadline) return { ok: true, inProgress: true, published: consumed };

      let copies: { message_id: number }[];
      try {
        copies = await api.copyMessages(creator.chatId, fresh.userId, batch.map((i) => i.messageId), {
          message_thread_id: creator.topicId,
        });
      } catch (err) {
        const info = classifyTelegramError(err);
        if (info.retryAfter !== undefined) {
          await transitionContribution(id, ["publishing"], (x) => {
            x.retryAfter = Date.now() + info.retryAfter! * 1000;
          });
          return { ok: true, inProgress: true, published: consumed };
        }
        return await fail(`Échec de la publication (${consumed}/${total} déjà publiés; la reprise continue sans doublon) : ${info.message}`);
      }

      if (copies.length !== batch.length) {
        // Some originals no longer exist (e.g., the member deleted them); do not retry blindly,
        // and NEVER reward until an administrator resolves the publication result.
        await transitionContribution(id, ["publishing"], (x) => {
          x.status = "needs_review";
          x.lockedUntil = undefined;
          x.publishedMessageIds = [...(x.publishedMessageIds ?? []), ...copies.map((c) => c.message_id)];
          x.note = `Demandés : ${batch.length} dans le lot (${consumed} déjà publiés avant), publiés par Telegram : ${copies.length} (Telegram n'indique pas lesquels manquent). Vérifiez le sujet. Aucune récompense n'est accordée avant votre résolution.`;
        });
        if (copies.length > 0) await recordPublished(creator.id, creator.chatId, creator.topicId, id, batch, copies);
        return {
          ok: false,
          error: `Seulement ${consumed + copies.length} élément(s) sur ${total} ont pu être publiés (les originaux ont peut-être été supprimés). Vérifiez le sujet, puis résolvez la contribution. Aucune récompense accordée.`,
          published: consumed + copies.length,
        };
      }

      await transitionContribution(id, ["publishing"], (x) => {
        x.publishCursor = (x.publishCursor ?? 0) + batch.length;
        x.publishedMessageIds = [...(x.publishedMessageIds ?? []), ...copies.map((c) => c.message_id)];
        x.retryAfter = undefined;
      });
      await recordPublished(creator.id, creator.chatId, creator.topicId, id, batch, copies);
      consumed += batch.length;
    }

    const final = await transitionContribution(id, ["publishing"], (x) => {
      x.status = "approved";
      x.lockedUntil = undefined;
    });
    if (!final) return { ok: false, error: "État de la contribution modifié pendant la publication." };
    await logAuditEvent(
      "contribution_approved",
      { contributionId: id, creatorId: creator.id, items: total, reward: final.decision?.type === "reward", kind: final.kind ?? "existing" },
      adminId,
      final.userId
    );
    const rewardError = await finalizeApproved(api, id, adminId);
    return { ok: true, published: total, rewardError };
  } finally {
    await release().catch(() => {});
  }
}

/** Resume a publication that stopped (time budget, rate limit). Never re-copies finished batches. */
export async function continuePublishing(api: ContributionApiLike, id: string, adminId = 0, budgetMs = WORKER_PUBLISH_BUDGET_MS): Promise<PublishOutcome> {
  const c = await getContribution(id);
  if (!c || c.status !== "publishing") return { ok: false, error: "Cette contribution n'est pas en cours de publication." };
  return await runPublishing(api, id, adminId || c.reviewedBy || 0, budgetMs);
}

/** Cron entry: continue every submission whose publication is waiting (and whose rate-limit wait is over). */
export async function continueAllPublishing(api: ContributionApiLike): Promise<number> {
  let n = 0;
  for (const c of await listContributions("publishing")) {
    if ((c.retryAfter ?? 0) > Date.now() || (c.lockedUntil ?? 0) > Date.now()) continue;
    const r = await continuePublishing(api, c.id, c.reviewedBy ?? 0);
    if (r.ok && !r.inProgress) n++;
  }
  await flushContributionReviews(api);
  await flushContributionReceipts(api);
  return n;
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
  const result = await finalizeApprovedInner(api, id, adminId, c);
  // Leaderboard points for the published items (+ bonus when a reward was granted). Idempotent.
  try {
    const fresh = (await getContribution(id)) ?? c;
    await awardContributionPoints(fresh, fresh.rewardStatus === "granted");
  } catch (err) {
    console.error("[Points] contribution points failed (rebuilt by the daily recalculation):", err);
  }
  await syncContributionReview(api, id).catch(() => {});
  return result;
}

async function finalizeApprovedInner(api: ContributionApiLike, id: string, adminId: number, c: Contribution): Promise<string | undefined> {
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
    // Referral: the contributor's referrer earns 50% (rounded up) for the same forums. Idempotent per
    // submission; a failure here must never undo or block the contributor's own reward.
    try {
      const referralScopes = reward.scopes.filter((s): s is CollectionCategory => s !== "amateur");
      if (referralScopes.length) await awardContributionBonus(api, { id, userId: c.userId }, { scopes: referralScopes, days: reward.days });
    } catch (err) {
      console.error("[Referrals] contribution bonus failed (will be retried by the hourly recovery):", err);
    }
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
  contributionId: string,
  items: ContributionItem[],
  copies: { message_id: number }[]
): Promise<void> {
  const sorted = [...items].sort((a, b) => a.messageId - b.messageId);
  const now = new Date().toISOString();
  for (let i = 0; i < copies.length; i++) {
    const src = sorted[i];
    await recordMediaIndex({
      creatorId,
      chatId,
      topicId,
      messageId: copies[i].message_id,
      kind: src.kind,
      mediaGroupId: src.mediaGroupId ? `contrib:${contributionId}:${src.mediaGroupId}` : undefined,
      hasCaption: false,
      source: "contribution",
      recordedAt: now,
    });
  }
  await recordCreatorMediaUpload(chatId, topicId); // updates "last content update" + directory
}

