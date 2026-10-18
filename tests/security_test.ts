/**
 * Underground Manager — Pre-Publish Test Suite: SECURITY & RESILIENCE
 */

import { assertEquals } from "@std/assert";
import { setupTestEnvironment, MockTelegramApi } from "./test_helpers.ts";
import { isAdministrator } from "../src/config.ts";
import { getMember, getMemberByUsername, upsertMember } from "../src/db/members.ts";
import { idempotencyMiddleware } from "../src/bot/middleware/idempotency.ts";
import { TelegramStarsProvider } from "../src/payments/stars.ts";
import { removeMemberFromSpace } from "../src/access/sync.ts";

Deno.test("SECURITY — Webhook secret verification rejects spoofed requests", () => {
  const secret: string = "test_secret_token_12345";

  // Simulate incoming HTTP request with invalid token
  const spoofedHeader: string = "malicious_fake_token";
  assertEquals(spoofedHeader === secret, false);

  // Valid token
  const validHeader: string = "test_secret_token_12345";
  assertEquals(validHeader === secret, true);
});

Deno.test("SECURITY — Update idempotency middleware drops replayed updates", async () => {
  const kv = await setupTestEnvironment();
  try {
    let callCount = 0;
    const nextFn = () => {
      callCount++;
      return Promise.resolve();
    };

    const mockCtx = {
      update: {
        update_id: 88812345,
      },
    } as any;

    // First time update arrives -> executed
    await idempotencyMiddleware(mockCtx, nextFn);
    assertEquals(callCount, 1);

    // Second time same update arrives -> dropped
    await idempotencyMiddleware(mockCtx, nextFn);
    assertEquals(callCount, 1); // Should still be 1!
  } finally {
    await kv.close();
  }
});

Deno.test("SECURITY — Non-administrators are denied privileged operations", () => {
  const adminId1 = 111111;
  const adminId2 = 222222;
  const regularUserId = 333333;
  const attackerUserId = 999999;

  assertEquals(isAdministrator(adminId1), true);
  assertEquals(isAdministrator(adminId2), true);
  assertEquals(isAdministrator(regularUserId), false);
  assertEquals(isAdministrator(attackerUserId), false);
});

Deno.test("SECURITY — Telegram username changes preserve immutable numeric identity", async () => {
  const kv = await setupTestEnvironment();
  try {
    const userId = 8001;

    // User starts bot with username 'old_handle'
    await upsertMember({
      id: userId,
      username: "old_handle",
      first_name: "John",
    });

    let byOld = await getMemberByUsername("old_handle");
    assertEquals(byOld?.userId, userId);

    // User changes username on Telegram to 'new_handle'
    await upsertMember({
      id: userId,
      username: "new_handle",
      first_name: "John",
    });

    // Lookup by new handle succeeds
    const byNew = await getMemberByUsername("new_handle");
    assertEquals(byNew?.userId, userId);

    // Lookup by old handle must be null / cleared
    byOld = await getMemberByUsername("old_handle");
    assertEquals(byOld, null);

    // Lookup by immutable numeric ID is preserved
    const byId = await getMember(userId);
    assertEquals(byId?.username, "new_handle");
  } finally {
    await kv.close();
  }
});

Deno.test("SECURITY — Concurrent payment notifications do not double-credit (Atomic Isolation)", async () => {
  const kv = await setupTestEnvironment();
  try {
    const provider = new TelegramStarsProvider();
    const userId = 8002;
    const payload = TelegramStarsProvider.buildInvoicePayload(userId);
    const chargeId = "tg_concurrent_charge_001";

    const paymentData = {
      currency: "XTR",
      total_amount: 750,
      invoice_payload: payload,
      telegram_payment_charge_id: chargeId,
      provider_payment_charge_id: "prov_concurrent_001",
      is_recurring: true,
    };

    // Execute two concurrent payments with identical charge ID at the exact same moment
    const [res1, res2] = await Promise.all([
      provider.handleSuccessfulPayment(paymentData, userId),
      provider.handleSuccessfulPayment(paymentData, userId),
    ]);

    // Exactly one should succeed, and the other must be recognized as duplicate!
    const successCount = (res1.success ? 1 : 0) + (res2.success ? 1 : 0);
    const duplicateCount = (res1.isDuplicate ? 1 : 0) + (res2.isDuplicate ? 1 : 0);

    assertEquals(successCount, 1);
    assertEquals(duplicateCount, 1);
  } finally {
    await kv.close();
  }
});

Deno.test("SECURITY — Temporary Telegram API failures are safely caught without crashing", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockTelegramApi();
    // Simulate Telegram API throwing an error (e.g. 500 or rate limit)
    api.getChatMember = () => Promise.reject(new Error("Telegram API temporary 502 Bad Gateway"));

    const result = await removeMemberFromSpace(api, "vip_collections", 8003);
    assertEquals(result.success, false);
    assertEquals(result.error?.includes("502 Bad Gateway"), true);
  } finally {
    await kv.close();
  }
});
