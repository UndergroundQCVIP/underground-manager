/**
 * LA CONFRÉRIE — UG-02 Pre-Publish Test Suite: WANTED LIST & NOMINATIONS
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import { setupTestEnvironment, MockTelegramApi } from "./test_helpers.ts";
import {
  submitCreatorNomination,
  supportExistingCandidate,
  syncWantedListChannel,
} from "../src/wanted/service.ts";
import { createEntitlement } from "../src/db/entitlements.ts";
import { saveCreator } from "../src/db/creators.ts";
import {
  getWantedCandidate,
  listWantedCandidates,
} from "../src/db/wanted.ts";

Deno.test("WANTED — Paid subscriber can nominate creator and gains automatic support", async () => {
  const kv = await setupTestEnvironment();
  try {
    const paidUserId = 8001;

    // Grant paid entitlement
    await createEntitlement({
      userId: paidUserId,
      source: "telegram_stars",
      spaces: ["vip_collections", "general_chat", "wanted_list"],
      startsAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 86400 * 1000).toISOString(),
      status: "active",
    });

    const result = await submitCreatorNomination({
      userId: paidUserId,
      name: "Eva",
      profileUrl: "https://fansly.com/eva",
    });

    assertEquals(result.success, true);
    assertEquals(result.isExistingCandidate, false);
    assertNotEquals(result.candidate, undefined);
    assertEquals(result.candidate?.name, "Eva");
    assertEquals(result.candidate?.supportCount, 1);
    assertEquals(result.candidate?.status, "requested");
  } finally {
    await kv.close();
  }
});

Deno.test("WANTED — Complimentary members cannot nominate or support by default", async () => {
  const kv = await setupTestEnvironment();
  try {
    const compUserId = 8002;

    // Grant complimentary access to Wanted List
    await createEntitlement({
      userId: compUserId,
      source: "complimentary",
      spaces: ["vip_collections", "wanted_list"],
      startsAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 86400 * 1000).toISOString(),
      status: "active",
    });

    const result = await submitCreatorNomination({
      userId: compUserId,
      name: "Bella",
    });

    assertEquals(result.success, false);
    assertEquals(result.error?.includes("Only active paying subscribers"), true);
  } finally {
    await kv.close();
  }
});

Deno.test("WANTED — Cannot nominate creator already available in VIP Collections", async () => {
  const kv = await setupTestEnvironment();
  try {
    const paidUserId = 8003;

    await createEntitlement({
      userId: paidUserId,
      source: "telegram_stars",
      spaces: ["vip_collections", "general_chat", "wanted_list"],
      startsAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 86400 * 1000).toISOString(),
      status: "active",
    });

    // Save existing creator with content in VIP collections
    await saveCreator({
      id: "aria_id",
      name: "Aria",
      normalizedName: "aria",
      chatId: -1001001,
      topicId: 401,
      topicCreatedAt: new Date().toISOString(),
      hasContent: true,
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const result = await submitCreatorNomination({
      userId: paidUserId,
      name: "Aria",
    });

    assertEquals(result.success, false);
    assertEquals(result.error?.includes("already available in TOKEBEC VIP COLLECTIONS"), true);
  } finally {
    await kv.close();
  }
});

Deno.test("WANTED — Existing candidate receives support instead of creating duplicate", async () => {
  const kv = await setupTestEnvironment();
  try {
    const user1 = 8004;
    const user2 = 8005;

    // Grant paid subscriptions to both users
    for (const u of [user1, user2]) {
      await createEntitlement({
        userId: u,
        source: "telegram_stars",
        spaces: ["vip_collections", "general_chat", "wanted_list"],
        startsAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30 * 86400 * 1000).toISOString(),
        status: "active",
      });
    }

    // User 1 nominates "Klara"
    const nom1 = await submitCreatorNomination({ userId: user1, name: "Klara" });
    assertEquals(nom1.success, true);
    assertEquals(nom1.candidate?.supportCount, 1);

    // User 2 suggests same creator "Klara"
    const nom2 = await submitCreatorNomination({ userId: user2, name: "Klara" });
    assertEquals(nom2.success, true);
    assertEquals(nom2.isExistingCandidate, true);
    assertEquals(nom2.candidate?.id, nom1.candidate?.id); // Same candidate record
    assertEquals(nom2.candidate?.supportCount, 2); // Supporter count incremented to 2!

    const all = await listWantedCandidates();
    assertEquals(all.length, 1);
  } finally {
    await kv.close();
  }
});

Deno.test("WANTED — Duplicate nomination or support in same monthly cycle is rejected", async () => {
  const kv = await setupTestEnvironment();
  try {
    const paidUserId = 8006;

    await createEntitlement({
      userId: paidUserId,
      source: "telegram_stars",
      spaces: ["vip_collections", "general_chat", "wanted_list"],
      startsAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 86400 * 1000).toISOString(),
      status: "active",
    });

    // First nomination succeeds
    const nom1 = await submitCreatorNomination({ userId: paidUserId, name: "Scarlett" });
    assertEquals(nom1.success, true);

    // Second nomination in same cycle is rejected
    const nom2 = await submitCreatorNomination({ userId: paidUserId, name: "Zoe" });
    assertEquals(nom2.success, false);
    assertEquals(nom2.alreadySupportedThisCycle, true);
  } finally {
    await kv.close();
  }
});

Deno.test("WANTED — Candidate rankings sorted by unique supporter count", async () => {
  const kv = await setupTestEnvironment();
  try {
    const userA = 8010;
    const userB = 8011;
    const userC = 8012;

    for (const u of [userA, userB, userC]) {
      await createEntitlement({
        userId: u,
        source: "telegram_stars",
        spaces: ["vip_collections", "general_chat", "wanted_list"],
        startsAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30 * 86400 * 1000).toISOString(),
        status: "active",
      });
    }

    // User A nominates Candidate 1
    const nom1 = await submitCreatorNomination({ userId: userA, name: "Creator One" });
    // User B nominates Candidate 2
    const nom2 = await submitCreatorNomination({ userId: userB, name: "Creator Two" });
    // User C supports Candidate 2
    await supportExistingCandidate(userC, nom2.candidate!.id);

    const rankings = await listWantedCandidates();
    assertEquals(rankings.length, 2);
    // Creator Two should be #1 with 2 supporters
    assertEquals(rankings[0].name, "Creator Two");
    assertEquals(rankings[0].supportCount, 2);
    // Creator One should be #2 with 1 supporter
    assertEquals(rankings[1].name, "Creator One");
    assertEquals(rankings[1].supportCount, 1);
  } finally {
    await kv.close();
  }
});

Deno.test("WANTED — Channel synchronization publishes read-only list with rankings", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockTelegramApi();
    const paidUser = 8020;

    await createEntitlement({
      userId: paidUser,
      source: "telegram_stars",
      spaces: ["vip_collections", "general_chat", "wanted_list"],
      startsAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 86400 * 1000).toISOString(),
      status: "active",
    });

    await submitCreatorNomination({ userId: paidUser, name: "Luna" });

    const result = await syncWantedListChannel(api);
    assertEquals(result.success, true);
    assertEquals(api.sentMessages.length, 1);
    assertEquals(api.sentMessages[0].chatId, -1001002); // WANTED_LIST_CHAT_ID

    const text = api.sentMessages[0].text;
    assertEquals(text.includes("*Luna*"), true);
    assertEquals(text.includes("1 supporter"), true);
    assertEquals(text.includes("[Requested]"), true);
  } finally {
    await kv.close();
  }
});
