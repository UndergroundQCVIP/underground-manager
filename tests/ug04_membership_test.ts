/**
 * LA CONFRÉRIE — UG-04 Pre-Publish Test Suite: MEMBERSHIP TIERS, PLAN CHANGES & REBRANDING
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { MOCK_CONFIG, setupTestEnvironment } from "./test_helpers.ts";
import { MockMigrationApi, pay, RETRO_CHAT, REGULAR_CHAT } from "./ug04_helpers.ts";
import { setConfigForTesting, loadConfig, validateConfig, getChatIdForSpace } from "../src/config.ts";
import { TelegramStarsProvider } from "../src/payments/stars.ts";
import {
  createEntitlement,
  getActiveUserEntitlements,
  getMembershipSummary,
  hasAccessToSpace,
  updateEntitlementStatus,
  countActivePaidSubscribers,
} from "../src/db/entitlements.ts";
import { processChatJoinRequest } from "../src/access/join_requests.ts";
import { reconcileAllMembers } from "../src/access/sync.ts";
import { recordSyncState } from "../src/db/sync.ts";
import { getKv } from "../src/db/kv.ts";
import { grantComplimentaryAccess } from "../src/complimentary/service.ts";
import { getOrCreateJoinLink } from "../src/access/links.ts";
import { getPlan } from "../src/plans/plans.ts";
import {
  applyPlanChangeAfterPayment,
  confirmDowngrade,
  confirmUpgradeIntent,
} from "../src/plans/changes.ts";
import { messages } from "../src/bot/messages.ts";
import { adminMenuKeyboard, mainMenuKeyboard } from "../src/bot/keyboards.ts";
import { computeTierRevenue } from "../src/treasury/tiers.ts";
import { generateMonthlyTreasuryReport, formatPrivateMemberReport } from "../src/treasury/reports.ts";

function menuLabels(kb: { inline_keyboard: { text: string }[][] }): string[] {
  return kb.inline_keyboard.flat().map((b) => b.text);
}

Deno.test("UG04 BRAND — Club name is configurable and French spelling is exact", async () => {
  const kv = await setupTestEnvironment();
  try {
    assertEquals(loadConfig({ BOT_TOKEN: "x" }).CLUB_DISPLAY_NAME, "LA CONFRÉRIE");
    assertEquals(loadConfig({ CLUB_DISPLAY_NAME: "CUSTOM CLUB" }).CLUB_DISPLAY_NAME, "CUSTOM CLUB");
    setConfigForTesting({ ...MOCK_CONFIG });

    const welcome = messages.welcome("Sam", false);
    assertStringIncludes(welcome, "LA CONFRÉRIE");
    assert(!/underground/i.test(welcome));
    assert(!/underground/i.test(messages.plansOverview()));
    // (the support @handle is a live identifier and intentionally not rebranded)
    assert(!/underground/i.test(messages.paySupport().replace(MOCK_CONFIG.SUPPORT_USERNAME, "")));
    assertStringIncludes(messages.adminMenu(), "LA CONFRÉRIE | ADMIN");
    assertStringIncludes(messages.paymentSuccess(new Date().toISOString(), "retro_plus"), "RETRO | LA CONFRÉRIE");
  } finally {
    await kv.close();
  }
});

Deno.test("UG04 BRAND — Member and admin menus match the contract", async () => {
  const kv = await setupTestEnvironment();
  try {
    const member = menuLabels(mainMenuKeyboard(true, false, "regular")).join("|");
    for (const label of ["Mon abonnement", "Forfaits d'adhésion", "Répertoire des créateurs", "Liste de souhaits", "Clavardage général", "Aide et soutien", "Contribuer"]) {
      assertStringIncludes(member, label);
    }
    // Regular members see the upgrade option; Retro Plus members do not.
    assertStringIncludes(member, "Passer à Retro Plus");
    assert(!menuLabels(mainMenuKeyboard(true, false, "retro_plus")).join("|").includes("Passer à Retro Plus"));

    const admin = menuLabels(adminMenuKeyboard()).join("|");
    for (const label of ["Membres", "Forfaits", "Créateurs", "Passer à Retro", "État des migrations", "Répertoire", "Trésorerie", "Paramètres", "Contributions"]) {
      assertStringIncludes(admin, label);
    }
  } finally {
    await kv.close();
  }
});

Deno.test("UG04 CONFIG — Retro forum ID is wired as a managed space; Retro Plus billing is disabled without a price", async () => {
  const kv = await setupTestEnvironment();
  try {
    assertEquals(getChatIdForSpace("retro_collections"), RETRO_CHAT);
    assertEquals(getChatIdForSpace("vip_collections"), REGULAR_CHAT); // Regular ID preserved

    const env = loadConfig({ TELEGRAM_RETRO_FORUM_CHAT_ID: "-1003975562920" });
    assertEquals(env.TELEGRAM_RETRO_FORUM_CHAT_ID, -1003975562920);
    assertEquals(env.RETRO_PLUS_STARS_PRICE_AMOUNT, 0); // never invented
    assertEquals(validateConfig({ ...MOCK_CONFIG, TELEGRAM_RETRO_FORUM_CHAT_ID: REGULAR_CHAT }).length > 0, true);

    setConfigForTesting({ ...MOCK_CONFIG, RETRO_PLUS_STARS_PRICE_AMOUNT: 0 });
    assertEquals(getPlan("retro_plus").enabled, false);
    const pre = await TelegramStarsProvider.validatePreCheckout({
      id: "q1",
      from: { id: 1, first_name: "A" },
      currency: "XTR",
      total_amount: 1500,
      invoice_payload: TelegramStarsProvider.buildInvoicePayload(1, "retro_plus"),
    });
    assertEquals(pre.ok, false);
  } finally {
    await kv.close();
  }
});

Deno.test("UG04 TIERS — Regular user gets Regular access only; Retro Plus gets both forums", async () => {
  const kv = await setupTestEnvironment();
  try {
    const r = await pay(7001, "regular", "ch_reg_1");
    assertEquals(r.success, true);
    assertEquals(r.entitlement?.plan, "regular");
    assertEquals(await hasAccessToSpace(7001, "vip_collections"), true);
    assertEquals(await hasAccessToSpace(7001, "retro_collections"), false);
    assertEquals((await getMembershipSummary(7001)).plan, "regular");

    const p = await pay(7002, "retro_plus", "ch_retro_1");
    assertEquals(p.success, true);
    assertEquals(p.entitlement?.plan, "retro_plus");
    assertEquals(await hasAccessToSpace(7002, "vip_collections"), true);
    assertEquals(await hasAccessToSpace(7002, "retro_collections"), true);
    assertEquals(await hasAccessToSpace(7002, "wanted_list"), true);
    assertEquals(await hasAccessToSpace(7002, "general_chat"), true);
    const s = await getMembershipSummary(7002);
    assertEquals(s.plan, "retro_plus");
    assertEquals(s.hasRetroAccess, true);

    // Identical voting/nomination rights: both tiers are "paid".
    assertEquals((await getMembershipSummary(7001)).hasPaid, true);
    assertEquals(s.hasPaid, true);
    assertEquals(await countActivePaidSubscribers(), 2);
  } finally {
    await kv.close();
  }
});

Deno.test("UG04 TIERS — Purchased plan is recorded on the payment; pre-checkout validates each plan's own price", async () => {
  const kv = await setupTestEnvironment();
  try {
    await pay(7003, "retro_plus", "ch_rec_1");
    const { getPaymentByChargeId } = await import("../src/db/payments.ts");
    assertEquals((await getPaymentByChargeId("ch_rec_1"))?.planId, "retro_plus");

    const wrongPrice = await TelegramStarsProvider.validatePreCheckout({
      id: "q",
      from: { id: 7004, first_name: "A" },
      currency: "XTR",
      total_amount: 750, // Regular price on a Retro Plus invoice
      invoice_payload: TelegramStarsProvider.buildInvoicePayload(7004, "retro_plus"),
    });
    assertEquals(wrongPrice.ok, false);

    const rightPrice = await TelegramStarsProvider.validatePreCheckout({
      id: "q",
      from: { id: 7004, first_name: "A" },
      currency: "XTR",
      total_amount: 1500,
      invoice_payload: TelegramStarsProvider.buildInvoicePayload(7004, "retro_plus"),
    });
    assertEquals(rightPrice.ok, true);

    // Tampered amount in the final payment is rejected as well
    const provider = new TelegramStarsProvider();
    const bad = await provider.handleSuccessfulPayment(
      {
        currency: "XTR",
        total_amount: 750,
        invoice_payload: TelegramStarsProvider.buildInvoicePayload(7004, "retro_plus"),
        telegram_payment_charge_id: "ch_bad",
        provider_payment_charge_id: "p",
      },
      7004
    );
    assertEquals(bad.success, false);
    assertEquals(await hasAccessToSpace(7004, "retro_collections"), false);
  } finally {
    await kv.close();
  }
});

Deno.test("UG04 ACCESS — Regular member cannot enter Retro with an old invite link; Retro Plus can", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockMigrationApi();
    await pay(7010, "regular", "ch_acc_r");
    await pay(7011, "retro_plus", "ch_acc_p");

    // Invite links are always approval-gated (never reusable open links)
    await getOrCreateJoinLink(api, "retro_collections");
    assertEquals(api.createdInviteLinks.length, 1);
    assertEquals((api.createdInviteLinks[0].options as { creates_join_request?: boolean }).creates_join_request, true);
    assertEquals(api.createdInviteLinks[0].chatId, RETRO_CHAT);

    const denied = await processChatJoinRequest(api, {
      chat: { id: RETRO_CHAT },
      from: { id: 7010, first_name: "Reg" },
    });
    assertEquals(denied.approved, false);
    assertEquals(denied.spaceId, "retro_collections");
    assertEquals(api.declinedJoinRequests.length, 1);

    const ok = await processChatJoinRequest(api, {
      chat: { id: RETRO_CHAT },
      from: { id: 7011, first_name: "Pro" },
    });
    assertEquals(ok.approved, true);

    // Regular vault still works for the Regular member
    const reg = await processChatJoinRequest(api, { chat: { id: REGULAR_CHAT }, from: { id: 7010, first_name: "Reg" } });
    assertEquals(reg.approved, true);
  } finally {
    await kv.close();
  }
});

Deno.test("UG04 UPGRADE — Retro access requires verified payment; Regular renewal is cancelled only after payment AND only when authorized", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockMigrationApi();
    const user = 7020;
    await pay(user, "regular", "ch_up_reg", { expiresInDays: 20 });

    // Confirmed intent alone grants nothing and cancels nothing
    const q = await confirmUpgradeIntent(user, true);
    assertEquals(q.ok, true);
    assertEquals(q.newPriceStars, 1500);
    assert(q.currentPaidThrough !== undefined);
    assertEquals(await hasAccessToSpace(user, "retro_collections"), false);
    assertEquals(api.starSubscriptionEdits.length, 0);

    // A Regular renewal must not trigger the cancellation either
    assertEquals(await applyPlanChangeAfterPayment(api, user, "regular"), null);
    assertEquals(api.starSubscriptionEdits.length, 0);

    // Verified Retro Plus payment -> access, then authorized cancellation of Regular
    const paid = await pay(user, "retro_plus", "ch_up_retro", { expiresInDays: 30 });
    assertEquals(paid.success, true);
    assertEquals(await hasAccessToSpace(user, "retro_collections"), true);
    const applied = await applyPlanChangeAfterPayment(api, user, "retro_plus");
    assertEquals(applied?.cancelOutcome, "cancelled");
    assertEquals(api.starSubscriptionEdits, [{ userId: user, chargeId: "ch_up_reg", canceled: true }]);

    // Already-paid Regular access is preserved (not revoked)
    const ents = await getActiveUserEntitlements(user);
    assertEquals(ents.filter((e) => e.plan === "regular").length, 1);
    assertEquals(ents.filter((e) => e.plan === "retro_plus").length, 1);

    // Idempotent: applying again does nothing
    assertEquals(await applyPlanChangeAfterPayment(api, user, "retro_plus"), null);
    assertEquals(api.starSubscriptionEdits.length, 1);
  } finally {
    await kv.close();
  }
});

Deno.test("UG04 UPGRADE — Without user authorization nothing is cancelled", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockMigrationApi();
    const user = 7021;
    await pay(user, "regular", "ch_noauth_reg", { expiresInDays: 20 });
    await confirmUpgradeIntent(user, false); // "keep Regular renewing"
    await pay(user, "retro_plus", "ch_noauth_retro", { expiresInDays: 30 });
    const applied = await applyPlanChangeAfterPayment(api, user, "retro_plus");
    assertEquals(applied?.cancelOutcome, "not_needed");
    assertEquals(api.starSubscriptionEdits.length, 0);
  } finally {
    await kv.close();
  }
});

Deno.test("UG04 BILLING — Renewals extend only their own plan (no unintended double renewal)", async () => {
  const kv = await setupTestEnvironment();
  try {
    const user = 7030;
    await pay(user, "regular", "ch_dbl_r1", { expiresInDays: 10 });
    await pay(user, "retro_plus", "ch_dbl_p1", { expiresInDays: 30 });
    const before = await getActiveUserEntitlements(user);
    const regBefore = before.find((e) => e.plan === "regular")!;
    const retroBefore = before.find((e) => e.plan === "retro_plus")!;

    // Regular renews
    await pay(user, "regular", "ch_dbl_r2");
    const after = await getActiveUserEntitlements(user);
    assertEquals(after.length, 2); // still exactly one entitlement per plan
    const regAfter = after.find((e) => e.plan === "regular")!;
    const retroAfter = after.find((e) => e.plan === "retro_plus")!;
    assert(new Date(regAfter.expiresAt).getTime() > new Date(regBefore.expiresAt).getTime());
    assertEquals(retroAfter.expiresAt, retroBefore.expiresAt); // untouched

    // Duplicate webhook for the same charge never double-credits
    const dup = await pay(user, "regular", "ch_dbl_r2");
    assertEquals(dup.isDuplicate, true);

    // Buying Regular while holding Retro Plus is blocked to avoid overlapping charges
    const pre = await TelegramStarsProvider.validatePreCheckout({
      id: "q",
      from: { id: user, first_name: "A" },
      currency: "XTR",
      total_amount: 750,
      invoice_payload: TelegramStarsProvider.buildInvoicePayload(user, "regular"),
    });
    assertEquals(pre.ok, false);
  } finally {
    await kv.close();
  }
});

Deno.test("UG04 DOWNGRADE — Renewal stops but paid Retro access is preserved; expiry removes ONLY Retro", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockMigrationApi();
    const user = 7040;
    await pay(user, "regular", "ch_dn_reg", { expiresInDays: 25 });
    await pay(user, "retro_plus", "ch_dn_retro", { expiresInDays: 10 });

    const res = await confirmDowngrade(api, user);
    assertEquals(res.cancelled, true);
    assertEquals(api.starSubscriptionEdits.at(-1)?.chargeId, "ch_dn_retro");
    // Access already paid for is untouched
    assertEquals(await hasAccessToSpace(user, "retro_collections"), true);

    // Mark the user as admitted to both forums, then let Retro expire
    for (const [spaceId, chatId] of [["vip_collections", REGULAR_CHAT], ["retro_collections", RETRO_CHAT]] as const) {
      await recordSyncState({ userId: user, spaceId, chatId, status: "admitted", lastSyncAt: new Date().toISOString() });
    }
    const retroEnt = (await getActiveUserEntitlements(user)).find((e) => e.plan === "retro_plus")!;
    const kvh = await getKv();
    const expired = { ...retroEnt, expiresAt: new Date(Date.now() - 1000).toISOString() };
    await kvh.set(["entitlements", retroEnt.id], expired);
    await kvh.set(["entitlements_by_user", user, retroEnt.id], expired);

    const result = await reconcileAllMembers(api);
    assertEquals(result.errors, []);
    assertEquals(api.bannedMembers.map((b) => b.chatId), [RETRO_CHAT]); // only Retro is removed
    assertEquals(await hasAccessToSpace(user, "retro_collections"), false);
    assertEquals(await hasAccessToSpace(user, "vip_collections"), true); // Regular continues
  } finally {
    await kv.close();
  }
});

Deno.test("UG04 DOWNGRADE — Nothing is cancelled for a user without Retro Plus", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockMigrationApi();
    await pay(7041, "regular", "ch_dn2");
    const res = await confirmDowngrade(api, 7041);
    assertEquals(res.ok, false);
    assertEquals(api.starSubscriptionEdits.length, 0);
  } finally {
    await kv.close();
  }
});

Deno.test("UG04 COMPLIMENTARY — Existing levels unchanged; legacy and Retro-inclusive grants work", async () => {
  const kv = await setupTestEnvironment();
  try {
    const full = await grantComplimentaryAccess({ adminId: 111111, userId: 7050, durationDays: 30, reason: "partnership", level: "full" });
    assertEquals(full.entitlement?.spaces.length, 3);
    assertEquals(await hasAccessToSpace(7050, "retro_collections"), false);

    const retro = await grantComplimentaryAccess({ adminId: 111111, userId: 7051, durationDays: 30, reason: "partnership", level: "full_retro" });
    assertEquals(retro.entitlement?.spaces.length, 4);
    assertEquals(await hasAccessToSpace(7051, "retro_collections"), true);

    // Complimentary members are not subscription revenue
    const t = await computeTierRevenue();
    assertEquals(t.regular.lifetimeStars + t.retro_plus.lifetimeStars, 0);
  } finally {
    await kv.close();
  }
});

Deno.test("UG04 LEGACY — Pre-UG-04 Regular subscriptions (no plan field) remain valid and renew correctly", async () => {
  const kv = await setupTestEnvironment();
  try {
    const now = Date.now();
    await createEntitlement({
      userId: 7060,
      source: "telegram_stars",
      spaces: ["vip_collections", "wanted_list", "general_chat"], // exactly what UG-01 stored
      startsAt: new Date(now - 86400000).toISOString(),
      expiresAt: new Date(now + 10 * 86400000).toISOString(),
      status: "active",
    });
    assertEquals(await hasAccessToSpace(7060, "vip_collections"), true);
    assertEquals(await hasAccessToSpace(7060, "retro_collections"), false);
    assertEquals((await getMembershipSummary(7060)).plan, "regular");

    // A renewal extends the legacy entitlement instead of creating a second one
    await pay(7060, "regular", "ch_legacy_renew");
    assertEquals((await getActiveUserEntitlements(7060)).length, 1);

    // Legacy payload id "vip_monthly" is still accepted
    const parsed = TelegramStarsProvider.parseInvoicePayload(
      JSON.stringify({ type: "subscription", userId: 1, planId: "vip_monthly", periodSeconds: 2592000, timestamp: 1 })
    );
    assert(parsed !== null);
  } finally {
    await kv.close();
  }
});

Deno.test("UG04 TREASURY — Revenue is attributed per tier once; upgrades never duplicate revenue; refunds excluded", async () => {
  const kv = await setupTestEnvironment();
  try {
    await pay(7070, "regular", "ch_t_r1");
    await pay(7070, "retro_plus", "ch_t_p1"); // upgrade: a NEW charge, not a re-count of Regular
    await pay(7071, "retro_plus", "ch_t_p2");
    await pay(7071, "retro_plus", "ch_t_p2"); // duplicate webhook

    let t = await computeTierRevenue();
    assertEquals(t.regular.periodStars, 750);
    assertEquals(t.retro_plus.periodStars, 3000);
    // Overlapping user counted once, under the highest tier
    assertEquals(t.regular.activeSubscribers, 0);
    assertEquals(t.retro_plus.activeSubscribers, 2);

    await TelegramStarsProvider.handleRefund(7071, "ch_t_p2");
    t = await computeTierRevenue();
    assertEquals(t.retro_plus.periodStars, 1500);

    // Consolidated treasury total still equals the sum of tiers (one pool, one star ledger)
    const { getTreasuryOverview } = await import("../src/treasury/service.ts");
    const overview = await getTreasuryOverview();
    assertEquals(overview.totalStarsReceived >= 750 + 1500, true);

    const report = await generateMonthlyTreasuryReport();
    assertEquals(report.revenueByTier?.retro_plus.periodStars, 1500);
    assertStringIncludes(formatPrivateMemberReport(report), "Retro Plus");
    assertStringIncludes(formatPrivateMemberReport(report), "RAPPORT DE TRÉSORERIE LA CONFRÉRIE");
  } finally {
    await kv.close();
  }
});

Deno.test("UG04 ACCESS — Entitlement expiry handled lazily for the Retro tier", async () => {
  const kv = await setupTestEnvironment();
  try {
    const r = await pay(7080, "retro_plus", "ch_lazy");
    await updateEntitlementStatus(r.entitlement!.id, "expired");
    assertEquals(await hasAccessToSpace(7080, "retro_collections"), false);
  } finally {
    await kv.close();
  }
});
