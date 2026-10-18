/**
 * Underground Manager — Pre-Publish Test Suite: ACCESS & PERMISSIONS
 */

import { assertEquals } from "@std/assert";
import { setupTestEnvironment, MockTelegramApi } from "./test_helpers.ts";
import { processChatJoinRequest } from "../src/access/join_requests.ts";
import {
  checkBotPermissions,
  reconcileAllMembers,
  removeMemberFromSpace,
} from "../src/access/sync.ts";
import { createEntitlement, revokeEntitlement } from "../src/db/entitlements.ts";
import { getSyncState, recordSyncState } from "../src/db/sync.ts";
import { getChatId } from "../src/access/spaces.ts";

Deno.test("ACCESS — Paid member is automatically approved for authorized spaces", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockTelegramApi();
    const userId = 6001;

    // Grant active entitlement covering all 3 spaces
    await createEntitlement({
      userId,
      source: "telegram_stars",
      spaces: ["vip_collections", "general_chat", "wanted_list"],
      startsAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 86400 * 1000).toISOString(),
      status: "active",
    });

    // Test join request for TOKEBEC VIP COLLECTIONS (-1001001)
    const vipRes = await processChatJoinRequest(api, {
      chat: { id: -1001001, title: "TOKEBEC VIP COLLECTIONS" },
      from: { id: userId, first_name: "Paid Member" },
    });
    assertEquals(vipRes.approved, true);
    assertEquals(api.approvedJoinRequests.length, 1);
    assertEquals(api.approvedJoinRequests[0].userId, userId);

    // Verify sync state is updated to 'admitted'
    const syncState = await getSyncState(userId, "vip_collections");
    assertEquals(syncState?.status, "admitted");

    // Test join request for General Chat (-1001003)
    const chatRes = await processChatJoinRequest(api, {
      chat: { id: -1001003, title: "Underground General Chat" },
      from: { id: userId, first_name: "Paid Member" },
    });
    assertEquals(chatRes.approved, true);
    assertEquals(api.approvedJoinRequests.length, 2);
  } finally {
    await kv.close();
  }
});

Deno.test("ACCESS — Unpaid member is rejected when requesting to join", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockTelegramApi();
    const unpaidUserId = 6002;

    const res = await processChatJoinRequest(api, {
      chat: { id: -1001001, title: "TOKEBEC VIP COLLECTIONS" },
      from: { id: unpaidUserId, first_name: "Unpaid User" },
    });

    assertEquals(res.approved, false);
    assertEquals(api.declinedJoinRequests.length, 1);
    assertEquals(api.declinedJoinRequests[0].userId, unpaidUserId);
    assertEquals(api.approvedJoinRequests.length, 0);

    // Verify sync state is marked 'rejected'
    const syncState = await getSyncState(unpaidUserId, "vip_collections");
    assertEquals(syncState?.status, "rejected");
  } finally {
    await kv.close();
  }
});

Deno.test("ACCESS — Expired member is safely removed on reconciliation", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockTelegramApi();
    const expiredUserId = 6003;

    // Create an expired entitlement
    await createEntitlement({
      userId: expiredUserId,
      source: "telegram_stars",
      spaces: ["vip_collections"],
      startsAt: new Date(Date.now() - 31 * 86400 * 1000).toISOString(),
      expiresAt: new Date(Date.now() - 3600 * 1000).toISOString(), // Expired 1h ago
      status: "active",
    });

    // Mark as previously admitted in sync state
    await recordSyncState({
      userId: expiredUserId,
      spaceId: "vip_collections",
      chatId: -1001001,
      status: "admitted",
      lastSyncAt: new Date(Date.now() - 30 * 86400 * 1000).toISOString(),
    });

    // Run reconciliation
    const result = await reconcileAllMembers(api);
    assertEquals(result.removedCount, 1);

    // Verify member was banned then unbanned (kicked, not permanently blacklisted)
    assertEquals(api.bannedMembers.length, 1);
    assertEquals(api.bannedMembers[0].userId, expiredUserId);
    assertEquals(api.unbannedMembers.length, 1);
    assertEquals(api.unbannedMembers[0].userId, expiredUserId);

    // Sync state should now be 'removed'
    const syncState = await getSyncState(expiredUserId, "vip_collections");
    assertEquals(syncState?.status, "removed");
  } finally {
    await kv.close();
  }
});

Deno.test("ACCESS — Old invitation cannot bypass access checks", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockTelegramApi();
    const sneakyUserId = 6004;

    // User finds a previously created join link, but has NO active entitlement in DB
    const res = await processChatJoinRequest(api, {
      chat: { id: -1001001, title: "TOKEBEC VIP COLLECTIONS" },
      from: { id: sneakyUserId, first_name: "Sneaky User" },
    });

    // Bot evaluates user identity at join request time and declines
    assertEquals(res.approved, false);
    assertEquals(api.declinedJoinRequests.length, 1);
  } finally {
    await kv.close();
  }
});

Deno.test("ACCESS — Renewed member can rejoin after being removed", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockTelegramApi();
    const userId = 6005;

    // 1. User was previously removed
    await recordSyncState({
      userId,
      spaceId: "vip_collections",
      chatId: -1001001,
      status: "removed",
      lastSyncAt: new Date(Date.now() - 86400 * 1000).toISOString(),
    });

    // 2. User purchases a new renewal entitlement
    await createEntitlement({
      userId,
      source: "telegram_stars",
      spaces: ["vip_collections", "general_chat", "wanted_list"],
      startsAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 86400 * 1000).toISOString(),
      status: "active",
    });

    // 3. User requests to rejoin
    const res = await processChatJoinRequest(api, {
      chat: { id: -1001001, title: "TOKEBEC VIP COLLECTIONS" },
      from: { id: userId, first_name: "Rejoining Member" },
    });

    assertEquals(res.approved, true);
    assertEquals(api.approvedJoinRequests.length, 1);
    assertEquals(api.approvedJoinRequests[0].userId, userId);

    const syncState = await getSyncState(userId, "vip_collections");
    assertEquals(syncState?.status, "admitted");
  } finally {
    await kv.close();
  }
});

Deno.test("ACCESS — Overlapping entitlements retain valid access when one expires", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockTelegramApi();
    const userId = 6006;

    // Entitlement 1: Complimentary expiring now
    await createEntitlement({
      userId,
      source: "complimentary",
      spaces: ["vip_collections"],
      startsAt: new Date(Date.now() - 7 * 86400 * 1000).toISOString(),
      expiresAt: new Date(Date.now() - 1000).toISOString(), // Just expired
      status: "active",
    });

    // Entitlement 2: Paid Stars active for 20 more days
    await createEntitlement({
      userId,
      source: "telegram_stars",
      spaces: ["vip_collections", "general_chat", "wanted_list"],
      startsAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 20 * 86400 * 1000).toISOString(),
      status: "active",
    });

    // Mark as admitted
    await recordSyncState({
      userId,
      spaceId: "vip_collections",
      chatId: -1001001,
      status: "admitted",
      lastSyncAt: new Date().toISOString(),
    });

    // Run reconciliation
    const result = await reconcileAllMembers(api);

    // Member should NOT be removed because valid paid entitlement covers the space!
    assertEquals(result.removedCount, 0);
    assertEquals(api.bannedMembers.length, 0);

    const syncState = await getSyncState(userId, "vip_collections");
    assertEquals(syncState?.status, "admitted");
  } finally {
    await kv.close();
  }
});

Deno.test("ACCESS — Missing Telegram admin permissions produce an alert", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockTelegramApi();
    // Simulate bot having restricted status or missing can_restrict_members in VIP collections
    api.mockMemberStatus.set("-1001001:999999", {
      status: "administrator",
      can_invite_users: true,
      can_restrict_members: false, // Missing restrict permission!
    });

    const check = await checkBotPermissions(api, "vip_collections");
    assertEquals(check.ok, false);
    assertEquals(check.missingPermissions.includes("can_restrict_members"), true);
  } finally {
    await kv.close();
  }
});

Deno.test("ACCESS — Reconciliation can safely be rerun without duplicate removals", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockTelegramApi();
    const userId = 6007;

    // Create expired entitlement
    await createEntitlement({
      userId,
      source: "telegram_stars",
      spaces: ["vip_collections"],
      startsAt: new Date(Date.now() - 31 * 86400 * 1000).toISOString(),
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      status: "active",
    });

    await recordSyncState({
      userId,
      spaceId: "vip_collections",
      chatId: -1001001,
      status: "admitted",
      lastSyncAt: new Date().toISOString(),
    });

    // First reconciliation run: removes expired member
    const firstRun = await reconcileAllMembers(api);
    assertEquals(firstRun.removedCount, 1);

    // Second immediate rerun: should do nothing (state is already 'removed')
    const secondRun = await reconcileAllMembers(api);
    assertEquals(secondRun.removedCount, 0);
    assertEquals(api.bannedMembers.length, 1); // No new bans
  } finally {
    await kv.close();
  }
});

Deno.test("ACCESS — Administrator accounts are protected and never kicked", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockTelegramApi();
    const adminUserId = 111111;

    // Mark admin as creator in chat
    api.mockMemberStatus.set("-1001001:111111", {
      status: "creator",
    });

    // Even if no entitlement exists, removeMemberFromSpace must protect the creator
    const result = await removeMemberFromSpace(api, "vip_collections", adminUserId);
    assertEquals(result.success, true);
    assertEquals(result.skippedProtected, true);
    assertEquals(api.bannedMembers.length, 0); // Must NOT ban admin!
  } finally {
    await kv.close();
  }
});
