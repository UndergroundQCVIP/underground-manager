/**
 * LA CONFRÉRIE — Monthly Creator Voting Service
 * Manages ballot generation, bot-controlled vote casting, closures, turnout calculation, and runoffs.
 */

import { getClubName } from "../config.ts";
import { getConfig } from "../config.ts";
import {
  createBallot,
  getActiveBallot,
  getBallot,
  hasUserVoted,
  recordVote,
  tallyBallot,
  updateBallot,
} from "../db/voting.ts";
import {
  getCurrentMonthCycle,
  listWantedCandidates,
  updateWantedStatus,
} from "../db/wanted.ts";
import {
  countActivePaidSubscribers,
  getMembershipSummary,
} from "../db/entitlements.ts";
import { logAuditEvent } from "../db/audit.ts";
import { getSystemSettings } from "../db/settings.ts";
import {
  Ballot,
  BallotCandidate,
  VoteResultSummary,
} from "../types.ts";

export interface PrepareBallotParams {
  adminId: number;
  candidateIds?: string[];
  shortlistSize?: number;
}

export async function prepareMonthlyBallot(
  params: PrepareBallotParams
): Promise<Ballot> {
  const settings = await getSystemSettings();
  const limit = params.shortlistSize || settings.votingShortlistSize;
  const cycleId = getCurrentMonthCycle();

  let candidates: BallotCandidate[] = [];

  if (params.candidateIds && params.candidateIds.length > 0) {
    const all = await listWantedCandidates();
    candidates = all
      .filter((c) => params.candidateIds!.includes(c.id))
      .map((c) => ({
        candidateId: c.id,
        creatorName: c.name,
        profileUrl: c.profileUrl,
      }));
  } else {
    // Select top supported candidates with eligible_for_voting or requested status
    const all = await listWantedCandidates();
    const eligible = all.filter(
      (c) =>
        (c.status === "eligible_for_voting" || c.status === "requested") &&
        c.supportCount > 0
    );

    candidates = eligible.slice(0, limit).map((c) => ({
      candidateId: c.id,
      creatorName: c.name,
      profileUrl: c.profileUrl,
    }));
  }

  if (candidates.length < 2) {
    throw new Error(
      "At least 2 eligible candidates are required to prepare a voting ballot."
    );
  }

  const durationDays = settings.votingPeriodDays;
  const now = new Date();
  const closesAt = new Date(now.getTime() + durationDays * 86400 * 1000);

  const ballot = await createBallot({
    monthCycle: cycleId,
    title: `Monthly Acquisition Ballot — ${now.toLocaleString("en-US", { month: "long", year: "numeric" })}`,
    candidates,
    status: "active",
    startsAt: now.toISOString(),
    closesAt: closesAt.toISOString(),
    turnoutObjective: settings.turnoutObjectivePct / 100,
  });

  // Update candidate statuses to 'voting'
  for (const c of candidates) {
    await updateWantedStatus(c.candidateId, "voting");
  }

  await logAuditEvent(
    "ballot_opened",
    {
      ballotId: ballot.id,
      monthCycle: cycleId,
      candidatesCount: candidates.length,
      closesAt: ballot.closesAt,
    },
    params.adminId
  );

  return ballot;
}

export interface CastVoteParams {
  userId: number;
  ballotId: string;
  candidateId: string;
}

export async function castVote(
  params: CastVoteParams
): Promise<{ success: boolean; error?: string }> {
  const { userId, ballotId, candidateId } = params;

  // 1. Eligibility Check: Active PAYING subscriber only!
  const summary = await getMembershipSummary(userId);
  if (!summary.hasPaid) {
    return {
      success: false,
      error: "Only active paying subscribers are eligible to vote. Complimentary members are excluded from voting.",
    };
  }

  // 2. Check if ballot exists and is active
  const ballot = await getBallot(ballotId);
  if (!ballot || ballot.status !== "active") {
    return { success: false, error: "This voting ballot is no longer active." };
  }

  if (new Date(ballot.closesAt).getTime() <= Date.now()) {
    return { success: false, error: "The voting deadline has expired." };
  }

  // 3. Cast vote atomically
  const result = await recordVote(ballotId, userId, candidateId);
  if (!result.success) {
    return { success: false, error: result.error };
  }

  await logAuditEvent(
    "vote_cast",
    { ballotId, candidateId }, // Vote is anonymous in audit log
    0,
    userId
  );

  return { success: true };
}

export interface VotingPublisherApi {
  sendMessage(
    chatId: number | string,
    text: string,
    options?: Record<string, unknown>
  ): Promise<{ message_id: number }>;
}

export async function closeAndFinalizeBallot(
  ballotId: string,
  api?: VotingPublisherApi
): Promise<VoteResultSummary> {
  const ballot = await getBallot(ballotId);
  if (!ballot) {
    throw new Error(`Ballot ${ballotId} not found`);
  }

  if (ballot.status === "closed") {
    return await tallyBallot(ballotId);
  }

  // Get total active paid subscribers for turnout calculation
  const totalEligible = await countActivePaidSubscribers();

  ballot.status = "closed";
  ballot.totalEligibleMembersAtClose = totalEligible;

  const summary = await tallyBallot(ballotId, totalEligible);
  ballot.totalVotesCount = summary.totalVotes;

  if (summary.isTie) {
    ballot.isTie = true;
    ballot.tiedCandidateIds = summary.tiedCandidates.map((c) => c.candidateId);

    // Schedule Runoff Vote between tied candidates
    const settings = await getSystemSettings();
    const runoffClosesAt = new Date(
      Date.now() + settings.votingPeriodDays * 86400 * 1000
    ).toISOString();

    const runoffBallot = await createBallot({
      monthCycle: ballot.monthCycle,
      title: `⚡ RUNOFF VOTE — ${ballot.title}`,
      candidates: summary.tiedCandidates,
      status: "active",
      startsAt: new Date().toISOString(),
      closesAt: runoffClosesAt,
      turnoutObjective: ballot.turnoutObjective,
      isRunoff: true,
      parentBallotId: ballot.id,
    });

    await logAuditEvent(
      "runoff_scheduled",
      {
        parentBallotId: ballot.id,
        runoffBallotId: runoffBallot.id,
        tiedCandidates: summary.tiedCandidates.map((c) => c.creatorName),
      },
      0
    );

    if (api) {
      const config = getConfig();
      if (config.WANTED_LIST_CHAT_ID) {
        await api.sendMessage(
          config.WANTED_LIST_CHAT_ID,
          `⚡ *TIE DETECTED — RUNOFF VOTE OPEN!*\n\n` +
          `The vote ended in a tie between:\n` +
          summary.tiedCandidates.map((c) => `• *${c.creatorName}*`).join("\n") +
          `\n\nA 5-day runoff ballot is now open inside the ${getClubName()} bot.`,
          {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "🗳️ Vote in Runoff",
                    url: `https://t.me/${config.BOT_USERNAME}?start=vote`,
                  },
                ],
              ],
            },
          }
        );
      }
    }
  } else if (summary.winner) {
    ballot.winnerCandidateId = summary.winner.candidateId;

    // Mark winning candidate as 'selected' / 'acquisition_pending'
    await updateWantedStatus(
      summary.winner.candidateId,
      "selected",
      `Won ${ballot.title} with ${summary.tally[0]?.votes || 0} votes`
    );

    if (api) {
      const config = getConfig();
      if (config.WANTED_LIST_CHAT_ID) {
        await api.sendMessage(
          config.WANTED_LIST_CHAT_ID,
          `🎉 *MONTHLY CREATOR VOTE RESULTS!*\n\n` +
          `🏆 *Winner:* *${summary.winner.creatorName}*\n` +
          `📊 *Total Votes Cast:* ${summary.totalVotes}\n` +
          `👥 *Member Turnout:* ${summary.eligibleTurnoutPct}%\n\n` +
          `*Final Tallies:*\n` +
          summary.tally.map((t) => `• ${t.name}: ${t.votes} votes`).join("\n") +
          `\n\n_Acquisition has been submitted for administrator approval._`,
          { parse_mode: "Markdown" }
        );
      }
    }
  }

  await updateBallot(ballot);

  await logAuditEvent(
    "ballot_closed",
    {
      ballotId,
      totalVotes: summary.totalVotes,
      winner: summary.winner?.creatorName,
      isTie: summary.isTie,
      turnoutPct: summary.eligibleTurnoutPct,
    },
    0
  );

  return summary;
}
