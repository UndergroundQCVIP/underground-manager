import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { MOCK_CONFIG, MockTelegramApi, setupTestEnvironment } from "./test_helpers.ts";
import { callback, chatJoinRequest, createFakeTelegram, groupMessage, privateMessage, user } from "./bot_harness.ts";
import { getConfig, setConfigForTesting, validateConfig } from "../src/config.ts";
import { bindAmateurForum, refreshAmateurConfiguration } from "../src/db/amateur.ts";
import { createEntitlement, getMembershipSummary, getUserEntitlements, hasAccessToSpace, updateEntitlementStatus } from "../src/db/entitlements.ts";
import { grantComplimentaryAccess } from "../src/complimentary/service.ts";
import { handleForumTopicCreated, handleMediaUpload } from "../src/creators/service.ts";
import { listCreators, saveCreator } from "../src/db/creators.ts";
import { findSimilarCreators, startContribution } from "../src/contributions/service.ts";
import { buildDirectoryMessages, syncPublicDirectory } from "../src/directory/sync.ts";
import { getPlan } from "../src/plans/plans.ts";
import { mainMenuKeyboard } from "../src/bot/keyboards.ts";
import { reconcileAllMembers } from "../src/access/sync.ts";
import { COMPLIMENTARY_SPACES, CollectionCategory } from "../src/types.ts";

const AMATEUR = -1001008, ADMIN = MOCK_CONFIG.ADMIN_USER_IDS[0], MEMBER = 7654321;
function configure() { setConfigForTesting({ ...MOCK_CONFIG, TELEGRAM_AMATEUR_FORUM_CHAT_ID: AMATEUR }); }

Deno.test("AMATEUR — public button stays locked for paid, earned and full-access members; only explicit admin grants unlock it", async () => {
  const kv = await setupTestEnvironment();
  try {
    configure();
    assertStringIncludes(JSON.stringify(mainMenuKeyboard(false, false)), "member:amateur");
    for (const spaces of [getPlan("regular").spaces, getPlan("retro_plus").spaces, COMPLIMENTARY_SPACES.full]) assert(!spaces.includes("amateur_collections"));
    const tg = await createFakeTelegram();
    for (const [i, source] of (["telegram_stars", "contribution", "complimentary"] as const).entries()) {
      const member = MEMBER + i;
      await createEntitlement({ userId: member, source, spaces: ["vip_collections", "retro_collections", "amateur_collections"],
        startsAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 90 * 86400000).toISOString(), status: "active", metadata: { accessLevel: "full", grantedBy: ADMIN } });
      assertEquals(await hasAccessToSpace(member, "amateur_collections"), false);
      tg.reset();
      await tg.send(callback(member, "member:amateur"));
      await tg.send(callback(member, "nav:amateur"));
      await tg.send(privateMessage(member, "/start amateur"));
      assertEquals(tg.callsOf("createChatInviteLink").length, 0);
      assertStringIncludes(JSON.stringify(tg.calls), "verrouillée");
      await tg.send(chatJoinRequest(AMATEUR, member));
      assertEquals(tg.callsOf("approveChatJoinRequest").length, 0);
      assertEquals(tg.callsOf("declineChatJoinRequest").length, 1);
    }
    tg.reset();
    await tg.send(callback(ADMIN, `admin:grant_spc:${MEMBER}:30:admin_exception:amateur`));
    const confirmation = tg.callsOf("editMessageText").at(-1)!.payload;
    assertStringIncludes(String(confirmation.text), "Amateur + en activité + Retro");
    await tg.send(callback(ADMIN, `admin:grant_cfm:${MEMBER}:30:admin_exception:amateur`));
    assertEquals(await hasAccessToSpace(MEMBER, "amateur_collections"), true);
    const grant = (await getUserEntitlements(MEMBER)).find((e) => e.metadata?.accessLevel === "amateur")!;
    assertEquals(Math.round((new Date(grant.expiresAt).getTime() - Date.now()) / 86400000), 30);
    assertEquals(grant.spaces, COMPLIMENTARY_SPACES.amateur);
    await tg.send(callback(MEMBER, "member:amateur"));
    assertStringIncludes(JSON.stringify(tg.callsOf("editMessageText").at(-1)!.payload.reply_markup), `https://t.me/+invite_${AMATEUR}`);
    await tg.send(chatJoinRequest(AMATEUR, MEMBER));
    assertEquals(tg.callsOf("approveChatJoinRequest").at(-1)!.payload.chat_id, AMATEUR);
    await updateEntitlementStatus(grant.id, "revoked");
    tg.reset();
    await reconcileAllMembers(tg.bot.api);
    assertEquals(tg.callsOf("banChatMember").filter((c) => c.payload.chat_id === AMATEUR).length, 1);
  } finally { await kv.close(); }
});

Deno.test("AMATEUR — backend denies non-admin grants and leaves the unconfigured collection closed", async () => {
  const kv = await setupTestEnvironment();
  try {
    const params = { adminId: ADMIN, userId: MEMBER, durationDays: 30, reason: "admin_exception", level: "amateur" as const };
    assertEquals((await grantComplimentaryAccess(params)).success, false);
    configure();
    assertEquals((await grantComplimentaryAccess({ ...params, adminId: MEMBER })).success, false);
    assertEquals((await getUserEntitlements(MEMBER)).length, 0);
    await assertRejects(() => bindAmateurForum(MOCK_CONFIG.PUBLIC_DIRECTORY_CHAT_ID, ADMIN));
    await assertRejects(() => bindAmateurForum(AMATEUR, MEMBER));
    assert(validateConfig({ ...MOCK_CONFIG, TELEGRAM_AMATEUR_FORUM_CHAT_ID: MOCK_CONFIG.VIP_COLLECTIONS_CHAT_ID }).some((e) => e.includes("different chats")));
  } finally { await kv.close(); }
});

Deno.test("AMATEUR — creator inventory and directory stay private across public syncs, contributions and guessed deep links", async () => {
  const kv = await setupTestEnvironment();
  try {
    configure();
    const creator = (await handleForumTopicCreated(AMATEUR, 42, "Hidden_Amateur [Name]"))!;
    await handleMediaUpload(AMATEUR, 42, ADMIN, undefined, { messageId: 43, kind: "photo", hasCaption: false });
    assertEquals((await listCreators()).length, 0);
    assertEquals((await listCreators({ collection: "amateur" })).length, 1);
    assertEquals((await startContribution(MEMBER, creator.id)).ok, false);
    assertEquals((await findSimilarCreators(creator.name)).length, 0);
    assert(!JSON.stringify(buildDirectoryMessages([creator], "TestBot")).includes(creator.name));
    const api = new MockTelegramApi();
    assertEquals((await syncPublicDirectory(api, true, "amateur" as CollectionCategory)).reason, "private_collection");
    assertEquals(api.sentMessages.length, 0);
    await syncPublicDirectory(api, true);
    assert(!JSON.stringify(api.sentMessages).includes(creator.name));
    const tg = await createFakeTelegram();
    await tg.send(privateMessage(MEMBER, `/start creator_${creator.id}`));
    assert(!JSON.stringify(tg.calls).includes(creator.name));
    assert(!JSON.stringify(tg.calls).includes(`/42`));
    tg.reset();
    const open = callback(ADMIN, "amateur:directory");
    await tg.send(open);
    await tg.send(open);
    const view = tg.callsOf("editMessageText").at(-1)!.payload;
    assertStringIncludes(String(view.text), "Hidden_Amateur [Name] (1)");
    assertStringIncludes(JSON.stringify(view.entities), `https://t.me/c/1008/42`);
    assertEquals(view.chat_id, ADMIN);
    assertEquals(view.parse_mode, undefined);
    assertEquals(tg.callsOf("sendMessage").length, 0);
    tg.reset();
    await grantComplimentaryAccess({ adminId: ADMIN, userId: MEMBER, durationDays: 7, reason: "admin_exception", level: "amateur" });
    await tg.send(callback(MEMBER, "amateur:directory"));
    const group = callback(ADMIN, "amateur:directory");
    group.callback_query.message.chat = { id: MOCK_CONFIG.GENERAL_CHAT_ID, type: "supergroup", first_name: "Group" } as typeof group.callback_query.message.chat;
    await tg.send(group);
    assertEquals(tg.callsOf("editMessageText").length, 0);
    assert(!JSON.stringify(tg.calls).includes(creator.name));
  } finally { await kv.close(); }
});

Deno.test("AMATEUR — setup binds a new private forum, preserves webhook events and locks member invitations", async () => {
  const kv = await setupTestEnvironment();
  try {
    const tg = await createFakeTelegram();
    tg.bot.api.config.use((prev, method, payload, signal) => {
      if (method === "getChat") return Promise.resolve({ ok: true, result: { id: AMATEUR, type: "supergroup", title: "Amateur", is_forum: true, permissions: { can_send_messages: true, can_invite_users: true } } } as never);
      if (method === "getWebhookInfo") return Promise.resolve({ ok: true, result: { url: "https://bot.example/webhook", pending_update_count: 0, has_custom_certificate: false, allowed_updates: ["message", "callback_query", "pre_checkout_query", "chat_join_request"] } } as never);
      return prev(method, payload, signal);
    });
    const command = { message: { ...groupMessage(AMATEUR, ADMIN, "/setup_amateur").message,
      entities: [{ type: "bot_command", offset: 0, length: "/setup_amateur".length }] } };
    await tg.send(command);
    assertEquals(getConfig().TELEGRAM_AMATEUR_FORUM_CHAT_ID, AMATEUR);
    const webhook = tg.callsOf("setWebhook").at(-1)!.payload;
    assertEquals(webhook.url, "https://bot.example/webhook");
    assertEquals(webhook.secret_token, MOCK_CONFIG.WEBHOOK_SECRET);
    for (const update of ["message", "callback_query", "pre_checkout_query", "chat_join_request", "chat_member"]) assert((webhook.allowed_updates as string[]).includes(update));
    const permissions = tg.callsOf("setChatPermissions").at(-1)!.payload.permissions as Record<string, unknown>;
    assertEquals(permissions.can_send_messages, true);
    assertEquals(permissions.can_invite_users, false);
    setConfigForTesting({ ...MOCK_CONFIG });
    await refreshAmateurConfiguration();
    assertEquals(getConfig().TELEGRAM_AMATEUR_FORUM_CHAT_ID, AMATEUR);
    await assertRejects(() => bindAmateurForum(-1001009, ADMIN));
  } finally { await kv.close(); }
});

Deno.test("AMATEUR — a membership update removes someone who entered around the join-request gate", async () => {
  const kv = await setupTestEnvironment();
  try {
    configure();
    const tg = await createFakeTelegram();
    const membership = { chat_member: { chat: { id: AMATEUR, type: "supergroup", title: "Amateur" }, from: user(ADMIN), date: 0,
      old_chat_member: { status: "left", user: user(MEMBER) }, new_chat_member: { status: "member", user: user(MEMBER) } } };
    await tg.send(membership);
    assertEquals(tg.callsOf("banChatMember").at(-1)!.payload.chat_id, AMATEUR);
    await grantComplimentaryAccess({ adminId: ADMIN, userId: MEMBER, durationDays: 7, reason: "admin_exception", level: "amateur" });
    tg.reset();
    await tg.send(membership);
    assertEquals(tg.callsOf("banChatMember").length, 0);
    assertEquals((await getMembershipSummary(MEMBER)).plan, "retro_plus");
  } finally { await kv.close(); }
});

Deno.test("AMATEUR — long private directories paginate one dated message and never publish to other chats", async () => {
  const kv = await setupTestEnvironment();
  try {
    configure();
    const base = (await handleForumTopicCreated(AMATEUR, 1, "Seed"))!;
    for (let i = 0; i < 100; i++) await saveCreator({ ...base, id: `amateur-${i}`, topicId: i + 10,
      name: `Private ${String(i).padStart(3, "0")} 🎞️`, normalizedName: `private ${i}`, hasContent: true });
    const tg = await createFakeTelegram();
    const open = callback(ADMIN, "amateur:directory");
    await tg.send(open);
    await tg.send(open);
    assertEquals(tg.callsOf("sendMessage").length, 0);
    const turn = callback(ADMIN, "amateur:page:1");
    turn.callback_query.message.message_id = open.callback_query.message.message_id;
    await tg.send(turn);
    const page = tg.callsOf("editMessageText").at(-1)!;
    assertStringIncludes(String(page.payload.text), "Private 099");
    assertStringIncludes(String(page.payload.text), "Page 2/2");
    assertStringIncludes(String(page.payload.text), "Mis à jour :");
    assertEquals(page.payload.message_id, open.callback_query.message.message_id);
    for (const call of tg.calls.filter((c) => c.method === "sendMessage" || c.method === "editMessageText")) {
      assertEquals(call.payload.chat_id, ADMIN);
      assert(String(call.payload.text).length <= 4096);
      assert(!JSON.stringify(call.payload.reply_markup ?? {}).includes("sync_dir"));
    }
  } finally { await kv.close(); }
});

Deno.test("AMATEUR — setup refuses a public or existing collection chat without changing permissions or webhook", async () => {
  const kv = await setupTestEnvironment();
  try {
    const tg = await createFakeTelegram();
    let publicChat = true;
    tg.bot.api.config.use((prev, method, payload, signal) => {
      if (method === "getChat") return Promise.resolve({ ok: true, result: { id: publicChat ? AMATEUR : MOCK_CONFIG.VIP_COLLECTIONS_CHAT_ID,
        type: "supergroup", title: "Forum", is_forum: true, username: publicChat ? "public_group" : undefined } } as never);
      return prev(method, payload, signal);
    });
    const setup = () => ({ message: { ...groupMessage(AMATEUR, ADMIN, "/setup_amateur").message,
      entities: [{ type: "bot_command", offset: 0, length: "/setup_amateur".length }] } });
    await tg.send(setup());
    publicChat = false;
    await tg.send(setup());
    assertEquals(getConfig().TELEGRAM_AMATEUR_FORUM_CHAT_ID, 0);
    assertEquals(tg.callsOf("setWebhook").length, 0);
    assertEquals(tg.callsOf("setChatPermissions").length, 0);
  } finally { await kv.close(); }
});
