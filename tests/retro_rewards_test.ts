import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { MOCK_CONFIG, setupTestEnvironment } from "./test_helpers.ts";
import { callback, createFakeTelegram, chatJoinRequest } from "./bot_harness.ts";
import { createEntitlement, getEntitlement, getMembershipSummary, hasAccessToSpace } from "../src/db/entitlements.ts";
import { logAuditEvent } from "../src/db/audit.ts";
import { repairLegacyFullContentRewards } from "../src/complimentary/service.ts";
import { loadConfig, setConfigForTesting } from "../src/config.ts";
import { TelegramStarsProvider } from "../src/payments/stars.ts";
import { getPlan } from "../src/plans/plans.ts";
import { REGULAR_SPACE_IDS } from "../src/types.ts";

Deno.test("RETRO REWARD — full access selected in the admin UI grants Retro and permits joining", async () => {
  const kv = await setupTestEnvironment();
  try {
    const tg = await createFakeTelegram();
    const admin = MOCK_CONFIG.ADMIN_USER_IDS[0];
    const member = 1234567890;
    await tg.send(callback(admin, `admin:grant_rsn:${member}:30:content_contribution`));
    const screen = tg.callsOf("editMessageText").at(-1)!.payload;
    const buttons = (screen.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard.flat();
    const full = buttons.find((b) => b.text.startsWith("Accès complet"))!;
    assertStringIncludes(full.text, "Retro");
    await tg.send(callback(admin, full.callback_data));
    const confirm = tg.callsOf("editMessageText").at(-1)!.payload;
    assertStringIncludes(String(confirm.text), "Accès complet — en activité + Retro + communauté");
    assert(!String(confirm.text).includes("content_contribution"));
    const confirmation = (confirm.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard[0][0].callback_data;
    assert(new TextEncoder().encode(confirmation).length <= 64);
    await tg.send(callback(admin, confirmation));
    assertEquals(await hasAccessToSpace(member, "retro_collections"), true);
    assertEquals((await getMembershipSummary(member)).accessibleSpaces.length, 4);
    await tg.send(chatJoinRequest(MOCK_CONFIG.TELEGRAM_RETRO_FORUM_CHAT_ID, member));
    assertEquals(tg.callsOf("approveChatJoinRequest").at(-1)!.payload.chat_id, MOCK_CONFIG.TELEGRAM_RETRO_FORUM_CHAT_ID);
    await tg.send(callback(admin, `admin:grant_spc:${member}:30:content_contribution:full_retro`));
    assert(!String(tg.callsOf("editMessageText").at(-1)!.payload.text).includes("full_retro"));
  } finally { await kv.close(); }
});

Deno.test("RETRO REPAIR — only audited active full content rewards gain Retro, with expiry preserved", async () => {
  const kv = await setupTestEnvironment();
  try {
    const records = [];
    for (const [i, test] of [
      { reason: "content_contribution", level: "full", status: "active", expired: false, audited: true },
      { reason: "content_contribution", level: "vip_only", status: "active", expired: false, audited: true },
      { reason: "partnership", level: "full", status: "active", expired: false, audited: true },
      { reason: "content_contribution", level: "full", status: "revoked", expired: false, audited: true },
      { reason: "content_contribution", level: "full", status: "active", expired: true, audited: true },
      { reason: "content_contribution", level: "full", status: "active", expired: false, audited: false },
    ].entries()) {
      const ent = await createEntitlement({ userId: 7000 + i, source: "complimentary", spaces: [...REGULAR_SPACE_IDS],
        status: test.status as "active" | "revoked", startsAt: new Date(Date.now() - 86400000).toISOString(),
        expiresAt: new Date(Date.now() + (test.expired ? -1000 : 86400000)).toISOString(), metadata: { reason: test.reason } });
      records.push(ent);
      if (test.audited) await logAuditEvent("entitlement_granted", { entitlementId: ent.id, reason: test.reason, level: test.level }, 111111, ent.userId);
    }
    const repaired = await Promise.all([repairLegacyFullContentRewards(), repairLegacyFullContentRewards()]);
    assertEquals(repaired.reduce((a, b) => a + b, 0), 1);
    for (const [i, original] of records.entries()) {
      const ent = (await getEntitlement(original.id))!;
      assertEquals(ent.spaces.includes("retro_collections"), i === 0);
      assertEquals(ent.expiresAt, original.expiresAt);
      assertEquals(ent.status, original.status);
    }
    assertEquals(await repairLegacyFullContentRewards(), 0);
  } finally { await kv.close(); }
});

Deno.test("RETRO PRICE — default and blank config produce a 1200-Star recurring invoice and matching checkout", async () => {
  const kv = await setupTestEnvironment();
  try {
    assertEquals(loadConfig().RETRO_PLUS_STARS_PRICE_AMOUNT, 1200);
    const config = loadConfig({ RETRO_PLUS_STARS_PRICE_AMOUNT: "" });
    assertEquals(config.RETRO_PLUS_STARS_PRICE_AMOUNT, 1200);
    setConfigForTesting({ ...MOCK_CONFIG, RETRO_PLUS_STARS_PRICE_AMOUNT: config.RETRO_PLUS_STARS_PRICE_AMOUNT });
    const tg = await createFakeTelegram();
    const member = 432109876;
    await tg.send(callback(member, "member:pay:retro_plus"));
    const invoice = tg.callsOf("createInvoiceLink").at(-1)!.payload;
    assertEquals(invoice.prices, [{ label: "LA CONFRÉRIE Retro Plus (30 jours)", amount: 1200 }]);
    assertEquals(invoice.subscription_period, 2592000);
    const payload = String(invoice.payload);
    for (const amount of [1200, 1500]) {
      const result = await TelegramStarsProvider.validatePreCheckout({ id: `q${amount}`, from: { id: member, first_name: "Test" },
        currency: "XTR", total_amount: amount, invoice_payload: payload });
      assertEquals(result.ok, amount === 1200);
    }
    assertEquals(getPlan("regular").priceStars, 750);
  } finally { await kv.close(); }
});
