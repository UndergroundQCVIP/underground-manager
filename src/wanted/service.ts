/**
 * Underground Manager — Private Wanted List Service
 * Handles member nominations, supporter tracking, eligibility checks, and channel synchronization.
 */

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
    return { success: false, isExistingCandidate: false, error: "Creator name is too short." };
  }

  // 1. Eligibility Check: Active PAYING subscriber required!
  // Complimentary members cannot nominate or support by default.
  const summary = await getMembershipSummary(userId);
  if (!summary.hasPaid) {
    return {
      success: false,
      isExistingCandidate: false,
      error: "Only active paying subscribers can nominate creators. Complimentary members are not eligible for nominations.",
    };
  }

  // 2. Check if creator is ALREADY in TOKEBEC VIP COLLECTIONS
  const existingCreator = await getCreatorByName(cleanName);
  if (existingCreator && existingCreator.hasContent) {
    return {
      success: false,
      isExistingCandidate: false,
      error: `"${cleanName}" is already available in TOKEBEC VIP COLLECTIONS!`,
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
      error: "You have already used your nomination/support selection for this monthly cycle.",
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
      error: `"${candidate.name}" is already "${WANTED_STATUS_LABELS[candidate.status]}" and can no longer receive support.`,
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
      error: supportResult.error ?? "Failed to register support.",
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
      error: "Only active paying subscribers can support creators.",
    };
  }

  const target = await getWantedCandidate(candidateId);
  if (!target) {
    return { success: false, error: "Candidate not found." };
  }
  if (!SUPPORTABLE_STATUSES.has(target.status)) {
    return {
      success: false,
      error: `"${target.name}" is already "${WANTED_STATUS_LABELS[target.status]}" and can no longer receive support.`,
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
      error: supportResult.error ?? "Failed to register support.",
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
    return { success: false, error: "WANTED_LIST_CHAT_ID not configured" };
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
    `🎯 *UNDERGROUND | WANTED LIST*\n` +
    `_Upcoming creator acquisition requests & rankings_\n` +
    `📅 *Updated:* ${nowFormatted}\n\n`;

  if (activeCandidates.length === 0) {
    text += `_No active creator requests yet. Be the first to suggest one in Underground Manager!_\n\n`;
  } else {
    activeCandidates.slice(0, 25).forEach((c, index) => {
      const statusLabel = WANTED_STATUS_LABELS[c.status] || c.status;
      const countLabel = c.supportCount === 1 ? "1 supporter" : `${c.supportCount} supporters`;
      text += `${index + 1}. *${escapeMd(c.name)}* — ${countLabel} \`[${statusLabel}]\`\n`;
    });
    text += "\n";
  }

  text += `💡 _Paid members can suggest and support creators privately inside the bot._`;

  const options = {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "🗳️ Open Wanted List in Bot",
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
