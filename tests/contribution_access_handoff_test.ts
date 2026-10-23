import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { MOCK_CONFIG, setupTestEnvironment } from "./test_helpers.ts";
import { cb, makeBot } from "./ug05_harness.ts";
import { chatJoinRequest, createFakeTelegram, callback, successfulPayment } from "./bot_harness.ts";
import { seedCreator } from "./ug04_helpers.ts";
import { startContribution, addContributionItem, finishContribution } from "../src/contributions/service.ts";
import { getModeratorRewardDraft } from "../src/db/contributions.ts";
import { getMembershipSummary, getUserEntitlements } from "../src/db/entitlements.ts";
import { grantContributionReward } from "../src/contributions/rewards.ts";
import { saveInviteLink } from "../src/db/links.ts";
import { getSyncState } from "../src/db/sync.ts";
import { mainMenuKeyboard } from "../src/bot/keyboards.ts";
import { TelegramStarsProvider } from "../src/payments/stars.ts";

const ADMIN = MOCK_CONFIG.ADMIN_USER_IDS[0], MEMBER = 88007766;
const reward = (scopes: ("regular" | "retro")[] = ["regular", "retro"]) => grantContributionReward({
  contributionId: crypto.randomUUID(), userId: MEMBER, scopes, days: 30, adminId: ADMIN,
});

Deno.test("EARNED ACCESS — admin accepts content for both forums, receipt opens both links, and both joins are approved", async () => {
  const kv = await setupTestEnvironment();
  try {
    const { bot, calls } = makeBot();
    const creator = await seedCreator({ name: "Creator", topicId: 80 });
    const started = await startContribution(MEMBER, creator.id);
    assert(started.ok);
    await addContributionItem(MEMBER, { messageId: 11, kind: "photo" });
    const submitted = await finishContribution(bot.api, MEMBER);
    assert(submitted.ok);
    const id = submitted.contribution!.id;
    await bot.handleUpdate(cb(ADMIN, `cadm:rw:${id}`) as never);
    await bot.handleUpdate(cb(ADMIN, `cadm:sc:${id}:bo`) as never);
    const draft = await getModeratorRewardDraft(id, ADMIN);
    assert(draft);
    await bot.handleUpdate(cb(ADMIN, `cadm:cf:${id}:${draft.nonce}`) as never);
    const receipt = calls.find(c => c.method === "sendMessage" && c.payload.chat_id === MEMBER && String(c.payload.text).includes("Récompense :"));
    assert(receipt);
    assertStringIncludes(JSON.stringify(receipt.payload.reply_markup), "member:channels");
    const receiptButtons = (receipt.payload.reply_markup as { inline_keyboard: { url?: string }[][] }).inline_keyboard.flat();
    assertEquals(receiptButtons.filter(b => b.url).length, 4);
    assertEquals(calls.filter(c => c.method === "approveChatJoinRequest").length, 0);
    assertEquals((await getMembershipSummary(MEMBER)).hasPaid, false);
    assertEquals((await getMembershipSummary(MEMBER)).accessibleSpaces.length, 4);
    await bot.handleUpdate(cb(MEMBER, "member:channels") as never);
    const links = calls.filter(c => c.method === "createChatInviteLink");
    assert(links.some(c => c.payload.chat_id === MOCK_CONFIG.VIP_COLLECTIONS_CHAT_ID));
    assert(links.some(c => c.payload.chat_id === MOCK_CONFIG.TELEGRAM_RETRO_FORUM_CHAT_ID));
    for (const chatId of [MOCK_CONFIG.VIP_COLLECTIONS_CHAT_ID, MOCK_CONFIG.TELEGRAM_RETRO_FORUM_CHAT_ID]) {
      await bot.handleUpdate({ update_id: chatId === MOCK_CONFIG.VIP_COLLECTIONS_CHAT_ID ? 88001 : 88002, ...chatJoinRequest(chatId, MEMBER) } as never);
    }
    assertEquals(calls.filter(c => c.method === "approveChatJoinRequest").map(c => c.payload.chat_id), [MOCK_CONFIG.VIP_COLLECTIONS_CHAT_ID, MOCK_CONFIG.TELEGRAM_RETRO_FORUM_CHAT_ID]);
    assertEquals(calls.filter(c => c.method === "declineChatJoinRequest").length, 0);
    assertEquals((await getUserEntitlements(MEMBER)).length, 2);
  } finally { await kv.close(); }
});

Deno.test("DIRECT JOIN — an admin full grant immediately sends both forums and community links to the member", async () => {
  const kv = await setupTestEnvironment();
  try {
    const tg = await createFakeTelegram();
    await tg.send(callback(ADMIN, `admin:grant_cfm:${MEMBER}:30:admin_exception:full`));
    const receipt = tg.callsOf("sendMessage").find(c => c.payload.chat_id === MEMBER)!;
    const markup = JSON.stringify(receipt.payload.reply_markup);
    for (const chat of [MOCK_CONFIG.VIP_COLLECTIONS_CHAT_ID, MOCK_CONFIG.TELEGRAM_RETRO_FORUM_CHAT_ID, MOCK_CONFIG.WANTED_LIST_CHAT_ID, MOCK_CONFIG.GENERAL_CHAT_ID]) {
      assertStringIncludes(markup, `https://t.me/+invite_${chat}`);
    }
    assertStringIncludes(String(receipt.payload.text), "approuvée automatiquement");
    assertEquals(tg.callsOf("approveChatJoinRequest").length, 0);
    assert(tg.callsOf("createChatInviteLink").every(c => c.payload.creates_join_request === true));
    await tg.send(chatJoinRequest(MOCK_CONFIG.TELEGRAM_RETRO_FORUM_CHAT_ID, MEMBER));
    assertEquals(tg.callsOf("approveChatJoinRequest").length, 1);
  } finally { await kv.close(); }
});

for (const planId of ["regular", "retro_plus"] as const) {
  Deno.test(`DIRECT JOIN — ${planId} purchase receipt contains only authorized links; replay adds no time`, async () => {
    const kv = await setupTestEnvironment();
    try {
      const tg = await createFakeTelegram();
      const payment = () => successfulPayment(MEMBER, {
        chargeId: `direct_${planId}`, payload: TelegramStarsProvider.buildInvoicePayload(MEMBER, planId),
        amount: planId === "regular" ? MOCK_CONFIG.STARS_PRICE_AMOUNT : MOCK_CONFIG.RETRO_PLUS_STARS_PRICE_AMOUNT,
        expiresUnix: Math.floor(Date.now() / 1000) + 2592000, first: true,
      });
      await tg.send(payment());
      const receipt = tg.callsOf("sendMessage").find(c => String(c.payload.text).includes("PAIEMENT CONFIRMÉ"))!;
      assert(receipt);
      const markup = JSON.stringify(receipt.payload.reply_markup);
      assertStringIncludes(markup, `https://t.me/+invite_${MOCK_CONFIG.VIP_COLLECTIONS_CHAT_ID}`);
      assertEquals(markup.includes(`https://t.me/+invite_${MOCK_CONFIG.TELEGRAM_RETRO_FORUM_CHAT_ID}`), planId === "retro_plus");
      assertEquals(tg.callsOf("createChatInviteLink").length, planId === "regular" ? 3 : 4);
      assert(tg.callsOf("createChatInviteLink").every(c => c.payload.creates_join_request === true));
      assertEquals(tg.callsOf("approveChatJoinRequest").length, 0);
      const before = (await getUserEntitlements(MEMBER)).map(e => e.expiresAt);
      await tg.send(payment());
      assertEquals((await getUserEntitlements(MEMBER)).map(e => e.expiresAt), before);
      const replay = tg.callsOf("sendMessage").at(-1)!;
      assertStringIncludes(JSON.stringify(replay.payload.reply_markup), `https://t.me/+invite_${MOCK_CONFIG.VIP_COLLECTIONS_CHAT_ID}`);
      await tg.send(chatJoinRequest(MOCK_CONFIG.VIP_COLLECTIONS_CHAT_ID, MEMBER));
      assertEquals(tg.callsOf("approveChatJoinRequest").length, 1);
    } finally { await kv.close(); }
  });
}

Deno.test("DIRECT JOIN — failed invite creation preserves the grant and confirmation with a working recovery button", async () => {
  const kv = await setupTestEnvironment();
  try {
    const tg = await createFakeTelegram();
    tg.failing.set("createChatInviteLink", "Telegram temporarily unavailable");
    await tg.send(callback(ADMIN, `admin:grant_cfm:${MEMBER}:30:admin_exception:full`));
    const receipt = tg.callsOf("sendMessage").find(c => c.payload.chat_id === MEMBER)!;
    assert(receipt);
    assertStringIncludes(JSON.stringify(receipt.payload.reply_markup), "member:channels:refresh");
    assertEquals((await getMembershipSummary(MEMBER)).accessibleSpaces.length, 4);
    const before = (await getUserEntitlements(MEMBER)).map(e => e.expiresAt);
    tg.failing.clear();
    await tg.send(callback(MEMBER, "member:channels:refresh"));
    assertStringIncludes(JSON.stringify(tg.callsOf("editMessageText").at(-1)!.payload.reply_markup), `https://t.me/+invite_${MOCK_CONFIG.TELEGRAM_RETRO_FORUM_CHAT_ID}`);
    assertEquals((await getUserEntitlements(MEMBER)).map(e => e.expiresAt), before);
  } finally { await kv.close(); }
});

Deno.test("EARNED ACCESS — visitor menu remains usable after a later reward, without issuing links before approval", async () => {
  const kv = await setupTestEnvironment();
  try {
    const kb = mainMenuKeyboard(false, false, "none", "contribution_only");
    assertStringIncludes(JSON.stringify(kb), "member:channels");
    const tg = await createFakeTelegram();
    await tg.send(callback(MEMBER, "member:channels"));
    assertEquals(tg.callsOf("createChatInviteLink").length, 0);
    await reward();
    await tg.send(callback(MEMBER, "member:channels"));
    assertEquals(tg.callsOf("createChatInviteLink").length, 4);
    assertEquals(tg.callsOf("createInvoiceLink").length, 0);
  } finally { await kv.close(); }
});

Deno.test("EARNED ACCESS — refresh replaces stale cached links only for authorized spaces, without adding reward days", async () => {
  const kv = await setupTestEnvironment();
  try {
    await reward(["regular"]);
    await saveInviteLink("vip_collections", MOCK_CONFIG.VIP_COLLECTIONS_CHAT_ID, "https://t.me/+revoked");
    const before = (await getUserEntitlements(MEMBER)).map(e => e.expiresAt);
    const tg = await createFakeTelegram();
    await tg.send(callback(MEMBER, "member:channels"));
    assertStringIncludes(JSON.stringify(tg.callsOf("editMessageText").at(-1)!.payload.reply_markup), "https://t.me/+revoked");
    tg.reset();
    await tg.send(callback(MEMBER, "member:channels:refresh"));
    assertEquals(tg.callsOf("createChatInviteLink").length, 3);
    assert(!tg.callsOf("createChatInviteLink").some(c => c.payload.chat_id === MOCK_CONFIG.TELEGRAM_RETRO_FORUM_CHAT_ID));
    assert(tg.callsOf("createChatInviteLink").every(c => c.payload.creates_join_request === true));
    assert(!JSON.stringify(tg.callsOf("editMessageText").at(-1)!.payload.reply_markup).includes("+revoked"));
    assertEquals((await getUserEntitlements(MEMBER)).map(e => e.expiresAt), before);
    tg.reset();
    await tg.send(callback(MEMBER + 1, "member:channels:refresh"));
    assertEquals(tg.callsOf("createChatInviteLink").length, 0);
  } finally { await kv.close(); }
});

Deno.test("EARNED ACCESS — Telegram approval failures preserve both grants and never tell the member to buy a subscription", async () => {
  const kv = await setupTestEnvironment();
  try {
    await reward();
    const before = (await getUserEntitlements(MEMBER)).map(e => e.expiresAt).sort();
    const tg = await createFakeTelegram();
    tg.failing.set("approveChatJoinRequest", "Too Many Requests: retry after 1");
    await tg.send(chatJoinRequest(MOCK_CONFIG.VIP_COLLECTIONS_CHAT_ID, MEMBER));
    const note = tg.callsOf("sendMessage").find(c => c.payload.chat_id === MEMBER)!;
    assertStringIncludes(String(note.payload.text), "Votre accès est bien actif");
    assert(!String(note.payload.text).includes("n'avez pas d'abonnement"));
    assert(!JSON.stringify(note.payload.reply_markup).includes("member:join"));
    assertStringIncludes(JSON.stringify(note.payload.reply_markup), "member:channels:refresh");
    assertEquals((await getSyncState(MEMBER, "vip_collections"))!.status, "error");
    assertEquals((await getMembershipSummary(MEMBER)).hasRetroAccess, true);
    tg.failing.clear();
    await tg.send(chatJoinRequest(MOCK_CONFIG.VIP_COLLECTIONS_CHAT_ID, MEMBER));
    assertEquals((await getSyncState(MEMBER, "vip_collections"))!.status, "admitted");
    assertEquals((await getUserEntitlements(MEMBER)).map(e => e.expiresAt).sort(), before);
  } finally { await kv.close(); }
});

Deno.test("EARNED ACCESS — one failed forum link is visible and can be retried without hiding working links", async () => {
  const kv = await setupTestEnvironment();
  try {
    await reward();
    const tg = await createFakeTelegram();
    let failRetro = true;
    tg.bot.api.config.use((prev, method, payload, signal) => {
      if (method === "createChatInviteLink" && (payload as { chat_id: number }).chat_id === MOCK_CONFIG.TELEGRAM_RETRO_FORUM_CHAT_ID && failRetro) {
        return Promise.resolve({ ok: false, error_code: 429, description: "Too Many Requests" } as never);
      }
      return prev(method, payload, signal);
    });
    await tg.send(callback(MEMBER, "member:channels"));
    const screen = tg.callsOf("editMessageText").at(-1)!.payload;
    assertStringIncludes(String(screen.text), "Liens temporairement indisponibles");
    assertStringIncludes(JSON.stringify(screen.reply_markup), "member:channels:refresh");
    assertStringIncludes(JSON.stringify(screen.reply_markup), String(MOCK_CONFIG.VIP_COLLECTIONS_CHAT_ID));
    failRetro = false;
    await tg.send(callback(MEMBER, "member:channels:refresh"));
    const repaired = tg.callsOf("editMessageText").at(-1)!.payload;
    assert(!String(repaired.text).includes("Liens temporairement indisponibles"));
    assertStringIncludes(JSON.stringify(repaired.reply_markup), String(MOCK_CONFIG.TELEGRAM_RETRO_FORUM_CHAT_ID));
  } finally { await kv.close(); }
});
