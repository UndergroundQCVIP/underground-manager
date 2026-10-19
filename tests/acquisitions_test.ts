/**
 * LA CONFRÉRIE — UG-02 Pre-Publish Test Suite: ACQUISITION WORKFLOW
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import { setupTestEnvironment } from "./test_helpers.ts";
import {
  createWantedCandidate,
  getWantedCandidate,
  mergeWantedCandidates,
  updateWantedStatus,
} from "../src/db/wanted.ts";
import { handleForumTopicCreated } from "../src/creators/service.ts";
import { WantedCandidateStatus } from "../src/types.ts";

Deno.test("ACQUISITIONS — Full lifecycle status progression of a wanted candidate", async () => {
  const kv = await setupTestEnvironment();
  try {
    const candidate = await createWantedCandidate({
      name: "Acquisition Target",
      normalizedName: "acquisition target",
      status: "requested",
      suggestedBy: 9501,
      supportCount: 12,
    });

    const lifecycle: WantedCandidateStatus[] = [
      "pricing_review",
      "eligible_for_voting",
      "voting",
      "selected",
      "acquisition_pending",
      "acquired",
      "available",
    ];

    for (const status of lifecycle) {
      const updated = await updateWantedStatus(candidate.id, status, `Transition to ${status}`);
      assertEquals(updated?.status, status);
    }

    const finalState = await getWantedCandidate(candidate.id);
    assertEquals(finalState?.status, "available");
  } finally {
    await kv.close();
  }
});

Deno.test("ACQUISITIONS — Merging duplicate candidates aggregates supporter counts and removes source", async () => {
  const kv = await setupTestEnvironment();
  try {
    // Two users nominated the same person with slight spelling variations
    const target = await createWantedCandidate({
      name: "Hannah",
      normalizedName: "hannah",
      status: "requested",
      suggestedBy: 9502,
      supportCount: 15,
    });

    const duplicateSource = await createWantedCandidate({
      name: "Hannah VIP",
      normalizedName: "hannah vip",
      status: "requested",
      suggestedBy: 9503,
      supportCount: 8,
    });

    // Admin merges duplicateSource into target
    const merged = await mergeWantedCandidates(duplicateSource.id, target.id);
    assertNotEquals(merged, null);
    assertEquals(merged?.name, "Hannah");
    // Supporter counts must be aggregated: 15 + 8 = 23
    assertEquals(merged?.supportCount, 23);

    // Source candidate should be deleted
    const deleted = await getWantedCandidate(duplicateSource.id);
    assertEquals(deleted, null);

    // Target candidate updated in database
    const fetchedTarget = await getWantedCandidate(target.id);
    assertEquals(fetchedTarget?.supportCount, 23);
  } finally {
    await kv.close();
  }
});

Deno.test("ACQUISITIONS — Forum topic creation automatically transitions matched wanted candidate to available", async () => {
  const kv = await setupTestEnvironment();
  try {
    const forumChatId = -1001001;
    const threadId = 555;

    // Wanted candidate is in 'acquired' status
    const candidate = await createWantedCandidate({
      name: "Serena",
      normalizedName: "serena",
      status: "acquired",
      suggestedBy: 9504,
      supportCount: 25,
    });

    // Admin finishes upload and creates topic for Serena
    const creator = await handleForumTopicCreated(forumChatId, threadId, "Serena");
    assertNotEquals(creator, null);
    assertEquals(creator?.wantedListId, candidate.id);

    // Candidate should now automatically be marked 'available'
    const updatedCandidate = await getWantedCandidate(candidate.id);
    assertEquals(updatedCandidate?.status, "available");
    assertEquals(updatedCandidate?.creatorId, creator?.id);
  } finally {
    await kv.close();
  }
});
