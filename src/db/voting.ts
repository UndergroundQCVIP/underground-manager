/**
 * Underground Manager — Voting Repository
 * Manages monthly creator acquisition ballots, anonymous vote records, and tallies.
 */

import { getKv } from "./kv.ts";
import {
  Ballot,
  BallotStatus,
  VoteRecord,
  VoteResultSummary,
} from "../types.ts";

export async function createBallot(
  data: Omit<Ballot, "id" | "createdAt" | "updatedAt">
): Promise<Ballot> {
  const kv = await getKv();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const ballot: Ballot = {
    ...data,
    id,
    createdAt: now,
    updatedAt: now,
  };

  const atomic = kv.atomic();
  atomic.set(["ballots", id], ballot);
  if (ballot.status === "active") {
    // Only one ballot may be open at a time; overwriting the pointer would orphan
    // a running ballot (it would never close and its candidates would stay locked).
    const pointer = await kv.get<string>(["active_ballot"]);
    if (pointer.value) {
      const open = await getBallot(pointer.value);
      if (open && open.status === "active") {
        throw new Error("Another ballot is already open. Close it before starting a new one.");
      }
    }
    atomic.check(pointer);
    atomic.set(["active_ballot"], id);
  }

  const res = await atomic.commit();
  if (!res.ok) {
    throw new Error(`Failed to commit new ballot for cycle ${ballot.monthCycle}`);
  }

  return ballot;
}

/**
 * Closes an ACTIVE ballot exactly once. In a single atomic commit it stores the
 * closed ballot (with results), releases the active pointer, and — for a tie —
 * opens the runoff. Returns false if another worker already closed it.
 */
export async function closeBallotAtomic(
  closed: Ballot,
  runoff?: Omit<Ballot, "id" | "createdAt" | "updatedAt">
): Promise<{ ok: boolean; runoff?: Ballot }> {
  const kv = await getKv();
  const res = await kv.get<Ballot>(["ballots", closed.id]);
  if (!res.value || res.value.status !== "active") return { ok: false };

  const now = new Date().toISOString();
  const atomic = kv.atomic();
  atomic.check(res);
  atomic.set(["ballots", closed.id], { ...closed, status: "closed", updatedAt: now });

  let runoffBallot: Ballot | undefined;
  if (runoff) {
    runoffBallot = { ...runoff, id: crypto.randomUUID(), createdAt: now, updatedAt: now };
    atomic.set(["ballots", runoffBallot.id], runoffBallot);
    atomic.set(["active_ballot"], runoffBallot.id);
  } else {
    const pointer = await kv.get<string>(["active_ballot"]);
    if (pointer.value === closed.id) {
      atomic.check(pointer);
      atomic.delete(["active_ballot"]);
    }
  }

  const commit = await atomic.commit();
  return commit.ok ? { ok: true, runoff: runoffBallot } : { ok: false };
}

export async function getBallot(id: string): Promise<Ballot | null> {
  const kv = await getKv();
  const res = await kv.get<Ballot>(["ballots", id]);
  return res.value ?? null;
}

export async function getActiveBallot(): Promise<Ballot | null> {
  const kv = await getKv();
  const activeId = await kv.get<string>(["active_ballot"]);
  if (!activeId.value) return null;
  const ballot = await getBallot(activeId.value);
  if (ballot && ballot.status === "active") {
    return ballot;
  }
  return null;
}

export async function updateBallot(ballot: Ballot): Promise<Ballot> {
  const kv = await getKv();
  const now = new Date().toISOString();
  const updated: Ballot = { ...ballot, updatedAt: now };

  const atomic = kv.atomic();
  atomic.set(["ballots", ballot.id], updated);
  if (updated.status === "active") {
    atomic.set(["active_ballot"], ballot.id);
  } else {
    // If active ballot key points to this ballot, delete it
    const activeRes = await kv.get<string>(["active_ballot"]);
    if (activeRes.value === ballot.id) {
      atomic.delete(["active_ballot"]);
    }
  }

  await atomic.commit();
  return updated;
}

export async function hasUserVoted(
  ballotId: string,
  userId: number
): Promise<boolean> {
  const kv = await getKv();
  const res = await kv.get(["votes_by_ballot_user", ballotId, userId]);
  return res.value !== null;
}

export interface CastVoteResult {
  success: boolean;
  alreadyVoted: boolean;
  vote?: VoteRecord;
  error?: string;
}

export async function recordVote(
  ballotId: string,
  userId: number,
  candidateId: string
): Promise<CastVoteResult> {
  const kv = await getKv();

  // 1. Verify ballot is active
  const ballot = await getBallot(ballotId);
  if (!ballot || ballot.status !== "active") {
    return {
      success: false,
      alreadyVoted: false,
      error: "Ce scrutin n'est plus ouvert au vote.",
    };
  }

  // Check if ballot expired by time
  if (new Date(ballot.closesAt).getTime() <= Date.now()) {
    return {
      success: false,
      alreadyVoted: false,
      error: "La période de vote de ce scrutin est terminée.",
    };
  }

  // 2. Verify candidate belongs to ballot
  const candidateValid = ballot.candidates.some(
    (c) => c.candidateId === candidateId
  );
  if (!candidateValid) {
    return {
      success: false,
      alreadyVoted: false,
      error: "Choix de candidat invalide pour ce scrutin.",
    };
  }

  // 3. Check for existing vote atomically
  const voteKey = ["votes_by_ballot_user", ballotId, userId];
  const existingVote = await kv.get(voteKey);
  if (existingVote.value) {
    return {
      success: false,
      alreadyVoted: true,
      error: "Vous avez déjà voté à ce scrutin. Les votes ne peuvent pas être modifiés.",
    };
  }

  const voteId = crypto.randomUUID();
  const now = new Date().toISOString();
  const vote: VoteRecord = {
    id: voteId,
    ballotId,
    userId,
    candidateId,
    createdAt: now,
  };

  const atomic = kv.atomic();
  atomic.check({ key: voteKey, versionstamp: null });
  atomic.set(voteKey, vote);
  atomic.set(["ballot_votes", ballotId, voteId], vote);

  const res = await atomic.commit();
  if (!res.ok) {
    return {
      success: false,
      alreadyVoted: true,
      error: "Votre vote a déjà été soumis.",
    };
  }

  return {
    success: true,
    alreadyVoted: false,
    vote,
  };
}

export async function tallyBallot(
  ballotId: string,
  totalEligibleOverride?: number
): Promise<VoteResultSummary> {
  const kv = await getKv();
  const ballot = await getBallot(ballotId);
  if (!ballot) {
    throw new Error(`Ballot ${ballotId} not found`);
  }

  const votesIter = kv.list<VoteRecord>({
    prefix: ["ballot_votes", ballotId],
  });

  const voteCounts: Record<string, number> = {};
  for (const c of ballot.candidates) {
    voteCounts[c.candidateId] = 0;
  }

  let totalVotes = 0;
  for await (const entry of votesIter) {
    const v = entry.value;
    if (v && v.candidateId in voteCounts) {
      voteCounts[v.candidateId]++;
      totalVotes++;
    }
  }

  const tally = ballot.candidates.map((c) => ({
    candidateId: c.candidateId,
    name: c.creatorName,
    votes: voteCounts[c.candidateId] || 0,
  }));

  // Sort descending by votes
  tally.sort((a, b) => b.votes - a.votes);

  let winner: (typeof ballot.candidates)[0] | undefined;
  let isTie = false;
  let tiedCandidates: typeof ballot.candidates = [];

  if (totalVotes > 0 && tally.length > 0) {
    const topVotes = tally[0].votes;
    const topCandidates = tally.filter((t) => t.votes === topVotes);

    if (topCandidates.length > 1 && topVotes > 0) {
      isTie = true;
      tiedCandidates = ballot.candidates.filter((c) =>
        topCandidates.some((tc) => tc.candidateId === c.candidateId)
      );
    } else if (topCandidates.length === 1 && topVotes > 0) {
      winner = ballot.candidates.find(
        (c) => c.candidateId === topCandidates[0].candidateId
      );
    }
  }

  const eligibleBase = totalEligibleOverride ?? ballot.totalEligibleMembersAtClose ?? 0;
  const turnoutPct =
    eligibleBase > 0
      ? Math.round((totalVotes / eligibleBase) * 100)
      : 0;

  return {
    ballotId,
    totalVotes,
    eligibleTurnoutPct: turnoutPct,
    winner,
    isTie,
    tiedCandidates,
    tally,
  };
}

export async function listPastBallots(limit = 10): Promise<Ballot[]> {
  const kv = await getKv();
  const iter = kv.list<Ballot>(
    { prefix: ["ballots"] },
    { limit, reverse: true }
  );
  const ballots: Ballot[] = [];
  for await (const entry of iter) {
    if (entry.value) {
      ballots.push(entry.value);
    }
  }
  return ballots.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}
