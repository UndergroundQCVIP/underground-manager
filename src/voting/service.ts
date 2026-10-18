/**
 * Underground Manager — Monthly Creator Voting Service
 * Manages ballot generation, bot-controlled vote casting, closures, turnout calculation, and runoffs.
 */

import { getConfig } from "../config.ts";
import {
  closeBallotAtomic,
  createBallot,
  getActiveBallot,
  getBallot,
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
import { escapeMd } from "../util/markdown.ts";
import { formatTorontoDate } from "../util/time.ts";
import {
  Ballot,
  BallotCandidate,
  VoteResultSummary,
} from "../types.ts";

/** Candidates that may be placed on a ballot (not already won, bought or on another ballot). */
const VOTABLE_STATUSES = new Set(["requested", "pricing_review", "eligible_for_voting"]);

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

  const open = await getActiveBallot();
  if (open) {
    throw new Error("A ballot is already open. Close it before starting a new one.");
  }

  let candidates: BallotCandidate[] = [];

  if (params.candidateIds && params.candidateIds.length > 0) {
    const all = await listWantedCandidates();
    candidates = all
      .filter((c) => params.candidateIds!.includes(c.id) && VOTABLE_STATUSES.has(c.status))
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
    title: `Monthly Acquisition Ballot — ${formatTorontoDate(now, { month: "long", year: "numeric" })}`,
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

  // The audit trail records THAT a member voted (so turnout is auditable) but never
  // WHAT they voted for: the choice must not be linkable to the member.
  await logAuditEvent("vote_cast", { ballotId }, 0, userId);

  return { success: true };
}

export interface VotingPublisherApi {
  sendMessage(
    chatId: number | string,
    text: string,
    options?: Record<string, unknown>
  ): Promise<{ message_id: number }>;
}

/**
 * Closes a ballot (idempotent, safe under concurrent cron/admin calls and
 * restarts) and publishes the outcome.
 *
 * The decision — closed ballot, results, and any runoff — is committed in ONE
 * atomic operation, so a crash can never leave a tie without its runoff or create
 * two runoffs. Side effects (candidate statuses, announcement) follow and are
 * safe to repeat; an unsent announcement is retried on the next hourly run.
 */
export async function closeAndFinalizeBallot(
  ballotId: string,
  api?: VotingPublisherApi
): Promise<VoteResultSummary> {
  const ballot = await getBallot(ballotId);
  if (!ballot) {
    throw new Error(`Ballot ${ballotId} not found`);
  }

  if (ballot.status !== "active") {
    const summary = await tallyBallot(ballotId, ballot.totalEligibleMembersAtClose);
    if (ballot.status === "closed" && !ballot.resultsAnnouncedAt && api) {
      await announceOutcome(ballot, summary, api);
    }
    return summary;
  }

  const totalEligible = await countActivePaidSubscribers();
  const summary = await tallyBallot(ballotId, totalEligible);

  const closed: Ballot = {
    ...ballot,
    status: "closed",
    totalEligibleMembersAtClose: totalEligible,
    totalVotesCount: summary.totalVotes,
  };

  let runoffDraft: Omit<Ballot, "id" | "createdAt" | "updatedAt"> | undefined;

  if (summary.isTie) {
    closed.isTie = true;
    closed.tiedCandidateIds = summary.tiedCandidates.map((c) => c.candidateId);

    if (!ballot.isRunoff) {
      const settings = await getSystemSettings();
      runoffDraft = {
        monthCycle: ballot.monthCycle,
        title: `⚡ RUNOFF VOTE — ${ballot.title}`,
        candidates: summary.tiedCandidates,
        status: "active",
        startsAt: new Date().toISOString(),
        closesAt: new Date(Date.now() + settings.votingPeriodDays * 86400 * 1000).toISOString(),
        turnoutObjective: ballot.turnoutObjective,
        isRunoff: true,
        parentBallotId: ballot.id,
      };
    } else {
      // A runoff that ties again is not repeated indefinitely: an administrator decides.
      closed.needsAdminDecision = true;
    }
  } else if (summary.winner) {
    closed.winnerCandidateId = summary.winner.candidateId;
  } else {
    closed.needsAdminDecision = true; // nobody voted
  }

  const result = await closeBallotAtomic(closed, runoffDraft);
  if (!result.ok) {
    // Another worker closed it first; just report the stored outcome.
    const current = await getBallot(ballotId);
    return await tallyBallot(ballotId, current?.totalEligibleMembersAtClose);
  }

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
  if (result.runoff) {
    await logAuditEvent(
      "runoff_scheduled",
      {
        parentBallotId: ballot.id,
        runoffBallotId: result.runoff.id,
        tiedCandidates: summary.tiedCandidates.map((c) => c.creatorName),
      },
      0
    );
  }

  // Candidate statuses: the winner is selected; tied candidates stay "voting" for
  // the runoff; everyone else goes back to the pool for future ballots.
  const staysVoting = new Set(result.runoff ? summary.tiedCandidates.map((c) => c.candidateId) : []);
  for (const c of ballot.candidates) {
    if (c.candidateId === closed.winnerCandidateId) {
      await updateWantedStatus(
        c.candidateId,
        "selected",
        `Won ${ballot.title} with ${summary.tally[0]?.votes || 0} votes`
      );
    } else if (!staysVoting.has(c.candidateId)) {
      await updateWantedStatus(c.candidateId, "eligible_for_voting");
    }
  }

  if (api) {
    const stored = (await getBallot(ballotId)) ?? closed;
    await announceOutcome(stored, summary, api, result.runoff);
  }

  return summary;
}

async function announceOutcome(
  ballot: Ballot,
  summary: VoteResultSummary,
  api: VotingPublisherApi,
  runoff?: Ballot
): Promise<void> {
  const config = getConfig();
  if (!config.WANTED_LIST_CHAT_ID) return;

  const botLink = (start: string) => ({
    inline_keyboard: [[{ text: "🗳️ Open in Underground Manager", url: `https://t.me/${config.BOT_USERNAME}?start=${start}` }]],
  });

  let text: string;
  let options: Record<string, unknown> = { parse_mode: "Markdown" };

  if (summary.isTie && (runoff || (ballot.isTie && !ballot.isRunoff))) {
    text =
      `⚡ *TIE DETECTED — RUNOFF VOTE OPEN!*\n\n` +
      `The vote ended in a tie between:\n` +
      summary.tiedCandidates.map((c) => `• *${escapeMd(c.creatorName)}*`).join("\n") +
      `\n\nA runoff ballot is now open inside Underground Manager.`;
    options = { parse_mode: "Markdown", reply_markup: botLink("vote") };
  } else if (summary.winner) {
    text =
      `🎉 *MONTHLY CREATOR VOTE RESULTS!*\n\n` +
      `🏆 *Winner:* *${escapeMd(summary.winner.creatorName)}*\n` +
      `📊 *Total Votes Cast:* ${summary.totalVotes}\n` +
      `👥 *Member Turnout:* ${summary.eligibleTurnoutPct}%\n\n` +
      `*Final Tallies:*\n` +
      summary.tally.map((t) => `• ${escapeMd(t.name)}: ${t.votes} votes`).join("\n") +
      `\n\n_The result is submitted for administrator approval. Nothing is purchased automatically._`;
  } else if (summary.isTie) {
    text =
      `⚖️ *RUNOFF ENDED IN A TIE*\n\nThe administrators will decide between:\n` +
      summary.tiedCandidates.map((c) => `• *${escapeMd(c.creatorName)}*`).join("\n");
  } else {
    text = `🗳️ *VOTE CLOSED*\n\nNo votes were cast this round, so no creator was selected.`;
  }

  try {
    await api.sendMessage(config.WANTED_LIST_CHAT_ID, text, options);
    await updateBallot({ ...(await getBallot(ballot.id) ?? ballot), resultsAnnouncedAt: new Date().toISOString() });
  } catch (err) {
    // Left unannounced on purpose: the hourly job retries the announcement.
    console.error(`[Voting] Could not announce results of ballot ${ballot.id}:`, err);
  }
}

/** Re-sends results that failed to publish (called from the hourly job). */
export async function retryUnannouncedBallots(api: VotingPublisherApi): Promise<number> {
  const { listPastBallots } = await import("../db/voting.ts");
  let retried = 0;
  for (const b of await listPastBallots(5)) {
    if (b.status === "closed" && !b.resultsAnnouncedAt) {
      await closeAndFinalizeBallot(b.id, api);
      retried++;
    }
  }
  return retried;
}
