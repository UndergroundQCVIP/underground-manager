/**
 * LA CONFRÉRIE — UG-02 Pre-Publish Test Suite: ACQUISITION VOTING
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import { setupTestEnvironment, MockTelegramApi } from "./test_helpers.ts";
import {
  castVote,
  closeAndFinalizeBallot,
  prepareMonthlyBallot,
} from "../src/voting/service.ts";
import { createEntitlement } from "../src/db/entitlements.ts";
import {
  createWantedCandidate,
  recordMemberSupport,
} from "../src/db/wanted.ts";
import { getActiveBallot, getBallot } from "../src/db/voting.ts";

Deno.test("VOTING — Preparing monthly ballot requires at least 2 candidates and sets status to voting", async () => {
  const kv = await setupTestEnvironment();
  try {
    const adminId = 111111;

    // Create 3 wanted candidates with supporters
    const c1 = await createWantedCandidate({
      name: "Candidate Alpha",
      normalizedName: "candidate alpha",
      status: "eligible_for_voting",
      suggestedBy: 9001,
      supportCount: 10,
    });
    const c2 = await createWantedCandidate({
      name: "Candidate Beta",
      normalizedName: "candidate beta",
      status: "eligible_for_voting",
      suggestedBy: 9002,
      supportCount: 8,
    });
    const c3 = await createWantedCandidate({
      name: "Candidate Gamma",
      normalizedName: "candidate gamma",
      status: "eligible_for_voting",
      suggestedBy: 9003,
      supportCount: 5,
    });

    const ballot = await prepareMonthlyBallot({
      adminId,
      shortlistSize: 3,
    });

    assertNotEquals(ballot, null);
    assertEquals(ballot.status, "active");
    assertEquals(ballot.candidates.length, 3);
    assertEquals(ballot.candidates[0].creatorName, "Candidate Alpha");

    const active = await getActiveBallot();
    assertEquals(active?.id, ballot.id);
  } finally {
    await kv.close();
  }
});

Deno.test("VOTING — Paid member can vote, complimentary member is excluded", async () => {
  const kv = await setupTestEnvironment();
  try {
    const adminId = 111111;
    const paidUserId = 9010;
    const compUserId = 9011;

    // Create candidates
    const c1 = await createWantedCandidate({
      name: "Creator X",
      normalizedName: "creator x",
      status: "eligible_for_voting",
      suggestedBy: 9001,
      supportCount: 5,
    });
    const c2 = await createWantedCandidate({
      name: "Creator Y",
      normalizedName: "creator y",
      status: "eligible_for_voting",
      suggestedBy: 9002,
      supportCount: 4,
    });

    const ballot = await prepareMonthlyBallot({ adminId });

    // Paid subscription
    await createEntitlement({
      userId: paidUserId,
      source: "telegram_stars",
      spaces: ["vip_collections", "general_chat", "wanted_list"],
      startsAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 86400 * 1000).toISOString(),
      status: "active",
    });

    // Complimentary subscription
    await createEntitlement({
      userId: compUserId,
      source: "complimentary",
      spaces: ["vip_collections", "general_chat", "wanted_list"],
      startsAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 86400 * 1000).toISOString(),
      status: "active",
    });

    // 1. Paid member votes -> SUCCESS
    const paidVote = await castVote({
      userId: paidUserId,
      ballotId: ballot.id,
      candidateId: c1.id,
    });
    assertEquals(paidVote.success, true);

    // 2. Complimentary member votes -> REJECTED
    const compVote = await castVote({
      userId: compUserId,
      ballotId: ballot.id,
      candidateId: c1.id,
    });
    assertEquals(compVote.success, false);
    assertEquals(compVote.error?.includes("sont exclus du vote"), true);
  } finally {
    await kv.close();
  }
});

Deno.test("VOTING — Votes are irrevocable and duplicate attempts are rejected", async () => {
  const kv = await setupTestEnvironment();
  try {
    const adminId = 111111;
    const paidUserId = 9020;

    const c1 = await createWantedCandidate({
      name: "Creator 1",
      normalizedName: "creator 1",
      status: "eligible_for_voting",
      suggestedBy: 9001,
      supportCount: 5,
    });
    const c2 = await createWantedCandidate({
      name: "Creator 2",
      normalizedName: "creator 2",
      status: "eligible_for_voting",
      suggestedBy: 9002,
      supportCount: 4,
    });

    const ballot = await prepareMonthlyBallot({ adminId });

    await createEntitlement({
      userId: paidUserId,
      source: "telegram_stars",
      spaces: ["vip_collections", "general_chat", "wanted_list"],
      startsAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 86400 * 1000).toISOString(),
      status: "active",
    });

    // Cast first vote
    const vote1 = await castVote({
      userId: paidUserId,
      ballotId: ballot.id,
      candidateId: c1.id,
    });
    assertEquals(vote1.success, true);

    // Attempt to change vote to candidate 2 -> REJECTED
    const vote2 = await castVote({
      userId: paidUserId,
      ballotId: ballot.id,
      candidateId: c2.id,
    });
    assertEquals(vote2.success, false);
    assertEquals(vote2.error?.includes("déjà voté"), true);
  } finally {
    await kv.close();
  }
});

Deno.test("VOTING — Ballot closure determines winner and reports turnout", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockTelegramApi();
    const adminId = 111111;

    const c1 = await createWantedCandidate({
      name: "Winner Candidate",
      normalizedName: "winner candidate",
      status: "eligible_for_voting",
      suggestedBy: 9001,
      supportCount: 5,
    });
    const c2 = await createWantedCandidate({
      name: "Runner Up",
      normalizedName: "runner up",
      status: "eligible_for_voting",
      suggestedBy: 9002,
      supportCount: 4,
    });

    const ballot = await prepareMonthlyBallot({ adminId });

    // 3 paying members: 2 vote for c1, 1 for c2
    const voters = [9031, 9032, 9033];
    for (const v of voters) {
      await createEntitlement({
        userId: v,
        source: "telegram_stars",
        spaces: ["vip_collections", "general_chat", "wanted_list"],
        startsAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30 * 86400 * 1000).toISOString(),
        status: "active",
      });
    }

    await castVote({ userId: 9031, ballotId: ballot.id, candidateId: c1.id });
    await castVote({ userId: 9032, ballotId: ballot.id, candidateId: c1.id });
    await castVote({ userId: 9033, ballotId: ballot.id, candidateId: c2.id });

    // Close ballot
    const summary = await closeAndFinalizeBallot(ballot.id, api);
    assertEquals(summary.totalVotes, 3);
    assertEquals(summary.isTie, false);
    assertEquals(summary.winner?.candidateId, c1.id);
    assertEquals(summary.winner?.creatorName, "Winner Candidate");

    // Turnout: 3 voters out of 3 paying members = 100%
    assertEquals(summary.eligibleTurnoutPct, 100);

    // Ballot status is closed
    const closedBallot = await getBallot(ballot.id);
    assertEquals(closedBallot?.status, "closed");
    assertEquals(closedBallot?.winnerCandidateId, c1.id);
  } finally {
    await kv.close();
  }
});

Deno.test("VOTING — Tie vote automatically schedules 5-day runoff ballot", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockTelegramApi();
    const adminId = 111111;

    const c1 = await createWantedCandidate({
      name: "Candidate Tie 1",
      normalizedName: "candidate tie 1",
      status: "eligible_for_voting",
      suggestedBy: 9001,
      supportCount: 5,
    });
    const c2 = await createWantedCandidate({
      name: "Candidate Tie 2",
      normalizedName: "candidate tie 2",
      status: "eligible_for_voting",
      suggestedBy: 9002,
      supportCount: 4,
    });

    const ballot = await prepareMonthlyBallot({ adminId });

    // 2 paying members tie: 1 for c1, 1 for c2
    const voters = [9041, 9042];
    for (const v of voters) {
      await createEntitlement({
        userId: v,
        source: "telegram_stars",
        spaces: ["vip_collections", "general_chat", "wanted_list"],
        startsAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30 * 86400 * 1000).toISOString(),
        status: "active",
      });
    }

    await castVote({ userId: 9041, ballotId: ballot.id, candidateId: c1.id });
    await castVote({ userId: 9042, ballotId: ballot.id, candidateId: c2.id });

    const summary = await closeAndFinalizeBallot(ballot.id, api);
    assertEquals(summary.isTie, true);
    assertEquals(summary.tiedCandidates.length, 2);

    // Active ballot must now be the newly generated RUNOFF ballot!
    const activeBallot = await getActiveBallot();
    assertNotEquals(activeBallot, null);
    assertEquals(activeBallot?.isRunoff, true);
    assertEquals(activeBallot?.parentBallotId, ballot.id);
    assertEquals(activeBallot?.candidates.length, 2);
  } finally {
    await kv.close();
  }
});
