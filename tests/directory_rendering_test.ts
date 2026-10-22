import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { MOCK_CONFIG, MockTelegramApi, setupTestEnvironment } from "./test_helpers.ts";
import { seedCreator } from "./ug04_helpers.ts";
import { callback, createFakeTelegram, privateMessage } from "./bot_harness.ts";
import { setConfigForTesting } from "../src/config.ts";
import { getDirectorySyncState, saveDirectorySyncState } from "../src/db/directory.ts";
import { buildDirectoryMessages, DIRECTORY_RENDER_VERSION, syncDirectoryIfNeeded, syncPublicDirectory } from "../src/directory/sync.ts";

Deno.test("DIRECTORY RENDER — actual bot username and special names use explicit entities, never raw Markdown", async () => {
  const kv = await setupTestEnvironment();
  try {
    const names = ["Cathe.vill", "Anna_Lee [QC]", "Chloée 🎞️ & <Studio>"];
    const creators = await Promise.all(names.map((name, i) => seedCreator({ name, topicId: i + 1 })));
    const [message] = buildDirectoryMessages(creators, "UndergroundXVIP_bot", {
      collection: "regular", contentCounts: new Map(creators.map((c) => [c.id, 28])),
    });
    assertStringIncludes(message.text, "Rejoindre la plateforme");
    assert(!message.text.includes("https://"));
    const join = message.entities.find((e) => e.type === "text_link" && e.url.endsWith("?start=join"));
    assert(join?.type === "text_link");
    assertEquals(join.url, "https://t.me/UndergroundXVIP_bot?start=join");
    assertEquals(message.text.slice(join.offset, join.offset + join.length), "Rejoindre la plateforme");
    assert(!message.text.includes("?start=creator_"));
    assert(!message.text.includes("](https://"));
    assert(!message.text.includes("\\_"));
    for (const c of creators) {
      const entity = message.entities.find((e) => e.type === "text_link" && e.url.endsWith(`creator_${c.id}`));
      assert(entity && entity.type === "text_link");
      assertEquals(message.text.slice(entity.offset, entity.offset + entity.length), c.name);
      assertStringIncludes(entity.url, "UndergroundXVIP_bot?start=creator_");
      assertStringIncludes(message.text, `${c.name} (28)`);
    }
    assert(message.text.length < 350);
  } finally { await kv.close(); }
});

Deno.test("DIRECTORY RENDER — a clean old-format checkpoint is upgraded in the channel without waiting for daily sync", async () => {
  const kv = await setupTestEnvironment();
  try {
    setConfigForTesting({ ...MOCK_CONFIG, BOT_USERNAME: "UndergroundXVIP_bot" });
    await seedCreator({ name: "Cathe.vill", topicId: 1 });
    const api = new MockTelegramApi();
    await syncPublicDirectory(api);
    const state = await getDirectorySyncState();
    for (const slot of Object.values(state.collections!)) slot!.renderVersion = DIRECTORY_RENDER_VERSION - 1;
    await saveDirectorySyncState({ ...state, isDirty: false });
    const result = await syncDirectoryIfNeeded(api);
    assertEquals(result.updated, true);
    assertEquals(api.sentMessages.length, 2); // edits the original posts, no duplicate directory
    assertEquals(api.editedMessages.length, 2);
    for (const message of api.editedMessages) {
      const options = message.options as Record<string, unknown>;
      assertEquals(message.chatId, MOCK_CONFIG.PUBLIC_DIRECTORY_CHAT_ID);
      assertEquals(options.parse_mode, undefined);
      assert(Array.isArray(options.entities));
      assert(!message.text.includes("](https://"));
    }
    assertEquals((await syncDirectoryIfNeeded(api)).reason, "not_dirty");
    assertEquals(api.editedMessages.length, 2);
  } finally { await kv.close(); }
});

Deno.test("DIRECTORY RENDER — bot view reuses extra messages and admin publish buttons update the actual channel", async () => {
  const kv = await setupTestEnvironment();
  try {
    setConfigForTesting({ ...MOCK_CONFIG, BOT_USERNAME: "UndergroundXVIP_bot" });
    await seedCreator({ name: "Cathe.vill", topicId: 1 });
    await seedCreator({ name: "Retro Name", topicId: 2, collection: "retro" });
    const tg = await createFakeTelegram();
    const admin = MOCK_CONFIG.ADMIN_USER_IDS[0];
    const open = callback(admin, "dir:all");
    await tg.send(open);
    await tg.send(open);
    assertEquals(tg.callsOf("sendMessage").filter((c) => c.payload.chat_id === admin).length, 2);
    const views = tg.calls.filter((c) => c.method === "editMessageText" || c.method === "sendMessage");
    assertStringIncludes(JSON.stringify(views), "📢 Actualiser le canal");
    assertStringIncludes(JSON.stringify(views), "admin:sync_dir:regular");
    assertStringIncludes(JSON.stringify(views), "admin:sync_dir:retro");
    for (const view of views.filter((c) => String(c.payload.text).startsWith("Voici la liste"))) {
      assertEquals(view.payload.parse_mode, undefined);
      assert(Array.isArray(view.payload.entities));
    }
    tg.reset();
    await tg.send(callback(admin, "admin:sync_dir:regular"));
    let published = tg.callsOf("sendMessage").filter((c) => c.payload.chat_id === MOCK_CONFIG.PUBLIC_DIRECTORY_CHAT_ID);
    assertEquals(published.length, 1);
    assertStringIncludes(String(published[0].payload.text), "Cathe.vill");
    assert(!String(published[0].payload.text).includes("Retro Name"));
    tg.reset();
    await tg.send(callback(admin, "admin:sync_dir:retro"));
    published = tg.callsOf("sendMessage").filter((c) => c.payload.chat_id === MOCK_CONFIG.PUBLIC_DIRECTORY_CHAT_ID);
    assertEquals(published.length, 1);
    assertStringIncludes(String(published[0].payload.text), "Retro Name");
    assertEquals((await getDirectorySyncState()).isDirty, false);
  } finally { await kv.close(); }
});

Deno.test("DIRECTORY RENDER — undeletable legacy trailing posts are compacted without blocking channel repair", async () => {
  const kv = await setupTestEnvironment();
  try {
    await seedCreator({ name: "Aria", topicId: 1 });
    await saveDirectorySyncState({ publishedMessageIds: [11, 12], isDirty: false });
    class OldPostApi extends MockTelegramApi {
      async deleteMessage() { throw new Error("Bad Request: message can't be deleted"); }
    }
    const api = new OldPostApi();
    const result = await syncDirectoryIfNeeded(api);
    assertEquals(result.updated, true);
    assertStringIncludes(api.editedMessages.find((m) => m.messageId === 11)!.text, "Aria");
    const stale = api.editedMessages.find((m) => m.messageId === 12)!;
    assert(stale.text.length < 100);
    assert(!stale.text.includes("Aria"));
    const state = await getDirectorySyncState();
    assertEquals(state.lastError, undefined);
    assertEquals(state.isDirty, false);
    assertEquals(state.collections!.regular!.publishedMessageIds, [11]);
    assertEquals(state.collections!.regular!.renderVersion, DIRECTORY_RENDER_VERSION);
  } finally { await kv.close(); }
});

Deno.test("DIRECTORY RENDER — changing the destination channel never reuses another channel's message IDs", async () => {
  const kv = await setupTestEnvironment();
  try {
    await seedCreator({ name: "Aria", topicId: 1 });
    const api = new MockTelegramApi();
    await syncPublicDirectory(api);
    const channelId = -100987654321;
    setConfigForTesting({ ...MOCK_CONFIG, PUBLIC_DIRECTORY_CHAT_ID: channelId });
    assertEquals((await syncDirectoryIfNeeded(api)).updated, true);
    assertEquals(api.editedMessages.length, 0);
    assertEquals(api.sentMessages.slice(2).map((m) => m.chatId), [channelId, channelId]);
    assertEquals((await getDirectorySyncState()).collections!.regular!.channelId, channelId);
  } finally { await kv.close(); }
});

Deno.test("DIRECTORY SYNC — admin command updates both saved channel posts and returns direct links", async () => {
  const kv = await setupTestEnvironment();
  try {
    await seedCreator({ name: "Active creator", topicId: 1 });
    await seedCreator({ name: "Retro creator", topicId: 2, collection: "retro" });
    const tg = await createFakeTelegram();
    const admin = MOCK_CONFIG.ADMIN_USER_IDS[0];
    await tg.send(privateMessage(admin, "/sync_directory"));
    const state = await getDirectorySyncState();
    const channel = String(MOCK_CONFIG.PUBLIC_DIRECTORY_CHAT_ID).slice(4);
    const confirmation = tg.callsOf("sendMessage").find((c) => c.payload.chat_id === admin)!;
    const markup = JSON.stringify(confirmation.payload.reply_markup);
    for (const collection of ["regular", "retro"] as const) {
      assertStringIncludes(markup, `https://t.me/c/${channel}/${state.collections![collection]!.publishedMessageIds[0]}`);
    }
    assertStringIncludes(String(confirmation.payload.text), "Les deux répertoires");
    tg.reset();
    await tg.send(privateMessage(admin, "/sync_directory"));
    assertEquals(tg.callsOf("sendMessage").filter((c) => c.payload.chat_id === MOCK_CONFIG.PUBLIC_DIRECTORY_CHAT_ID).length, 0);
    assertEquals(tg.callsOf("editMessageText").filter((c) => c.payload.chat_id === MOCK_CONFIG.PUBLIC_DIRECTORY_CHAT_ID).length, 2);
    tg.reset();
    await tg.send(privateMessage(123456789, "/sync_directory"));
    assertEquals(tg.callsOf("editMessageText").length, 0);
    assertEquals(tg.callsOf("sendMessage").filter((c) => c.payload.chat_id === MOCK_CONFIG.PUBLIC_DIRECTORY_CHAT_ID).length, 0);
  } finally { await kv.close(); }
});

Deno.test("DIRECTORY COUNTS — legacy topic goes from unknown to indexed to verified through admin commands", async () => {
  const kv = await setupTestEnvironment();
  try {
    const creator = await seedCreator({ name: "onlyasians", topicId: 42, inventory: "partial" });
    const tg = await createFakeTelegram();
    const admin = MOCK_CONFIG.ADMIN_USER_IDS[0];
    await tg.send(callback(admin, "admin:directory_counts:0"));
    assertStringIncludes(JSON.stringify(tg.callsOf("editMessageText")), "onlyasians (?)");
    await tg.send(callback(admin, `admin:creator_inventory:${creator.id}`));
    assertStringIncludes(JSON.stringify(tg.callsOf("editMessageText")), `/index_media ${creator.id}`);
    await tg.send(privateMessage(admin, `/index_media onlyasians https://t.me/c/${String(creator.chatId).slice(4)}/42/50`));
    tg.reset();
    await tg.send(privateMessage(admin, "/sync_directory regular"));
    let post = tg.callsOf("sendMessage").find((c) => c.payload.chat_id === MOCK_CONFIG.PUBLIC_DIRECTORY_CHAT_ID)!;
    assertStringIncludes(String(post.payload.text), "onlyasians (1+)");
    await tg.send(privateMessage(admin, "/attest_inventory onlyasians"));
    tg.reset();
    await tg.send(privateMessage(admin, "/sync_directory regular"));
    post = tg.callsOf("editMessageText").find((c) => c.payload.chat_id === MOCK_CONFIG.PUBLIC_DIRECTORY_CHAT_ID)!;
    assertStringIncludes(String(post.payload.text), "onlyasians (1)");
    assert(!String(post.payload.text).includes("onlyasians (1+)"));
  } finally { await kv.close(); }
});

Deno.test("DIRECTORY SYNC — deleted active post is republished even when Retro already exists", async () => {
  const kv = await setupTestEnvironment();
  try {
    await seedCreator({ name: "Active creator", topicId: 1 });
    await seedCreator({ name: "Retro creator", topicId: 2, collection: "retro" });
    const api = new MockTelegramApi();
    await syncPublicDirectory(api);
    const original = await getDirectorySyncState();
    const edit = api.editMessageText.bind(api);
    api.editMessageText = (chat, id, text, options) => {
      if (id === original.collections!.regular!.publishedMessageIds[0]) throw new Error("Bad Request: message to edit not found");
      return edit(chat, id, text, options);
    };
    assertEquals((await syncPublicDirectory(api, true)).updated, true);
    const next = await getDirectorySyncState();
    assert(next.collections!.regular!.publishedMessageIds[0] !== original.collections!.regular!.publishedMessageIds[0]);
    assertEquals(next.collections!.retro!.publishedMessageIds, original.collections!.retro!.publishedMessageIds);
    assertStringIncludes(api.sentMessages.at(-1)!.text, "Active creator");
  } finally { await kv.close(); }
});

Deno.test("DIRECTORY DEPLOY — previews are health-only and cannot consume live Telegram updates", async () => {
  const { createPreviewFetchHandler, isLiveBotRuntime } = await import("../src/server.ts");
  assertEquals(isLiveBotRuntime(undefined), true);
  assertEquals(isLiveBotRuntime("production"), true);
  for (const timeline of ["preview/revision", "git-branch/main", "git-branch/fix/directory-sync-discovery"]) {
    assertEquals(isLiveBotRuntime(timeline), false);
  }
  const handler = createPreviewFetchHandler();
  assertEquals((await handler(new Request("https://preview.example/health"))).status, 200);
  assertEquals((await handler(new Request("https://preview.example/webhook", {
    method: "POST", headers: { "x-telegram-bot-api-secret-token": "live-secret" }, body: "{}",
  }))).status, 503);
});
