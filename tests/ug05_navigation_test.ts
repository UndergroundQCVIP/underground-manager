/**
 * LA CONFRÉRIE — UG-05 Pre-Publish Test Suite: MEMBERSHIP MODES & PUBLIC NAVIGATION
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { MOCK_CONFIG, MockTelegramApi, setupTestEnvironment } from "./test_helpers.ts";
import { MockMigrationApi, pay, REGULAR_CHAT, seedCreator } from "./ug04_helpers.ts";
import { cb, makeBot, preCheckout, sentTexts, text } from "./ug05_harness.ts";
import { setConfigForTesting, validateConfig, loadConfig } from "../src/config.ts";
import { updateSystemSettings, getSystemSettings } from "../src/db/settings.ts";
import { getActiveUserEntitlements, getMembershipSummary } from "../src/db/entitlements.ts";
import { getUserPayments } from "../src/db/payments.ts";
import { TelegramStarsProvider } from "../src/payments/stars.ts";
import { plansKeyboard, mainMenuKeyboard, adminMenuKeyboard } from "../src/bot/keyboards.ts";
import { messages } from "../src/bot/messages.ts";
import {
  buildLobbyMessage,
  buildWelcomeMessage,
  directoryNavKeyboard,
  syncNavigationMessages,
  syncDirectoryButtons,
  welcomeKeyboard,
} from "../src/navigation/service.ts";
import { syncPublicDirectory } from "../src/directory/sync.ts";
import { processChatJoinRequest } from "../src/access/join_requests.ts";
import { approveContribution, addContributionItem, finishContribution, startContribution } from "../src/contributions/service.ts";

const ADMIN = 111111;
const BOT = MOCK_CONFIG.BOT_USERNAME;
const flat = (kb: { inline_keyboard: { text?: string; url?: string; callback_data?: string }[][] }) => kb.inline_keyboard.flat();

// ================================ MEMBERSHIP ACQUISITION MODE ================================

Deno.test("UG05 MODE — Default for the community launch is Contribution Only (env-overridable)", async () => {
  const kv = await setupTestEnvironment();
  try {
    assertEquals(loadConfig({}).MEMBERSHIP_MODE, "contribution_only");
    assertEquals(loadConfig({ MEMBERSHIP_MODE: "stars_only" }).MEMBERSHIP_MODE, "stars_only");
    assertEquals(loadConfig({ MEMBERSHIP_MODE: "garbage" }).MEMBERSHIP_MODE, "contribution_only");
    setConfigForTesting({ ...MOCK_CONFIG, MEMBERSHIP_MODE: "contribution_only" });
    assertEquals((await getSystemSettings()).membershipMode, "contribution_only");
    // an admin-saved choice overrides the env default
    await updateSystemSettings({ membershipMode: "stars_only" });
    assertEquals((await getSystemSettings()).membershipMode, "stars_only");
  } finally {
    await kv.close();
  }
});

Deno.test("UG05 MODE — Contribution Only hides NEW Stars checkout everywhere but keeps existing subscriptions intact", async () => {
  const kv = await setupTestEnvironment();
  try {
    await pay(7001, "regular", "ch_existing", { expiresInDays: 20 });
    await updateSystemSettings({ membershipMode: "contribution_only" });

    // Keyboards / texts
    const plans = JSON.stringify(plansKeyboard("none", "contribution_only"));
    assert(!plans.includes("member:pay:"));
    assertStringIncludes(plans, "contrib:start");
    assert(!JSON.stringify(mainMenuKeyboard(true, false, "regular", "contribution_only")).includes("member:upgrade"));
    assert(!/Étoiles \/ 30 jours/.test(messages.plansOverview(undefined, "contribution_only")));
    assertStringIncludes(messages.plansOverview(undefined, "contribution_only"), "Contribuer");

    // Checkout attempts through the bot are refused and no invoice is created
    const { bot, calls } = makeBot();
    await bot.handleUpdate(cb(7002, "member:pay:regular") as never);
    await bot.handleUpdate(cb(7002, "member:pay:retro_plus") as never);
    await bot.handleUpdate(cb(7002, "member:pay_stars") as never);
    assertEquals(calls.some((c) => c.method === "createInvoiceLink"), false);
    assertStringIncludes(sentTexts(calls).join("\n"), "ne sont pas offerts");

    // An already-issued invoice paid after the switch is declined at pre-checkout (no charge)
    await bot.handleUpdate(preCheckout(7002, TelegramStarsProvider.buildInvoicePayload(7002, "regular")) as never);
    const answer = calls.find((c) => c.method === "answerPreCheckoutQuery")!;
    assertEquals(answer.payload.ok, false);

    // Existing paid subscription and its payment history are untouched
    const ents = await getActiveUserEntitlements(7001);
    assertEquals(ents.length, 1);
    assertEquals(ents[0].source, "telegram_stars");
    assertEquals((await getUserPayments(7001)).length, 1);
    assertEquals((await getMembershipSummary(7001)).hasPaid, true);

    // A recurring renewal (no pre-checkout) is still credited
    const renewal = await pay(7001, "regular", "ch_renewal");
    assertEquals(renewal.success, true);
    assertEquals((await getUserPayments(7001)).length, 2);
  } finally {
    await kv.close();
  }
});

Deno.test("UG05 MODE — Contributions + Stars offers both; Stars Only keeps the original paid workflow", async () => {
  const kv = await setupTestEnvironment();
  try {
    const mixed = JSON.stringify(plansKeyboard("none", "contributions_and_stars"));
    assertStringIncludes(mixed, "member:pay:regular");
    assertStringIncludes(mixed, "contrib:start");
    assertStringIncludes(messages.plansOverview(undefined, "contributions_and_stars"), "Étoiles");

    const stars = JSON.stringify(plansKeyboard("none", "stars_only"));
    assertStringIncludes(stars, "member:pay:regular");
    assert(!stars.includes("contrib:start"));

    await updateSystemSettings({ membershipMode: "stars_only" });
    const { bot, calls } = makeBot();
    await bot.handleUpdate(cb(7003, "member:pay:regular") as never);
    assertEquals(calls.filter((c) => c.method === "createInvoiceLink").length, 1);
    await bot.handleUpdate(preCheckout(7003, TelegramStarsProvider.buildInvoicePayload(7003, "regular")) as never);
    assertEquals(calls.find((c) => c.method === "answerPreCheckoutQuery")!.payload.ok, true);
  } finally {
    await kv.close();
  }
});

Deno.test("UG05 MODE — Switching modes erases no entitlement or payment; only admins can switch", async () => {
  const kv = await setupTestEnvironment();
  try {
    await pay(7004, "retro_plus", "ch_sw");
    const { bot } = makeBot();
    await updateSystemSettings({ membershipMode: "contributions_and_stars" });

    await bot.handleUpdate(cb(5555, "admin:mode_set:so") as never); // not an admin
    assertEquals((await getSystemSettings()).membershipMode, "contributions_and_stars");

    for (const code of ["co", "so", "cs"]) {
      await bot.handleUpdate(cb(ADMIN, `admin:mode_set:${code}`) as never);
      assertEquals((await getActiveUserEntitlements(7004)).length, 1);
      assertEquals((await getUserPayments(7004)).length, 1);
    }
    assertEquals((await getSystemSettings()).membershipMode, "contributions_and_stars");
    await bot.handleUpdate(cb(ADMIN, "admin:mode_set:co") as never);
    assertEquals((await getSystemSettings()).membershipMode, "contribution_only");
  } finally {
    await kv.close();
  }
});

Deno.test("UG05 MODE — Join page reflects the active mode", async () => {
  const kv = await setupTestEnvironment();
  try {
    const { bot, calls } = makeBot();
    await updateSystemSettings({ membershipMode: "contribution_only" });
    await bot.handleUpdate(text(7005, "/start join") as never);
    let t = sentTexts(calls).join("\n") + JSON.stringify(calls.filter((c) => c.method === "sendMessage"));
    assertStringIncludes(t, "contrib:start");
    assert(!t.includes("member:plans"));

    calls.length = 0;
    await updateSystemSettings({ membershipMode: "contributions_and_stars" });
    await bot.handleUpdate(text(7005, "/start join") as never);
    t = JSON.stringify(calls.filter((c) => c.method === "sendMessage"));
    assertStringIncludes(t, "contrib:start");
    assertStringIncludes(t, "member:plans");
  } finally {
    await kv.close();
  }
});

// ================================ PUBLIC NAVIGATION ================================

Deno.test("UG05 NAV — Welcome menu has every required button as an official bot deep link (URL buttons only)", async () => {
  const kv = await setupTestEnvironment();
  try {
    setConfigForTesting({ ...MOCK_CONFIG, PUBLIC_DIRECTORY_URL: "", TELEGRAM_PUBLIC_LOBBY_URL: "" });
    const buttons = flat(welcomeKeyboard());
    assertEquals(buttons.length, 8);
    for (const b of buttons) {
      assert(b.url && !b.callback_data, "public buttons must be plain URL buttons");
      assert(b.url!.startsWith("https://t.me/"), b.url);
    }
    const urls = buttons.map((b) => b.url!);
    for (const page of ["regular", "retro", "how", "contribute", "join", "rules"]) {
      assert(urls.includes(`https://t.me/${BOT}?start=${page}`), page);
    }
    // Directory + Explore fall back to the bot when no public URLs are configured...
    assert(urls.includes(`https://t.me/${BOT}?start=directory`));
    assert(urls.includes(`https://t.me/${BOT}?start=explore`));

    // ...and use the real public links when configured.
    setConfigForTesting({ ...MOCK_CONFIG, TELEGRAM_PUBLIC_LOBBY_URL: "https://t.me/confrerie_accueil", PUBLIC_DIRECTORY_URL: "https://t.me/confrerie_repertoire" });
    const real = flat(welcomeKeyboard()).map((b) => b.url!);
    assert(real.includes("https://t.me/confrerie_accueil"));
    assert(real.includes("https://t.me/confrerie_repertoire"));
  } finally {
    await kv.close();
  }
});

Deno.test("UG05 NAV — Public messages never contain private invitation links or space identifiers", async () => {
  const kv = await setupTestEnvironment();
  try {
    const all = JSON.stringify([
      buildWelcomeMessage("contributions_and_stars"),
      buildLobbyMessage("contribution_only"),
      directoryNavKeyboard(),
    ]);
    assert(!/t\.me\/\+|joinchat|t\.me\/c\//.test(all));
    for (const id of [MOCK_CONFIG.VIP_COLLECTIONS_CHAT_ID, MOCK_CONFIG.TELEGRAM_RETRO_FORUM_CHAT_ID, MOCK_CONFIG.GENERAL_CHAT_ID, MOCK_CONFIG.WANTED_LIST_CHAT_ID]) {
      assert(!all.includes(String(id).replace("-100", "")), `leaks ${id}`);
    }
    assertStringIncludes(buildLobbyMessage("contribution_only").text, "Tous les envois acceptés ne donnent pas nécessairement droit à une récompense");
    assertStringIncludes(buildLobbyMessage("contribution_only").text, "L'accès prend fin");
  } finally {
    await kv.close();
  }
});

Deno.test("UG05 NAV — Lobby/welcome sync: safe when unconfigured; publishes once, then only edits on change", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockTelegramApi();

    // Unconfigured → graceful fallback, no Telegram calls
    let res = await syncNavigationMessages(api);
    assertEquals(res.lobby.outcome, "not_configured");
    assertEquals(res.welcome.outcome, "not_configured");
    assertEquals(api.sentMessages.length, 0);

    setConfigForTesting({ ...MOCK_CONFIG, TELEGRAM_PUBLIC_LOBBY_CHAT_ID: -100777, TELEGRAM_PUBLIC_WELCOME_CHAT_ID: -100888 });
    await updateSystemSettings({ membershipMode: "contribution_only" });
    res = await syncNavigationMessages(api);
    assertEquals(res.lobby.outcome, "published");
    assertEquals(res.welcome.outcome, "published");
    assertEquals(api.sentMessages.map((m) => m.chatId).sort(), [-100888, -100777].sort());
    assertStringIncludes(api.sentMessages[0].text, "Contribuer");

    // Unchanged → nothing sent or edited (daily run is cheap)
    res = await syncNavigationMessages(api);
    assertEquals(res.lobby.outcome, "unchanged");
    assertEquals(api.sentMessages.length, 2);
    assertEquals(api.editedMessages.length, 0);

    // Mode change → the same messages are EDITED (not duplicated)
    await updateSystemSettings({ membershipMode: "contributions_and_stars" });
    res = await syncNavigationMessages(api);
    assertEquals(res.lobby.outcome, "updated");
    assertEquals(api.sentMessages.length, 2);
    assertEquals(api.editedMessages.length, 2);
    assertStringIncludes(api.editedMessages[0].text, "Étoiles");

    // A deleted message is re-published
    const orig = api.editMessageText.bind(api);
    api.editMessageText = async () => { throw new Error("Bad Request: message to edit not found"); };
    res = await syncNavigationMessages(api, { force: true });
    assertEquals(res.lobby.outcome, "published");
    api.editMessageText = orig;
  } finally {
    await kv.close();
  }
});

Deno.test("UG05 NAV — Directory posts carry navigation buttons on publish AND on every daily edit", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockTelegramApi();
    const c = await seedCreator({ name: "Aria", topicId: 1 });
    await syncPublicDirectory(api, true);
    assertStringIncludes(JSON.stringify(api.sentMessages[0].options), "Comment adhérer");
    for (const label of ["Explorer LA CONFRÉRIE", "Comment adhérer", "Contribuer du contenu", "Options d'adhésion"]) {
      assertStringIncludes(JSON.stringify(api.sentMessages[0].options), label);
    }

    // Daily update after a change: the edit re-sends the keyboard (otherwise Telegram would drop it)
    await seedCreator({ name: "Maya", topicId: 2, collection: "retro" });
    await syncPublicDirectory(api);
    assertEquals(api.editedMessages.length >= 1, true);
    assertStringIncludes(JSON.stringify(api.editedMessages.at(-1)!.options), "Options d'adhésion");
    assertStringIncludes(api.editedMessages.at(-1)!.text, "Maya");

    // "Update Directory Buttons" re-applies the keyboard without republishing the directory
    const sentBefore = api.sentMessages.length;
    const btn = await syncDirectoryButtons(api, true);
    assertEquals(btn.outcome, "updated");
    assertEquals(api.sentMessages.length, sentBefore);
    assertEquals(api.editedMarkups.length >= 1, true);
    assert(c.id.length > 0);
  } finally {
    await kv.close();
  }
});

Deno.test("UG05 NAV — Deep links: public pages open for anyone; private join links only for entitled members", async () => {
  const kv = await setupTestEnvironment();
  try {
    await updateSystemSettings({ membershipMode: "contribution_only" });
    await pay(7101, "regular", "ch_nav_r");
    await pay(7102, "retro_plus", "ch_nav_p");

    // Visitor: explanation only — NO invite link is created for a non-member
    let h = makeBot();
    await h.bot.handleUpdate(text(7100, "/start regular") as never);
    await h.bot.handleUpdate(text(7100, "/start retro") as never);
    assertEquals(h.calls.filter((c) => c.method === "createChatInviteLink").length, 0);
    assertStringIncludes(sentTexts(h.calls).join("\n"), "pas encore accès");
    assert(!JSON.stringify(h.calls).includes("t.me/+"));

    // Regular member: Regular join link yes, Retro no
    h = makeBot();
    await h.bot.handleUpdate(text(7101, "/start regular") as never);
    assertEquals(h.calls.filter((c) => c.method === "createChatInviteLink").map((c) => c.payload.chat_id), [REGULAR_CHAT]);
    assertEquals((h.calls.find((c) => c.method === "createChatInviteLink")!.payload as { creates_join_request?: boolean }).creates_join_request, true);
    h = makeBot();
    await h.bot.handleUpdate(text(7101, "/start retro") as never);
    assertEquals(h.calls.filter((c) => c.method === "createChatInviteLink").length, 0);

    // Retro Plus member gets the Retro link
    h = makeBot();
    await h.bot.handleUpdate(text(7102, "/start retro") as never);
    assertEquals(h.calls.filter((c) => c.method === "createChatInviteLink").length, 1);

    // Informational / action pages work for everyone
    for (const page of ["how", "rules", "explore", "directory", "join"]) {
      h = makeBot();
      await h.bot.handleUpdate(text(7100, `/start ${page}`) as never);
      assertEquals(h.calls.filter((c) => c.method === "sendMessage").length, 1, page);
    }
    // Contribute deep link opens the contribution chooser, no membership needed
    h = makeBot();
    await h.bot.handleUpdate(text(7100, "/start contribute") as never);
    assertStringIncludes(JSON.stringify(h.calls.filter((c) => c.method === "sendMessage")), "contrib:new");
  } finally {
    await kv.close();
  }
});

Deno.test("UG05 NAV — Creator pick: unpaid users get no protected topic link, an explanation and a route to contribute", async () => {
  const kv = await setupTestEnvironment();
  try {
    await updateSystemSettings({ membershipMode: "contribution_only" });
    const c = await seedCreator({ name: "Maya", topicId: 321, collection: "retro" });
    const { bot, calls } = makeBot();
    await bot.handleUpdate(text(7200, `/start creator_${c.id}`) as never);
    const sent = JSON.stringify(calls.filter((x) => x.method === "sendMessage"));
    assert(!sent.includes("t.me/c/"));
    assertStringIncludes(sent, "RETRO | LA CONFRÉRIE");
    assertStringIncludes(sent, `contrib:pick:${c.id}`);
    assertStringIncludes(sent, "contribuant du contenu");
  } finally {
    await kv.close();
  }
});

Deno.test("UG05 NAV — The public lobby is never access-controlled; the private General Chat stays private", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockTelegramApi();
    setConfigForTesting({ ...MOCK_CONFIG, TELEGRAM_PUBLIC_LOBBY_CHAT_ID: -100777 });
    const lobby = await processChatJoinRequest(api, { chat: { id: -100777 }, from: { id: 9001, first_name: "Visitor" } });
    assertEquals(lobby.spaceId, null); // not a managed (paid) space
    assertEquals(api.approvedJoinRequests.length, 0);

    const general = await processChatJoinRequest(api, { chat: { id: MOCK_CONFIG.GENERAL_CHAT_ID }, from: { id: 9001, first_name: "Visitor" } });
    assertEquals(general.approved, false);
    assertEquals(general.spaceId, "general_chat");
    assertEquals(api.declinedJoinRequests.length, 1);

    // Configuration safety: the lobby may never be one of the private spaces
    const bad = validateConfig({ ...MOCK_CONFIG, TELEGRAM_PUBLIC_LOBBY_CHAT_ID: MOCK_CONFIG.GENERAL_CHAT_ID });
    assert(bad.some((e) => e.includes("TELEGRAM_PUBLIC_LOBBY_CHAT_ID")));
    assertEquals(validateConfig({ ...MOCK_CONFIG, TELEGRAM_PUBLIC_LOBBY_CHAT_ID: -100777 }).some((e) => e.includes("LOBBY")), false);
  } finally {
    await kv.close();
  }
});

Deno.test("UG05 NAV — Contribute deep link reaches the existing flow for a user with no membership", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockMigrationApi();
    const c = await seedCreator({ name: "Aria", topicId: 101 });
    const { bot } = makeBot();
    await bot.handleUpdate(text(7300, "/start contribute") as never);
    await bot.handleUpdate(cb(7300, `contrib:pick:${c.id}`) as never);
    assert((await addContributionItem(7300, { messageId: 5, kind: "photo" })).added);
    assert((await finishContribution(api, 7300)).ok);
    assertEquals((await getMembershipSummary(7300)).isMember, false); // submission alone grants nothing
    assert((await startContribution(7300, c.id)).ok);
    assertEquals(await (async () => (await approveContribution(api, "missing", ADMIN)).ok)(), false);
  } finally {
    await kv.close();
  }
});

Deno.test("UG05 NAV — Admin menus expose Contributions, Settings → Membership/Navigation, and the sync actions", async () => {
  const kv = await setupTestEnvironment();
  try {
    const admin = JSON.stringify(adminMenuKeyboard());
    assertStringIncludes(admin, "cadm:hub");
    assertStringIncludes(admin, "admin:settings");

    const { bot, calls } = makeBot();
    await bot.handleUpdate(cb(ADMIN, "admin:settings") as never);
    let screen = JSON.stringify(calls.filter((c) => c.method === "editMessageText").at(-1));
    for (const label of ["Mode d'adhésion", "Navigation publique", "Récompenses"]) assertStringIncludes(screen, label);

    await bot.handleUpdate(cb(ADMIN, "admin:nav") as never);
    screen = JSON.stringify(calls.filter((c) => c.method === "editMessageText").at(-1));
    for (const label of ["Mettre à jour le menu d'accueil", "Mettre à jour les boutons du répertoire", "Synchroniser les messages d'information"]) {
      assertStringIncludes(screen, label);
    }
    // Unconfigured lobby → exact setup instructions, nothing invented
    await bot.handleUpdate(cb(ADMIN, "admin:nav_lobby") as never);
    screen = JSON.stringify(calls.filter((c) => c.method === "editMessageText").at(-1));
    assertStringIncludes(screen, "TELEGRAM_PUBLIC_LOBBY_CHAT_ID");
    assertStringIncludes(screen, "LA CONFRÉRIE | ACCUEIL");

    // Non-admins cannot open them
    calls.length = 0;
    await bot.handleUpdate(cb(5555, "admin:nav_sync:all") as never);
    await bot.handleUpdate(cb(5555, "cadm:hub") as never);
    assertEquals(calls.filter((c) => c.method === "editMessageText").length, 0);

    await bot.handleUpdate(cb(ADMIN, "cadm:hub") as never);
    await bot.handleUpdate(cb(ADMIN, "cadm:rewards") as never);
    await bot.handleUpdate(cb(ADMIN, "cadm:hist:0") as never);
    assertEquals(calls.filter((c) => c.method === "editMessageText").length, 3);
  } finally {
    await kv.close();
  }
});

Deno.test("UG05 ROSTER — Admin sees active members, their source and days left; non-admins cannot", async () => {
  const kv = await setupTestEnvironment();
  try {
    const { upsertMember } = await import("../src/db/members.ts");
    await upsertMember({ id: 8101, username: "alice", first_name: "Alice" });
    await pay(8101, "regular", "ch_r1", { expiresInDays: 10 });
    await upsertMember({ id: 8102, first_name: "Bob" });
    const api = new MockMigrationApi();
    const c = await seedCreator({ name: "Aria", topicId: 101 });
    assert((await startContribution(8102, c.id)).ok);
    await addContributionItem(8102, { messageId: 1, kind: "photo" });
    await finishContribution(api, 8102);
    const { listContributions } = await import("../src/db/contributions.ts");
    await approveContribution(api, (await listContributions("pending"))[0].id, ADMIN, { type: "reward", scopes: ["retro"], days: 3 });
    await pay(8103, "regular", "ch_gone", { expiresInDays: 5 });
    const { grantComplimentaryAccess } = await import("../src/complimentary/service.ts");
    await grantComplimentaryAccess({ adminId: ADMIN, userId: 8104, durationDays: 7, reason: "partnership", level: "vip_only" });

    const { bot, calls } = makeBot();
    await bot.handleUpdate(cb(ADMIN, "admin:roster:0") as never);
    const t = String((calls.filter((x) => x.method === "editMessageText").at(-1)!.payload as { text: string }).text);
    assertStringIncludes(t, "MEMBRES ACTIFS* (4)");
    assertStringIncludes(t, "@alice");
    assertStringIncludes(t, "Étoiles · Regular : *10 j*");
    assertStringIncludes(t, "Bob");
    assertStringIncludes(t, "Contribution · Retro : *3 j*");
    assertStringIncludes(t, "Gracieux : *7 j*");
    assert(t.indexOf("*3 j*") < t.indexOf("*10 j*")); // soonest expiry first

    calls.length = 0;
    await bot.handleUpdate(cb(5555, "admin:roster:0") as never);
    assertEquals(calls.filter((x) => x.method === "editMessageText").length, 0);
  } finally {
    await kv.close();
  }
});
