import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { MOCK_CONFIG, MockTelegramApi, setupTestEnvironment } from "./test_helpers.ts";
import { REGULAR_CHAT, seedCreator } from "./ug04_helpers.ts";
import { callback, createFakeTelegram, forumMessage } from "./bot_harness.ts";
import { getCreator, saveCreator, updateCreatorName } from "../src/db/creators.ts";
import { getDirectorySyncState, markDirectoryDirty, saveDirectorySyncState } from "../src/db/directory.ts";
import { recordMediaIndex } from "../src/db/media_index.ts";
import { buildDirectoryMessages, buildDirectorySections, directoryContentCounts, syncPublicDirectory } from "../src/directory/sync.ts";
import { syncDirectoryButtons } from "../src/navigation/service.ts";

Deno.test("DIRECTORY SPLIT — counts use current-topic items, deduplicate deliveries, and qualify incomplete inventories", async () => {
  const kv = await setupTestEnvironment();
  try {
    const exact = await seedCreator({ name: "Anna_Lee [QC]", topicId: 10, messageIds: [11, 12, 13], albums: [[11, 12]] });
    const partial = await seedCreator({ name: "Bella", topicId: 20, inventory: "partial", messageIds: [21, 22] });
    const unknown = await seedCreator({ name: "Cora", topicId: 30, inventory: "partial" });
    // Re-delivery is not another content item.
    await recordMediaIndex({ creatorId: exact.id, chatId: exact.chatId, topicId: exact.topicId, messageId: 11, kind: "photo", hasCaption: false, source: "live", recordedAt: new Date().toISOString() });
    // Metadata left behind at a previous location must never inflate this topic's count.
    await recordMediaIndex({ creatorId: exact.id, chatId: -1009999, topicId: 99, messageId: 100, kind: "video", hasCaption: false, source: "live", recordedAt: new Date().toISOString() });
    const creators = [exact, partial, unknown];
    const counts = await directoryContentCounts(creators);
    assertEquals(counts.get(exact.id), 3); // an album counts each photo/video
    const [text] = buildDirectorySections(creators, "TestBot", { collection: "regular", contentCounts: counts });
    assertStringIncludes(text, `Anna_Lee [QC] (3)`);
    assertStringIncludes(text, `Bella (2+)`);
    assertStringIncludes(text, `Cora (?)`);
    assert(!text.includes("t.me/c/"));
  } finally { await kv.close(); }
});

Deno.test("DIRECTORY SPLIT — scoped refreshes keep each other's messages and pending changes intact", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockTelegramApi();
    const regular = await seedCreator({ name: "Aria", topicId: 10, messageIds: [11] });
    const retro = await seedCreator({ name: "Maya", topicId: 20, collection: "retro", messageIds: [21] });
    await syncPublicDirectory(api);
    assertEquals(api.sentMessages.length, 2);
    assert(!api.sentMessages[0].text.includes("Maya"));
    assert(!api.sentMessages[1].text.includes("Aria"));
    assertStringIncludes(JSON.stringify(api.sentMessages[0].options), "dir:refresh:regular");
    assertStringIncludes(JSON.stringify(api.sentMessages[1].options), "dir:refresh:retro");
    const initial = (await getDirectorySyncState()).collections!;
    await updateCreatorName(regular.id, "Aria Updated");
    await updateCreatorName(retro.id, "Maya Updated");
    api.editedMessages.length = 0;
    await syncPublicDirectory(api, true, "regular");
    assertEquals(api.editedMessages.map((m) => m.messageId), initial.regular!.publishedMessageIds);
    assertEquals((await getDirectorySyncState()).isDirty, true);
    assertEquals((await getDirectorySyncState()).collections!.retro, initial.retro);
    api.editedMessages.length = 0;
    await syncPublicDirectory(api, true, "retro");
    assertEquals(api.editedMessages.map((m) => m.messageId), initial.retro!.publishedMessageIds);
    assertEquals((await getDirectorySyncState()).isDirty, false);
    assertEquals(api.sentMessages.length, 2);
    await syncDirectoryButtons(api, true);
    assertStringIncludes(JSON.stringify(api.editedMarkups[0].options), "dir:refresh:regular");
    assertStringIncludes(JSON.stringify(api.editedMarkups[1].options), "dir:refresh:retro");
  } finally { await kv.close(); }
});

Deno.test("DIRECTORY SPLIT — legacy combined messages are upgraded in place once", async () => {
  const kv = await setupTestEnvironment();
  try {
    await seedCreator({ name: "Aria", topicId: 10 });
    await seedCreator({ name: "Maya", topicId: 20, collection: "retro" });
    await saveDirectorySyncState({ publishedMessageIds: [55], isDirty: false, dirtySeq: 0 });
    const api = new MockTelegramApi();
    await syncPublicDirectory(api, true, "retro");
    assertEquals(api.editedMessages[0].messageId, 55);
    assertStringIncludes(api.editedMessages[0].text, "Aria");
    assert(!api.editedMessages[0].text.includes("Maya"));
    assertEquals(api.sentMessages.length, 1);
    assertStringIncludes(api.sentMessages[0].text, "Maya");
    assertEquals((await getDirectorySyncState()).collections!.regular!.publishedMessageIds, [55]);
    assertEquals((await syncPublicDirectory(api)).updated, false);
  } finally { await kv.close(); }
});

Deno.test("DIRECTORY SPLIT — large same-letter lists split between complete creator rows", async () => {
  const kv = await setupTestEnvironment();
  try {
    const c = await seedCreator();
    const creators = Array.from({ length: 250 }, (_, i) => ({ ...c, id: `creator_${i}`, name: `Anna ${String(i).padStart(3, "0")} with a long name` }));
    const sections = buildDirectorySections(creators, "TestBot", { collection: "regular" });
    assert(sections.length > 2);
    for (const text of sections) {
      assert(text.length <= 3500);
      assertStringIncludes(text, "Rejoindre la plateforme");
      assert(!text.includes("qui ne sont plus en activité"));
    }
    for (const creator of creators) {
      assertEquals(buildDirectoryMessages(creators, "TestBot", { collection: "regular" }).flatMap((m) => m.entities).filter((e) => e.type === "text_link" && e.url.endsWith(`creator_${creator.id}`)).length, 1);
    }
  } finally { await kv.close(); }
});

Deno.test("DIRECTORY SPLIT — interrupted publication checkpoints IDs and concurrent refreshes cannot duplicate posts", async () => {
  const kv = await setupTestEnvironment();
  try {
    const c = await seedCreator();
    for (let i = 0; i < 100; i++) {
      await saveCreator({ ...c, id: `c${i}`, name: `Anna ${i} with a long name`, normalizedName: `anna ${i}`, topicId: i + 100 });
    }
    const api = new MockTelegramApi();
    const send = api.sendMessage.bind(api);
    let attempts = 0;
    api.sendMessage = async (chat, text, options) => {
      assertEquals((await syncPublicDirectory(api, true)).reason, "sync_in_progress");
      if (++attempts === 2) {
        await markDirectoryDirty();
        throw new Error("Too Many Requests: retry after 3");
      }
      return await send(chat, text, options);
    };
    const failed = await syncPublicDirectory(api, true, "regular");
    assert(failed.error);
    assertEquals(api.sentMessages.length, 1);
    const failedState = await getDirectorySyncState();
    assertEquals(failedState.isDirty, true);
    assertStringIncludes(failedState.lastError!, "retry after");
    assertEquals(failedState.collections!.regular!.publishedMessageIds, [1]);
    api.sendMessage = send;
    await syncPublicDirectory(api, false, "regular");
    assertEquals(api.editedMessages[0].messageId, 1);
    assertEquals(api.sentMessages.filter((m) => m.text === api.sentMessages[0].text).length, 1);
    assertEquals((await getDirectorySyncState()).lastError, undefined);
  } finally { await kv.close(); }
});

Deno.test("DIRECTORY SPLIT — bot routes topic renames, separate admin buttons, and public refreshes correctly", async () => {
  const kv = await setupTestEnvironment();
  try {
    const regular = await seedCreator({ name: "Old Name", topicId: 10, messageIds: [11] });
    await seedCreator({ name: "Retro Name", topicId: 20, collection: "retro" });
    const telegram = await createFakeTelegram();
    await telegram.send(forumMessage(REGULAR_CHAT, MOCK_CONFIG.ADMIN_USER_IDS[0], regular.topicId, "topic_edited", { name: "New Name" }));
    assertEquals((await getCreator(regular.id))!.name, "New Name");
    await syncPublicDirectory(telegram.bot.api);
    telegram.reset();
    await telegram.send(callback(MOCK_CONFIG.ADMIN_USER_IDS[0], "admin:sync_dir_menu"));
    const menu = JSON.stringify(telegram.callsOf("editMessageText")[0].payload.reply_markup);
    assertStringIncludes(menu, "admin:sync_dir:regular");
    assertStringIncludes(menu, "admin:sync_dir:retro");
    telegram.reset();
    await telegram.send(callback(987654, "admin:sync_dir:retro"));
    assertEquals(telegram.callsOf("editMessageText").length, 0);
    await updateCreatorName(regular.id, "Latest Name");
    telegram.reset();
    const click = callback(987654, "dir:refresh:regular");
    Object.assign(click.callback_query.message.chat, { id: MOCK_CONFIG.PUBLIC_DIRECTORY_CHAT_ID, type: "channel" });
    await telegram.send(click);
    const edits = telegram.callsOf("editMessageText");
    assertEquals(edits.length, 1);
    assertStringIncludes(String(edits[0].payload.text), "Latest Name");
    assert(!String(edits[0].payload.text).includes("Retro Name"));
  } finally { await kv.close(); }
});
