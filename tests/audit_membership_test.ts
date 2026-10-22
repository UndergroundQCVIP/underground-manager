/**
 * Regression tests for defects found in the independent audit — UG-01
 * (memberships, payments, access control, infrastructure).
 */

import { assert, assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { MOCK_CONFIG, setupTestEnvironment } from "./test_helpers.ts";
import { createFetchHandler, isValidWebhookSecret } from "../src/server.ts";
import { fatalConfigErrors, getDailySyncHour, loadConfig, validateConfig } from "../src/config.ts";
import { idempotencyMiddleware } from "../src/bot/middleware/idempotency.ts";
import { TelegramStarsProvider } from "../src/payments/stars.ts";
import {
  applyPaidPeriod,
  createEntitlement,
  expireStaleEntitlements,
  extendEntitlement,
  getActiveUserEntitlements,
  getEntitlement,
  getMembershipSummary,
  getUserEntitlements,
  mutateEntitlement,
} from "../src/db/entitlements.ts";
import { getPaymentByChargeId, getUserPayments, listPaymentsPendingFulfillment, recordPayment } from "../src/db/payments.ts";
import { extendComplimentaryAccess, grantComplimentaryAccess, revokeComplimentaryAccess } from "../src/complimentary/service.ts";
import { removeMemberFromSpace } from "../src/access/sync.ts";
import { notifyAdmins } from "../src/ops/alerts.ts";
import { isDailySyncDue } from "../src/cron/reconciliation.ts";
import { torontoDateKey, torontoMonthCycle, torontoParts } from "../src/util/time.ts";
import { SPACE_IDS } from "../src/types.ts";
import { MockTelegramApi } from "./test_helpers.ts";

const DAY = 86_400_000;
const provider = new TelegramStarsProvider();

function payment(userId: number, chargeId: string, extra: Record<string, unknown> = {}) {
  return {
    currency: "XTR",
    total_amount: 750,
    invoice_payload: TelegramStarsProvider.buildInvoicePayload(userId),
    telegram_payment_charge_id: chargeId,
    provider_payment_charge_id: `p_${chargeId}`,
    is_recurring: true,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Webhook authentication
// ---------------------------------------------------------------------------
Deno.test("AUDIT SECURITY — webhook requires the Telegram secret token (fail closed)", async () => {
  const hits: string[] = [];
  const handler = createFetchHandler({
    webhookSecret: "a_valid_secret_value_123",
    handleWebhook: () => { hits.push("hit"); return Promise.resolve(new Response("ok")); },
  });
  const post = (headers: Record<string, string> = {}) =>
    handler(new Request("http://x/webhook", { method: "POST", headers, body: "{}" }));

  assertEquals((await post()).status, 401);
  assertEquals((await post({ "x-telegram-bot-api-secret-token": "wrong" })).status, 401);
  assertEquals((await post({ "x-telegram-bot-api-secret-token": "a_valid_secret_value_12" })).status, 401);
  assertEquals(hits.length, 0, "unauthenticated requests never reach the bot");
  assertEquals((await post({ "x-telegram-bot-api-secret-token": "a_valid_secret_value_123" })).status, 200);
  assertEquals(hits.length, 1);

  // No secret configured -> the endpoint accepts nothing at all
  const open = createFetchHandler({ webhookSecret: "", handleWebhook: () => Promise.resolve(new Response("ok")) });
  assertEquals((await open(new Request("http://x/webhook", { method: "POST", body: "{}" }))).status, 503);

  // Health endpoint discloses nothing about the deployment
  const health = await (await handler(new Request("http://x/health"))).json();
  assertEquals(Object.keys(health), ["status"]);

  assertEquals(await isValidWebhookSecret(null, "abc"), false);
  assertEquals(await isValidWebhookSecret("abc", ""), false);
});

Deno.test("AUDIT SECURITY — configuration without a webhook secret is fatal in every environment", () => {
  const base = { ...MOCK_CONFIG, DENO_ENV: "development" as const, BOT_MODE: "webhook" as const };
  assert(fatalConfigErrors({ ...base, WEBHOOK_SECRET: "" }).some((e) => e.startsWith("WEBHOOK_SECRET")));
  assert(validateConfig({ ...base, WEBHOOK_SECRET: "short" }).some((e) => e.includes("16-256")));
  assertEquals(fatalConfigErrors({ ...base, WEBHOOK_SECRET: "x".repeat(32) }).length, 0);
  // polling mode (local dev) does not need it
  assertEquals(fatalConfigErrors({ ...base, BOT_MODE: "polling", WEBHOOK_SECRET: "" }).length, 0);
  // three different spaces are required
  assert(validateConfig({ ...base, GENERAL_CHAT_ID: base.VIP_COLLECTIONS_CHAT_ID, WEBHOOK_SECRET: "x".repeat(32) })
    .some((e) => e.includes("different chats")));
  assertEquals(getDailySyncHour({ ...base, DIRECTORY_UPDATE_CRON: "0 3 * * *" }), 3);
  assertEquals(getDailySyncHour({ ...base, DIRECTORY_UPDATE_CRON: "30 5 * * *" }), 5);
  assertEquals(getDailySyncHour({ ...base, DIRECTORY_UPDATE_CRON: "garbage" }), 3);
  void loadConfig;
});

// ---------------------------------------------------------------------------
// Idempotency middleware
// ---------------------------------------------------------------------------
Deno.test("AUDIT IDEMPOTENCY — a failed update is retried, a completed one is not", async () => {
  const kv = await setupTestEnvironment();
  try {
    const ctx = { update: { update_id: 777 } } as never;
    let runs = 0;
    await assertRejects(() => idempotencyMiddleware(ctx, () => { runs++; throw new Error("db outage"); }));
    assertEquals(runs, 1);

    // Telegram redelivers: because the first attempt failed, it must run again
    await idempotencyMiddleware(ctx, () => { runs++; return Promise.resolve(); });
    assertEquals(runs, 2);

    // Now it is done: replays are ignored
    await idempotencyMiddleware(ctx, () => { runs++; return Promise.resolve(); });
    assertEquals(runs, 2);

    // Two concurrent deliveries: exactly one handler run
    const c2 = { update: { update_id: 778 } } as never;
    let concurrent = 0;
    const slow = async () => { concurrent++; await new Promise((r) => setTimeout(r, 20)); };
    await Promise.all([idempotencyMiddleware(c2, slow), idempotencyMiddleware(c2, slow), idempotencyMiddleware(c2, slow)]);
    assertEquals(concurrent, 1);

    // A claim abandoned by a crashed isolate (stale lease) is taken over
    const { getKv } = await import("../src/db/kv.ts");
    const k = await getKv();
    await k.set(["processed_updates", 779], { state: "processing", at: Date.now() - 10 * 60_000 });
    let took = 0;
    await idempotencyMiddleware({ update: { update_id: 779 } } as never, () => { took++; return Promise.resolve(); });
    assertEquals(took, 1);
  } finally {
    await kv.close();
  }
});

// ---------------------------------------------------------------------------
// Payments & entitlements
// ---------------------------------------------------------------------------
Deno.test("AUDIT PAYMENTS — Telegram's subscription_expiration_date is authoritative", async () => {
  const kv = await setupTestEnvironment();
  try {
    const userId = 8001;
    const first = Math.floor((Date.now() + 30 * DAY) / 1000);
    const second = first + 30 * 86400 + 3600; // Telegram's date is NOT exactly +30d
    await provider.handleSuccessfulPayment(payment(userId, "a1", { subscription_expiration_date: first }), userId);
    const r = await provider.handleSuccessfulPayment(payment(userId, "a2", { subscription_expiration_date: second }), userId);
    assertEquals(r.entitlement!.expiresAt, new Date(second * 1000).toISOString());
    assertEquals((await getUserEntitlements(userId)).length, 1);
  } finally {
    await kv.close();
  }
});

Deno.test("AUDIT PAYMENTS — implausible Telegram expiry is ignored (with audit), lapsed one grants nothing", async () => {
  const kv = await setupTestEnvironment();
  try {
    const crazy = await provider.handleSuccessfulPayment(
      payment(8002, "b1", { subscription_expiration_date: Math.floor((Date.now() + 5000 * DAY) / 1000) }), 8002);
    const days = Math.round((new Date(crazy.entitlement!.expiresAt).getTime() - Date.now()) / DAY);
    assertEquals(days, 30, "falls back to one period");
    const { listAuditEvents } = await import("../src/db/audit.ts");
    assert((await listAuditEvents(50)).some((e) => e.type === "payment_anomaly"));

    // A late-delivered charge whose paid period already ended grants nothing but is closed out
    const late = await provider.handleSuccessfulPayment(
      payment(8003, "b2", { subscription_expiration_date: Math.floor((Date.now() - DAY) / 1000) }), 8003);
    assertEquals(late.success, false);
    assertEquals((await getMembershipSummary(8003)).isMember, false);
    assertEquals((await listPaymentsPendingFulfillment()).length, 0);
  } finally {
    await kv.close();
  }
});

Deno.test("AUDIT PAYMENTS — a price change never strands a genuine renewal; a mismatched amount is still rejected", async () => {
  const kv = await setupTestEnvironment();
  try {
    const userId = 8004;
    // Subscriber took the plan when it cost 500 Stars
    const { setConfigForTesting } = await import("../src/config.ts");
    setConfigForTesting({ ...MOCK_CONFIG, STARS_PRICE_AMOUNT: 500 });
    const oldPayload = TelegramStarsProvider.buildInvoicePayload(userId);
    // Price is raised to 750; the next renewal still arrives as 500
    setConfigForTesting({ ...MOCK_CONFIG, STARS_PRICE_AMOUNT: 750 });
    const renewal = await provider.handleSuccessfulPayment(
      { ...payment(userId, "c1", { total_amount: 500, invoice_payload: oldPayload }) }, userId);
    assertEquals(renewal.success, true);
    // but a payment whose amount does not match its own invoice is refused
    const tampered = await provider.handleSuccessfulPayment(
      { ...payment(userId, "c2", { total_amount: 1, invoice_payload: oldPayload }) }, userId);
    assertEquals(tampered.success, false);
    // and a stale 500-Star invoice cannot be used to start a NEW subscription at the old price
    const pre = await TelegramStarsProvider.validatePreCheckout({
      id: "q", from: { id: userId, first_name: "x" }, currency: "XTR", total_amount: 500, invoice_payload: oldPayload });
    assertEquals(pre.ok, false);
  } finally {
    await kv.close();
  }
});

Deno.test("AUDIT PAYMENTS — concurrent charges for one member converge on a single entitlement", async () => {
  const kv = await setupTestEnvironment();
  try {
    const userId = 8005;
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        applyPaidPeriod({ userId, chargeId: `par_${i}`, periodSeconds: 2592000, spaces: [...SPACE_IDS] })));
    assertEquals(results.filter((r) => r.created).length, 1, "exactly one entitlement created");
    const ents = await getUserEntitlements(userId);
    assertEquals(ents.length, 1);
    // each charge extended it by exactly one period: 12 periods in total
    const periods = Math.round((new Date(ents[0].expiresAt).getTime() - Date.now()) / (30 * DAY));
    assertEquals(periods, 12);
    // replays of every charge add nothing
    await Promise.all(Array.from({ length: 12 }, (_, i) =>
      applyPaidPeriod({ userId, chargeId: `par_${i}`, periodSeconds: 2592000, spaces: [...SPACE_IDS] })));
    assertEquals(Math.round((new Date((await getUserEntitlements(userId))[0].expiresAt).getTime() - Date.now()) / (30 * DAY)), 12);
  } finally {
    await kv.close();
  }
});

Deno.test("AUDIT ENTITLEMENTS — reading never writes; the expiry sweep cannot clobber a renewal", async () => {
  const kv = await setupTestEnvironment();
  try {
    const userId = 8006;
    const ent = await createEntitlement({
      userId, source: "telegram_stars", spaces: [...SPACE_IDS], startsAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() - 1000).toISOString(), status: "active",
    });
    // A read of a lapsed entitlement must not mutate it (this used to race with renewals)
    assertEquals((await getActiveUserEntitlements(userId)).length, 0);
    assertEquals((await getEntitlement(ent.id))!.status, "active");

    // Renewal lands between the sweep's read and its write -> sweep must back off
    const sweep = mutateEntitlement(ent.id, (cur) => {
      return cur.status === "active" && new Date(cur.expiresAt).getTime() <= Date.now() ? { ...cur, status: "expired" } : null;
    });
    await extendEntitlement(ent.id, 30 * 86400); // what a renewal does: later expiry AND status "active"
    await sweep;
    assertEquals((await getEntitlement(ent.id))!.status, "active");
    assertEquals((await getActiveUserEntitlements(userId)).length, 1);

    // The real sweep expires only what is actually lapsed
    await mutateEntitlement(ent.id, (cur) => ({ ...cur, expiresAt: new Date(Date.now() - 5).toISOString() }));
    assertEquals(await expireStaleEntitlements(), 1);
    assertEquals((await getEntitlement(ent.id))!.status, "expired");
  } finally {
    await kv.close();
  }
});

Deno.test("AUDIT PAYMENTS — refund revokes only the period it paid for", async () => {
  const kv = await setupTestEnvironment();
  try {
    const userId = 8007;
    const e1 = Math.floor((Date.now() + 30 * DAY) / 1000);
    await provider.handleSuccessfulPayment(payment(userId, "r1", { subscription_expiration_date: e1 }), userId);
    await provider.handleSuccessfulPayment(payment(userId, "r2", { subscription_expiration_date: e1 + 30 * 86400 }), userId);

    // Refunding the OLD charge leaves the current paid period (funded by r2) alone
    assertEquals(await TelegramStarsProvider.handleRefund(userId, "r1"), true);
    assertEquals((await getMembershipSummary(userId)).hasPaid, true);
    // Refunding the charge that funds the current period ends access
    assertEquals(await TelegramStarsProvider.handleRefund(userId, "r2"), true);
    assertEquals((await getMembershipSummary(userId)).hasPaid, false);
    // wrong member / unknown charge are refused
    assertEquals(await TelegramStarsProvider.handleRefund(999, "r2"), false);
    assertEquals(await TelegramStarsProvider.handleRefund(userId, "nope"), false);
    // a refunded charge can never be re-credited
    const again = await TelegramStarsProvider.fulfillPayment((await getPaymentByChargeId("r2"))!);
    assertEquals(again.success, false);
  } finally {
    await kv.close();
  }
});

Deno.test("AUDIT PAYMENTS — unfulfilled payment is listed until credited", async () => {
  const kv = await setupTestEnvironment();
  try {
    const userId = 8008;
    const rec = await recordPayment({
      userId, provider: "telegram_stars", chargeId: "pf1", providerChargeId: "p", amount: 750, currency: "XTR",
      invoicePayload: TelegramStarsProvider.buildInvoicePayload(userId), subscriptionPeriodSeconds: 2592000,
      isRecurring: true, status: "completed",
    });
    assertEquals((await listPaymentsPendingFulfillment()).map((p) => p.chargeId), ["pf1"]);
    const rec2 = await TelegramStarsProvider.recoverUnfulfilledPayments();
    assertEquals(rec2, { recovered: 1, failed: 0 });
    assertEquals((await listPaymentsPendingFulfillment()).length, 0);
    assertEquals((await getUserPayments(userId)).length, 1);
    assertNotEquals(rec.payment, undefined);
  } finally {
    await kv.close();
  }
});

// ---------------------------------------------------------------------------
// Complimentary access
// ---------------------------------------------------------------------------
Deno.test("AUDIT COMPLIMENTARY — admin tools cannot touch paid entitlements or revive revoked ones", async () => {
  const kv = await setupTestEnvironment();
  try {
    const userId = 8101;
    const paid = (await provider.handleSuccessfulPayment(payment(userId, "k1"), userId)).entitlement!;
    assertEquals((await revokeComplimentaryAccess(111111, paid.id)).success, false);
    assertEquals((await extendComplimentaryAccess(111111, paid.id, 5)).success, false);
    assertEquals((await getEntitlement(paid.id))!.status, "active");

    const comp = (await grantComplimentaryAccess({ adminId: 111111, userId, durationDays: 30, reason: "promotion", level: "full" })).entitlement!;
    assertEquals((await revokeComplimentaryAccess(111111, comp.id)).success, true);
    assertEquals((await extendComplimentaryAccess(111111, comp.id, 5)).success, false, "revoked stays revoked");
    assertEquals((await getEntitlement(comp.id))!.status, "revoked");
    // default grant is 30 days
    const g = await grantComplimentaryAccess({ adminId: 111111, userId: 8102, durationDays: 30, reason: "promotion", level: "vip_only" });
    assertEquals(Math.round((new Date(g.entitlement!.expiresAt).getTime() - Date.now()) / DAY), 30);
  } finally {
    await kv.close();
  }
});

// ---------------------------------------------------------------------------
// Access removal safety
// ---------------------------------------------------------------------------
Deno.test("AUDIT ACCESS — removal aborts if the member became eligible during the Telegram round trip", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockTelegramApi();
    const res = await removeMemberFromSpace(api, "vip_collections", 8201, { stillIneligible: () => Promise.resolve(false) });
    assertEquals(res.success, true);
    assertEquals(api.bannedMembers.length, 0);
    // and a retry after a half-finished removal lifts our own leftover ban
    api.mockMemberStatus.set(`${MOCK_CONFIG.VIP_COLLECTIONS_CHAT_ID}:8202`, { status: "kicked" });
    await removeMemberFromSpace(api, "vip_collections", 8202, { isRetry: true });
    assertEquals(api.unbannedMembers.length, 1);
    // administrators/creators are never removed
    api.mockMemberStatus.set(`${MOCK_CONFIG.VIP_COLLECTIONS_CHAT_ID}:8203`, { status: "administrator" });
    const adminRes = await removeMemberFromSpace(api, "vip_collections", 8203);
    assertEquals(adminRes.skippedProtected, true);
    assertEquals(api.bannedMembers.length, 0);
  } finally {
    await kv.close();
  }
});

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------
Deno.test("AUDIT OPS — admin alerts are delivered once per cool-down window", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockTelegramApi();
    assertEquals(await notifyAdmins(api, "k", "first"), true);
    assertEquals(await notifyAdmins(api, "k", "second"), false);
    assertEquals(await notifyAdmins(api, "other", "third"), true);
    assertEquals(api.sentMessages.filter((m) => m.chatId === MOCK_CONFIG.ADMIN_USER_IDS[0]).length, 2);
  } finally {
    await kv.close();
  }
});

Deno.test("AUDIT TIME — America/Toronto boundaries and DST", async () => {
  // 03:00 UTC on 1 Nov 2026 is still 31 Oct 23:00 in Toronto (EDT): last day of the month
  assertEquals(torontoMonthCycle(new Date("2026-11-01T03:00:00Z")), "2026-10");
  assertEquals(torontoDateKey(new Date("2026-11-01T03:00:00Z")), "2026-10-31");
  // after DST ends (EST, UTC-5) 05:00Z is 00:00 local on 1 Nov... 
  assertEquals(torontoMonthCycle(new Date("2026-11-01T06:00:00Z")), "2026-11");
  // summer (EDT): 07:00Z == 03:00 local; winter (EST): 08:00Z == 03:00 local
  assertEquals(torontoParts(new Date("2026-07-15T07:00:00Z")).hour, 3);
  assertEquals(torontoParts(new Date("2026-07-15T06:59:00Z")).hour, 2);
  assertEquals(torontoParts(new Date("2026-01-15T08:00:00Z")).hour, 3);
  assertEquals(torontoParts(new Date("2026-01-15T07:59:00Z")).hour, 2);

  const kv = await setupTestEnvironment();
  try {
    assertEquals(await isDailySyncDue(new Date("2026-07-15T06:59:00Z")), false);
    assertEquals(await isDailySyncDue(new Date("2026-07-15T07:00:00Z")), true);
    assertEquals(await isDailySyncDue(new Date("2026-01-15T07:59:00Z")), false);
    assertEquals(await isDailySyncDue(new Date("2026-01-15T08:00:00Z")), true);
    // a missed 03:00 run is caught up later the same local day
    assertEquals(await isDailySyncDue(new Date("2026-01-15T20:00:00Z")), true);
  } finally {
    await kv.close();
  }
});
