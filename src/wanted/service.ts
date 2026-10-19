/**
 * LA CONFRÉRIE — Private Wanted List Service
 * Handles member nominations, supporter tracking, eligibility checks, and channel synchronization.
 */

import { getClubName } from "../config.ts";
import { getConfig } from "../config.ts";
import { getCreatorByName } from "../db/creators.ts";
import {
  createWantedCandidateOnce,
  getCurrentMonthCycle,
  getUserSupportForCycle,
  getWantedCandidate,
  getWantedCandidateByName,
  listWantedCandidates,
  recordMemberSupport,
  updateWantedStatus,
} from "../db/wanted.ts";
import { getMembershipSummary } from "../db/entitlements.ts";
import { logAuditEvent } from "../db/audit.ts";
import { getKv } from "../db/kv.ts";
import { escapeMd } from "../util/markdown.ts";
import { formatTorontoDate } from "../util/time.ts";
import {
  WANTED_STATUS_LABELS,
  WantedCandidate,
  WantedCandidateStatus,
} from "../types.ts";

export interface SubmitNominationParams {
  userId: number;
  name: string;
  profileUrl?: string;
}

export interface SubmitNominationResult {
  success: boolean;
  isExistingCandidate: boolean;
  alreadySupportedThisCycle?: boolean;
  candidate?: WantedCandidate;
  error?: string;
}

export async function submitCreatorNomination(
  params: SubmitNominationParams
): Promise<SubmitNominationResult> {
  const { userId, name, profileUrl } = params;
  const cleanName = name.trim();

  if (cleanName.length < 2) {
    return { success: false, isExistingCandidate: false, error: "Le nom du créateur est trop court." };
  }

  // 1. Eligibility Check: Active PAYING subscriber required!
  // Complimentary members cannot nominate or support by default.
  const summary = await getMembershipSummary(userId);
  if (!summary.hasPaid) {
    return {
      success: false,
      isExistingCandidate: false,
      error: "Seuls les abonnés payants actifs peuvent suggérer des créateurs. Les membres ayant un accès gracieux ne sont pas admissibles aux suggestions.",
    };
  }

  // 2. Check if creator is ALREADY in TOKEBEC VIP COLLECTIONS
  const existingCreator = await getCreatorByName(cleanName);
  if (existingCreator && existingCreator.hasContent) {
    return {
      success: false,
      isExistingCandidate: false,
      error: `« ${cleanName} » est déjà disponible dans TOKEBEC VIP COLLECTIONS!`,
    };
  }

  const cycleId = getCurrentMonthCycle();

  // 3. Check if member already used their nomination/support for this month
  const existingCycleSupport = await getUserSupportForCycle(cycleId, userId);
  if (existingCycleSupport) {
    return {
      success: false,
      isExistingCandidate: false,
      alreadySupportedThisCycle: true,
      error: "Vous avez déjà utilisé votre suggestion ou votre appui pour ce cycle mensuel.",
    };
  }

  // 4. Find or create the candidate (atomic by normalized name, so two members
  // nominating the same creator at the same moment end up on ONE candidate).
  const { candidate: found, created } = await createWantedCandidateOnce({
    name: cleanName,
    normalizedName: cleanName.toLowerCase(),
    profileUrl: profileUrl?.trim(),
    status: "requested",
    suggestedBy: userId,
    supportCount: 0,
  });
  const candidate = found;
  const isExisting = !created;

  if (isExisting && !SUPPORTABLE_STATUSES.has(candidate.status)) {
    return {
      success: false,
      isExistingCandidate: true,
      error: `« ${candidate.name} » a déjà le statut « ${WANTED_STATUS_LABELS[candidate.status]} » et ne peut plus recevoir d'appuis.`,
    };
  }

  if (created) {
    await logAuditEvent(
      "wanted_candidate_suggested",
      { candidateId: candidate.id, name: cleanName, profileUrl },
      0,
      userId
    );
  }

  // 5. Automatically credit this member's support
  const supportResult = await recordMemberSupport(
    cycleId,
    userId,
    candidate.id,
    isExisting ? "support" : "nomination"
  );

  if (!supportResult.success || !supportResult.candidate) {
    return {
      success: false,
      isExistingCandidate: isExisting,
      error: supportResult.error ?? "Échec de l'enregistrement de l'appui.",
    };
  }

  await logAuditEvent(
    "wanted_candidate_supported",
    {
      candidateId: candidate.id,
      name: cleanName,
      cycleId,
      newSupportCount: supportResult.candidate.supportCount,
    },
    0,
    userId
  );

  return {
    success: true,
    isExistingCandidate: isExisting,
    candidate: supportResult.candidate,
  };
}

/** Statuses in which a candidate is still collecting community support. */
const SUPPORTABLE_STATUSES = new Set<WantedCandidateStatus>([
  "requested",
  "pricing_review",
  "eligible_for_voting",
]);

export async function supportExistingCandidate(
  userId: number,
  candidateId: string
): Promise<{ success: boolean; candidate?: WantedCandidate; error?: string }> {
  // 1. Eligibility Check
  const summary = await getMembershipSummary(userId);
  if (!summary.hasPaid) {
    return {
      success: false,
      error: "Seuls les abonnés payants actifs peuvent appuyer des créateurs.",
    };
  }

  const target = await getWantedCandidate(candidateId);
  if (!target) {
    return { success: false, error: "Candidat introuvable." };
  }
  if (!SUPPORTABLE_STATUSES.has(target.status)) {
    return {
      success: false,
      error: `« ${target.name} » a déjà le statut « ${WANTED_STATUS_LABELS[target.status]} » et ne peut plus recevoir d'appuis.`,
    };
  }

  const cycleId = getCurrentMonthCycle();
  const supportResult = await recordMemberSupport(
    cycleId,
    userId,
    candidateId,
    "support"
  );

  if (!supportResult.success || !supportResult.candidate) {
    return {
      success: false,
      error: supportResult.error ?? "Échec de l'enregistrement de l'appui.",
    };
  }

  await logAuditEvent(
    "wanted_candidate_supported",
    {
      candidateId,
      name: supportResult.candidate.name,
      cycleId,
      newSupportCount: supportResult.candidate.supportCount,
    },
    0,
    userId
  );

  return {
    success: true,
    candidate: supportResult.candidate,
  };
}

export interface WantedApiLike {
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
}

const WANTED_MESSAGE_KEY = ["wanted_list_channel_message"];

export async function syncWantedListChannel(
  api: WantedApiLike
): Promise<{ success: boolean; error?: string }> {
  const config = getConfig();
  const channelId = config.WANTED_LIST_CHAT_ID;

  if (!channelId) {
    return { success: false, error: "WANTED_LIST_CHAT_ID non configuré" };
  }

  const candidates = await listWantedCandidates();
  const activeCandidates = candidates.filter(
    (c) => c.status !== "available" && c.status !== "rejected_unavailable"
  );

  const nowFormatted = formatTorontoDate(new Date(), {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  let text =
    `🎯 *${getClubName()} | LISTE DE SOUHAITS*\n` +
    `_Demandes d'acquisition de créateurs à venir et classement_\n` +
    `📅 *Mis à jour :* ${nowFormatted}\n\n`;

  if (activeCandidates.length === 0) {
    text += `_Aucune demande de créateur active pour le moment. Soyez le premier à en suggérer une dans le robot ${getClubName()}!_\n\n`;
  } else {
    activeCandidates.slice(0, 25).forEach((c, index) => {
      const statusLabel = WANTED_STATUS_LABELS[c.status] || c.status;
      const countLabel = c.supportCount === 1 ? "1 appui" : `${c.supportCount} appuis`;
      text += `${index + 1}. *${escapeMd(c.name)}* — ${countLabel} \`[${statusLabel}]\`\n`;
    });
    text += "\n";
  }

  text += `💡 _Les membres payants peuvent suggérer et appuyer des créateurs en privé dans le robot._`;

  const options = {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "🗳️ Ouvrir la Liste de souhaits dans le robot",
            url: `https://t.me/${config.BOT_USERNAME}?start=wanted`,
          },
        ],
      ],
    },
  };

  const kv = await getKv();
  // The published message id is persisted: an in-memory id would be lost on every
  // cold start and the list would be re-posted as a duplicate message.
  const stored = await kv.get<{ messageId: number; hash: string }>(WANTED_MESSAGE_KEY);
  const hash = await sha256Hex(text);

  try {
    if (stored.value) {
      if (stored.value.hash === hash) {
        return { success: true };
      }
      try {
        await api.editMessageText(channelId, stored.value.messageId, text, options);
        await kv.set(WANTED_MESSAGE_KEY, { messageId: stored.value.messageId, hash });
        return { success: true };
      } catch (err) {
        if (isMessageNotModified(err)) {
          await kv.set(WANTED_MESSAGE_KEY, { messageId: stored.value.messageId, hash });
          return { success: true };
        }
        if (!isMessageGone(err)) throw err; // transient: retry on the next sync, don't duplicate
      }
    }

    const msg = await api.sendMessage(channelId, text, options);
    await kv.set(WANTED_MESSAGE_KEY, { messageId: msg.message_id, hash });

    await logAuditEvent("wanted_list_synced", { channelId, candidatesCount: activeCandidates.length }, 0);
    return { success: true };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("Failed to sync Wanted List channel:", errorMsg);
    return { success: false, error: errorMsg };
  }
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function isMessageNotModified(err: unknown): boolean {
  return String((err as Error)?.message ?? err).toLowerCase().includes("message is not modified");
}

/** The stored message no longer exists (deleted / invalid id) so a new one must be sent. */
export function isMessageGone(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err).toLowerCase();
  return (
    msg.includes("message to edit not found") ||
    msg.includes("message_id_invalid") ||
    msg.includes("message can't be edited")
  );
}
