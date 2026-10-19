/**
 * LA CONFRÉRIE — Private Wanted List Service
 * Handles member nominations, supporter tracking, eligibility checks, and channel synchronization.
 */

import { getClubName } from "../config.ts";
import { getConfig } from "../config.ts";
import { getCreatorByName } from "../db/creators.ts";
import {
  createWantedCandidate,
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

  // 4. Check if creator already exists on Wanted List
  let candidate = await getWantedCandidateByName(cleanName);
  let isExisting = false;

  if (candidate) {
    isExisting = true;
  } else {
    // Create new candidate
    candidate = await createWantedCandidate({
      name: cleanName,
      normalizedName: cleanName.toLowerCase(),
      profileUrl: profileUrl?.trim(),
      status: "requested",
      suggestedBy: userId,
      supportCount: 0,
    });

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

let wantedListMessageId: number | null = null;

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

  const nowFormatted = new Date().toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  let text =
    `🎯 *${getClubName()} | WANTED LIST*\n` +
    `_Upcoming creator acquisition requests & rankings_\n` +
    `📅 *Updated:* ${nowFormatted}\n\n`;

  if (activeCandidates.length === 0) {
    text += `_No active creator requests yet. Be the first to suggest one in the ${getClubName()} bot!_\n\n`;
  } else {
    activeCandidates.slice(0, 25).forEach((c, index) => {
      const statusLabel = WANTED_STATUS_LABELS[c.status] || c.status;
      const countLabel = c.supportCount === 1 ? "1 supporter" : `${c.supportCount} supporters`;
      text += `${index + 1}. *${c.name}* — ${countLabel} \`[${statusLabel}]\`\n`;
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

  try {
    if (wantedListMessageId) {
      try {
        await api.editMessageText(channelId, wantedListMessageId, text, options);
        return { success: true };
      } catch {
        // Fallback to sending new message
      }
    }

    const msg = await api.sendMessage(channelId, text, options);
    wantedListMessageId = msg.message_id;

    await logAuditEvent("wanted_list_synced", { channelId, candidatesCount: activeCandidates.length }, 0);
    return { success: true };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("Failed to sync Wanted List channel:", errorMsg);
    return { success: false, error: errorMsg };
  }
}
