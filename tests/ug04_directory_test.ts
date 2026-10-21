/**
 * LA CONFRÉRIE — UG-04 Pre-Publish Test Suite: UNIFIED CREATOR DIRECTORY
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { MockTelegramApi, setupTestEnvironment } from "./test_helpers.ts";
import { RETRO_CHAT, REGULAR_CHAT, seedCreator } from "./ug04_helpers.ts";
import { buildDirectoryMessages, buildDirectorySections, syncPublicDirectory } from "../src/directory/sync.ts";
import { listCreators, getCreator, getCreatorByTopic } from "../src/db/creators.ts";
import { handleForumTopicCreated, handleMediaUpload } from "../src/creators/service.ts";
import { listMediaIndex, parseTopicMessageLink } from "../src/db/media_index.ts";
import { indexMediaFromLinks, repairDirectory } from "../src/creators/admin.ts";
import { getKv } from "../src/db/kv.ts";
import { getDirectorySyncState } from "../src/db/directory.ts";

Deno.test("UG04 DIRECTORY — Regular and Retro creators have separate compact alphabetical messages", async () => {
  const kv = await setupTestEnvironment();
  try {
    await seedCreator({ name: "Sophie", topicId: 1, collection: "regular", lastContentUpdatedAt: "2026-10-17T10:00:00Z" });
    await seedCreator({ name: "Maya", topicId: 2, collection: "retro", lastContentUpdatedAt: "2026-10-12T10:00:00Z" });
    await seedCreator({ name: "Aria", topicId: 3, collection: "regular", lastContentUpdatedAt: "2026-10-18T10:00:00Z" });

    const creators = await listCreators({ status: "active", hasContentOnly: true });
    const sections = buildDirectorySections(creators, "TestBot");
    assertEquals(sections.length, 2);
    const [regular, retro] = sections;
    assertStringIncludes(regular, "Voici la liste des créateurs toujours en activité");
    assertStringIncludes(retro, "Voici la liste des créateurs qui ne sont plus en activité");
    assertStringIncludes(regular, "https://t.me/TestBot?start=join");
    assert(!/underground/i.test(regular));
    assert(regular.indexOf("Aria") < regular.indexOf("Sophie"));
    assert(!regular.includes("Maya"));
    assertStringIncludes(retro, "Maya");
    assert(!retro.includes("Aria") && !retro.includes("Sophie"));
    assert(!regular.includes("oct. 2026"));

    // Filters
    const retroOnly = buildDirectorySections(creators, "TestBot", { collection: "retro" })[0];
    assertStringIncludes(retroOnly, "Maya");
    assert(!retroOnly.includes("Aria") && !retroOnly.includes("Sophie"));
    const regularOnly = buildDirectorySections(creators, "TestBot", { collection: "regular" })[0];
    assert(!regularOnly.includes("Maya"));
    assertEquals(await listCreators({ collection: "retro" }).then((l) => l.length), 1);
  } finally {
    await kv.close();
  }
});

Deno.test("UG04 DIRECTORY — Public directory exposes deep links only, never protected topic URLs", async () => {
  const kv = await setupTestEnvironment();
  try {
    const c = await seedCreator({ name: "Maya", topicId: 77, collection: "retro" });
    const text = buildDirectorySections([c], "TestBot", { collection: "retro" })[0];
    assert(buildDirectoryMessages([c], "TestBot", { collection: "retro" })[0].entities.some((e) => e.type === "text_link" && e.url === `https://t.me/TestBot?start=creator_${c.id}`));
    assert(!text.includes("t.me/c/"));
    assert(!text.includes("1001005")); // Retro forum chat id never appears
    assert(!text.includes("/77"));
  } finally {
    await kv.close();
  }
});

Deno.test("UG04 DIRECTORY — Daily synchronization covers both forums and detects changes", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockTelegramApi();
    await seedCreator({ name: "Aria", topicId: 1, collection: "regular" });
    const first = await syncPublicDirectory(api, true);
    assertEquals(first.updated, true);

    // Unchanged -> no redundant edit
    assertEquals((await syncPublicDirectory(api)).updated, false);

    // A Retro creator update makes the directory dirty and republishes
    await seedCreator({ name: "Maya", topicId: 2, collection: "retro" });
    const second = await syncPublicDirectory(api);
    assertEquals(second.updated, true);
    const published = [...api.editedMessages.map((m) => m.text), ...api.sentMessages.map((m) => m.text)].join("\n");
    assertStringIncludes(published, "Maya");
    assertStringIncludes(published, "qui ne sont plus en activité");
    assertEquals((await getDirectorySyncState()).isDirty, false);
  } finally {
    await kv.close();
  }
});

Deno.test("UG04 DIRECTORY — Retired creators leave the public directory but keep their record", async () => {
  const kv = await setupTestEnvironment();
  try {
    const c = await seedCreator({ name: "Old", topicId: 5, collection: "retro" });
    const retired = { ...c, retiredAt: "2020-01-01T00:00:00Z" };
    const text = buildDirectorySections([retired], "TestBot")[0];
    assert(!text.includes("Old"));
    assert((await getCreator(c.id)) !== null);
  } finally {
    await kv.close();
  }
});

Deno.test("UG04 DIRECTORY — A same-named topic in the Retro forum never creates a duplicate or overwrites the Regular record", async () => {
  const kv = await setupTestEnvironment();
  try {
    const regular = await seedCreator({ name: "Aria", topicId: 10 });
    const result = await handleForumTopicCreated(RETRO_CHAT, 600, "Aria");
    assertEquals(result?.id, regular.id);

    const all = await listCreators();
    assertEquals(all.length, 1);
    assertEquals(all[0].chatId, REGULAR_CHAT);
    assertEquals(all[0].topicId, 10);
    assertEquals(all[0].collection, "regular");
  } finally {
    await kv.close();
  }
});

Deno.test("UG04 DIRECTORY — New topics in the Retro forum register as Retro creators with tracked inventory", async () => {
  const kv = await setupTestEnvironment();
  try {
    const c = await handleForumTopicCreated(RETRO_CHAT, 700, "Nova");
    assertEquals(c?.collection, "retro");
    assertEquals(c?.inventoryStatus, "complete");
    assertEquals(c?.rightsStatus, "unverified");

    // Authorized uploads are indexed (IDs only); non-admin uploads are ignored
    assert(await handleMediaUpload(RETRO_CHAT, 700, 111111, undefined, { messageId: 55, kind: "photo", hasCaption: true }));
    assertEquals(await handleMediaUpload(RETRO_CHAT, 700, 424242, undefined, { messageId: 56, kind: "photo", hasCaption: false }), null);
    const idx = await listMediaIndex(c!.id);
    assertEquals(idx.map((e) => e.messageId), [55]);
    assertEquals((await getCreator(c!.id))?.hasContent, true);

    // Unmanaged chats are ignored
    assertEquals(await handleForumTopicCreated(-999, 1, "X"), null);
  } finally {
    await kv.close();
  }
});

Deno.test("UG04 INVENTORY — Message IDs are recorded for Regular uploads, ordered, with album ids", async () => {
  const kv = await setupTestEnvironment();
  try {
    const c = await handleForumTopicCreated(REGULAR_CHAT, 800, "Lena");
    await handleMediaUpload(REGULAR_CHAT, 800, 111111, undefined, { messageId: 12, kind: "photo", mediaGroupId: "g1", hasCaption: true });
    await handleMediaUpload(REGULAR_CHAT, 800, 111111, undefined, { messageId: 10, kind: "video", hasCaption: false });
    const idx = await listMediaIndex(c!.id);
    assertEquals(idx.map((e) => e.messageId), [10, 12]);
    assertEquals(idx[1].mediaGroupId, "g1");
    // Only metadata is stored — no file ids or media
    assert(!JSON.stringify(idx).match(/file_id|fileId|file_unique/i));
  } finally {
    await kv.close();
  }
});

Deno.test("UG04 INVENTORY — Manual indexing validates the topic in each message link", async () => {
  const kv = await setupTestEnvironment();
  try {
    const c = await seedCreator({ name: "Old", topicId: 101, inventory: "partial" });
    const own = "https://t.me/c/1001/101/55";
    const otherTopic = "https://t.me/c/1001/999/56";
    assertEquals(parseTopicMessageLink(own), { chatId: -1001001, topicId: 101, messageId: 55 });
    assertEquals(parseTopicMessageLink("https://example.com/x"), null);

    const res = await indexMediaFromLinks(111111, c, [own, own, otherTopic, "nonsense"]);
    assertEquals(res.added, 1);
    assertEquals(res.alreadyIndexed, 1);
    assertEquals(res.rejected.length, 2);
    assertEquals((await listMediaIndex(c.id)).map((e) => e.messageId), [55]);
  } finally {
    await kv.close();
  }
});

Deno.test("UG04 DIRECTORY — Repair rebuilds lookup indexes without duplicating creators", async () => {
  const kv = await setupTestEnvironment();
  try {
    const c = await seedCreator({ name: "Aria", topicId: 10 });
    const handle = await getKv();
    await handle.delete(["creators_by_topic", c.chatId, c.topicId]);
    assertEquals(await getCreatorByTopic(c.chatId, c.topicId), null);
    const report = await repairDirectory();
    assertEquals(report.indexesRepaired, 1);
    assertEquals((await getCreatorByTopic(c.chatId, c.topicId))?.id, c.id);
    assertEquals((await listCreators()).length, 1);
  } finally {
    await kv.close();
  }
});
