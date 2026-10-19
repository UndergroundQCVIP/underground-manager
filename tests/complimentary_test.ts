/**
 * LA CONFRÉRIE — Pre-Publish Test Suite: COMPLIMENTARY ACCESS
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import { setupTestEnvironment, MockTelegramApi } from "./test_helpers.ts";
import {
  extendComplimentaryAccess,
  grantComplimentaryAccess,
  processComplimentaryReminders,
  revokeComplimentaryAccess,
} from "../src/complimentary/service.ts";
import {
  createEntitlement,
  getActiveUserEntitlements,
  getEntitlement,
  getMembershipSummary,
} from "../src/db/entitlements.ts";
import { processChatJoinRequest } from "../src/access/join_requests.ts";
import { isAdministrator } from "../src/config.ts";
import { TelegramStarsProvider } from "../src/payments/stars.ts";

Deno.test("COMPLIMENTARY — Admin grants 30 days access with reason and audit trail", async () => {
  const kv = await setupTestEnvironment();
  try {
    const adminId = 111111;
    const recipientId = 7001;

    const result = await grantComplimentaryAccess({
      adminId,
      userId: recipientId,
      durationDays: 30,
      reason: "content_contribution",
      level: "vip_only",
    });

    assertEquals(result.success, true);
    assertNotEquals(result.entitlement, undefined);
    assertEquals(result.entitlement?.userId, recipientId);
    assertEquals(result.entitlement?.source, "complimentary");
    assertEquals(result.entitlement?.spaces, ["vip_collections"]);
    assertEquals(result.entitlement?.metadata?.grantedBy, adminId);
    assertEquals(result.entitlement?.metadata?.reason, "content_contribution");

    const summary = await getMembershipSummary(recipientId);
    assertEquals(summary.isMember, true);
    assertEquals(summary.hasComplimentary, true);
    assertEquals(summary.hasPaid, false);
    assertEquals(summary.primaryType, "Complimentary");
  } finally {
    await kv.close();
  }
});

Deno.test("COMPLIMENTARY — Unauthorized user cannot grant access", async () => {
  const kv = await setupTestEnvironment();
  try {
    const nonAdminId = 999999;
    const isAuth = isAdministrator(nonAdminId);
    assertEquals(isAuth, false);
  } finally {
    await kv.close();
  }
});

Deno.test("COMPLIMENTARY — Member joins authorized spaces but is rejected from unauthorized", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockTelegramApi();
    const adminId = 111111;
    const recipientId = 7002;

    // Grant access to VIP Collections only
    await grantComplimentaryAccess({
      adminId,
      userId: recipientId,
      durationDays: 30,
      reason: "promotion",
      level: "vip_only",
    });

    // 1. Request to join VIP Collections (-1001001) -> MUST APPROVE
    const vipRes = await processChatJoinRequest(api, {
      chat: { id: -1001001, title: "TOKEBEC VIP COLLECTIONS" },
      from: { id: recipientId, first_name: "Promo User" },
    });
    assertEquals(vipRes.approved, true);

    // 2. Request to join General Chat (-1001003) -> MUST DECLINE (not in level)
    const chatRes = await processChatJoinRequest(api, {
      chat: { id: -1001003, title: "Underground General Chat" },
      from: { id: recipientId, first_name: "Promo User" },
    });
    assertEquals(chatRes.approved, false);
  } finally {
    await kv.close();
  }
});

Deno.test("COMPLIMENTARY — Access expires automatically without manual intervention", async () => {
  const kv = await setupTestEnvironment();
  try {
    const recipientId = 7003;

    // Create a complimentary entitlement that expired 5 minutes ago
    await createEntitlement({
      userId: recipientId,
      source: "complimentary",
      spaces: ["vip_collections"],
      startsAt: new Date(Date.now() - 31 * 86400 * 1000).toISOString(),
      expiresAt: new Date(Date.now() - 300 * 1000).toISOString(),
      status: "active",
    });

    const active = await getActiveUserEntitlements(recipientId);
    assertEquals(active.length, 0);

    const summary = await getMembershipSummary(recipientId);
    assertEquals(summary.isMember, false);
  } finally {
    await kv.close();
  }
});

Deno.test("COMPLIMENTARY — Reminder is sent approximately 3 days before expiry", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockTelegramApi();
    const recipientId = 7004;

    // Entitlement expiring in 2 days (within the 3-day threshold)
    const expiresAt = new Date(Date.now() + 2 * 86400 * 1000).toISOString();
    const ent = await createEntitlement({
      userId: recipientId,
      source: "complimentary",
      spaces: ["vip_collections"],
      startsAt: new Date(Date.now() - 28 * 86400 * 1000).toISOString(),
      expiresAt,
      status: "active",
      metadata: {
        grantedBy: 111111,
        reason: "promotion",
        reminderSent: false,
      },
    });

    // Run reminder processor
    const result = await processComplimentaryReminders(api);
    assertEquals(result.remindedCount, 1);
    assertEquals(api.sentMessages.length, 1);
    assertEquals(api.sentMessages[0].chatId, recipientId);
    assertEquals(api.sentMessages[0].text.includes("expire dans environ"), true);

    // Verify reminderSent flag is now set
    const updated = await getEntitlement(ent.id);
    assertEquals(updated?.metadata?.reminderSent, true);

    // Second run: should NOT resend duplicate reminder
    const secondResult = await processComplimentaryReminders(api);
    assertEquals(secondResult.remindedCount, 0);
  } finally {
    await kv.close();
  }
});

Deno.test("COMPLIMENTARY — Member seamlessly converts to paid Stars subscription", async () => {
  const kv = await setupTestEnvironment();
  try {
    const provider = new TelegramStarsProvider();
    const adminId = 111111;
    const recipientId = 7005;

    // 1. Initial complimentary grant (10 days remaining)
    await grantComplimentaryAccess({
      adminId,
      userId: recipientId,
      durationDays: 10,
      reason: "promotion",
      level: "vip_only",
    });

    let summary = await getMembershipSummary(recipientId);
    assertEquals(summary.hasComplimentary, true);
    assertEquals(summary.hasPaid, false);

    // 2. Member decides to subscribe with Telegram Stars
    const payload = TelegramStarsProvider.buildInvoicePayload(recipientId);
    const payResult = await provider.handleSuccessfulPayment(
      {
        currency: "XTR",
        total_amount: 750,
        invoice_payload: payload,
        telegram_payment_charge_id: "tg_convert_005",
        provider_payment_charge_id: "prov_convert_005",
        is_recurring: true,
      },
      recipientId
    );
    assertEquals(payResult.success, true);

    // 3. User now has BOTH paid and complimentary entitlements, with full access to all 3 spaces!
    summary = await getMembershipSummary(recipientId);
    assertEquals(summary.hasPaid, true);
    assertEquals(summary.primaryType, "Paid");
    assertEquals(summary.accessibleSpaces.length, 3);
  } finally {
    await kv.close();
  }
});

Deno.test("COMPLIMENTARY — Admin can extend and revoke complimentary access", async () => {
  const kv = await setupTestEnvironment();
  try {
    const adminId = 111111;
    const recipientId = 7006;

    const grant = await grantComplimentaryAccess({
      adminId,
      userId: recipientId,
      durationDays: 30,
      reason: "admin_exception",
      level: "full",
    });
    const entId = grant.entitlement!.id;

    // Extend by 15 days
    const ext = await extendComplimentaryAccess(adminId, entId, 15);
    assertEquals(ext.success, true);
    const initialExpiryMs = new Date(grant.entitlement!.expiresAt).getTime();
    const newExpiryMs = new Date(ext.entitlement!.expiresAt).getTime();
    assertEquals(Math.round((newExpiryMs - initialExpiryMs) / 1000), 15 * 86400);

    // Revoke access
    const rev = await revokeComplimentaryAccess(adminId, entId, "Terms violation");
    assertEquals(rev.success, true);
    assertEquals(rev.entitlement?.status, "revoked");

    // Active entitlements should now be 0
    const active = await getActiveUserEntitlements(recipientId);
    assertEquals(active.length, 0);
  } finally {
    await kv.close();
  }
});

Deno.test("COMPLIMENTARY — Existing paid membership remains valid if complimentary is granted or revoked", async () => {
  const kv = await setupTestEnvironment();
  try {
    const adminId = 111111;
    const userId = 7007;

    // 1. User has an active paid entitlement for 20 days
    const paidExpiry = new Date(Date.now() + 20 * 86400 * 1000).toISOString();
    const paidEnt = await createEntitlement({
      userId,
      source: "telegram_stars",
      spaces: ["vip_collections", "general_chat", "wanted_list"],
      startsAt: new Date().toISOString(),
      expiresAt: paidExpiry,
      status: "active",
    });

    // 2. Admin grants complimentary access for 7 days
    const compResult = await grantComplimentaryAccess({
      adminId,
      userId,
      durationDays: 7,
      reason: "partnership",
      level: "vip_only",
    });
    assertEquals(compResult.success, true);

    // Paid entitlement must remain untouched
    const fetchedPaid = await getEntitlement(paidEnt.id);
    assertEquals(fetchedPaid?.status, "active");
    assertEquals(fetchedPaid?.expiresAt, paidExpiry);

    // 3. Admin revokes the complimentary grant
    await revokeComplimentaryAccess(adminId, compResult.entitlement!.id, "Revoked test");

    // Paid entitlement is still active and valid
    const summary = await getMembershipSummary(userId);
    assertEquals(summary.isMember, true);
    assertEquals(summary.hasPaid, true);
    assertEquals(summary.accessibleSpaces.length, 3);
  } finally {
    await kv.close();
  }
});
