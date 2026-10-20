/**
 * LA CONFRÉRIE — UG-06 Pre-Publish Test Suite: LEGACY RANGE IMPORT & LARGE PUBLICATIONS
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { setupTestEnvironment } from "./test_helpers.ts";
import { MockMigrationApi, REGULAR_CHAT, RETRO_CHAT, seedCreator } from "./ug04_helpers.ts";
import { cb, harnessState, makeBot } from "./ug05_harness.ts";
import { cancelImport, continueAllImports, parseSourceLink, prepareImport, resumeImport, runImportStep, startImport, undoImport } from "../src/imports/service.ts";
import { getImportJob, updateImportJob, listImportDestIds } from "../src/db/imports.ts";
import { getCreator, getCreatorByTopic, listCreators } from "../src/db/creators.ts";
import { listMediaIndex } from "../src/db/media_index.ts";
import { addContributionItem, approveContribution, chunkContributionItems, continueAllPublishing, finishContribution, startContribution } from "../src/contributions/service.ts";
import { getContribution, transitionContribution } from "../src/db/contributions.ts";
import { getDirectorySyncState } from "../src/db/directory.ts";
import { getUserEntitlements } from "../src/db/entitlements.ts";

const ADMIN = 111111;
const SRC = -1001234567;
const link = (id: number) => `https://t.me/c/1234567/${id}`;

function srcApi() {
  const api = new MockMigrationApi();
  api.chats.set(SRC, { is_forum: false });
  return api;
}

// ------------------------------------------------------------------------------------------------

Deno.test("UG06 IMPORT — Links: private/topic/public forms parse; channel '?comment=' links are refused with guidance", () => {
  assertEquals(parseSourceLink("https://t.me/c/1234567/10"), { chat: -1001234567, messageId: 10 });
  assertEquals(parseSourceLink("https://t.me/c/1234567/99/10?thread=99"), { chat: -1001234567, messageId: 10 });
  assertEquals(parseSourceLink("https://t.me/tokebec_chat/77"), { chat: "@tokebec_chat", messageId: 77 });
  const bad = parseSourceLink("https://t.me/c/555/12?comment=40");
  assert("error" in bad && bad.error.includes("groupe de discussion"));
  assert("error" in parseSourceLink("https://example.com/x"));
  assert("error" in parseSourceLink("https://t.me/c/1234567"));
});

Deno.test("UG06 IMPORT — Prepare is a dry run: preview goes to the admin's private chat, nothing reaches the topic", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = srcApi();
    const c = await seedCreator({ name: "Aria", topicId: 101 });
    const res = await prepareImport(api, { adminId: ADMIN, creatorId: c.id, link1: link(500), link2: link(10), isNewCreator: false });
    assertEquals(res.ok, true);
    assertEquals(res.job!.status, "prepared");
    assertEquals([res.job!.fromId, res.job!.toId], [10, 500]); // order of the links does not matter
    assertEquals(res.job!.sourceTitle, undefined); // (mock chat has no title)
    // samples include both bounds and only go to the admin
    assertEquals(api.copyCalls.length, 1);
    assertEquals(api.copyCalls[0].to, ADMIN);
    assert(api.copyCalls[0].ids.includes(10) && api.copyCalls[0].ids.includes(500));
    assert(api.copyCalls.every((x) => x.to !== REGULAR_CHAT));
    assertEquals(api.deletedMessages.length, 0);
  } finally {
    await kv.close();
  }
});

Deno.test("UG06 IMPORT — Protected source, bot outside the source, mixed chats, huge spans and overlaps are all refused/blocked", async () => {
  const kv = await setupTestEnvironment();
  try {
    const c = await seedCreator({ name: "Aria", topicId: 101 });

    let api = srcApi();
    api.chats.set(SRC, { has_protected_content: true });
    let r = await prepareImport(api, { adminId: ADMIN, creatorId: c.id, link1: link(1), link2: link(9), isNewCreator: false });
    assertEquals(r.job!.status, "blocked");
    assertEquals(r.job!.blockedReason, "protected_content");
    assertEquals(api.copyCalls.length, 0); // not even a preview
    assertEquals((await startImport(api, r.job!.id, ADMIN, true)).ok, false);
    assertEquals(api.copyCalls.length, 0);

    api = srcApi();
    api.botRights[SRC] = {};
    api.getChatMember = async () => ({ status: "left" });
    r = await prepareImport(api, { adminId: ADMIN, creatorId: c.id, link1: link(1), link2: link(9), isNewCreator: false });
    assertEquals(r.job!.blockedReason, "bot_not_in_source");

    api = srcApi();
    r = await prepareImport(api, { adminId: ADMIN, creatorId: c.id, link1: link(1), link2: "https://t.me/c/999/5", isNewCreator: false });
    assertEquals(r.ok, false);
    r = await prepareImport(api, { adminId: ADMIN, creatorId: c.id, link1: link(1), link2: link(1_000_000), isNewCreator: false });
    assertEquals(r.ok, false);

    // Overlap with a live import is refused; after cancel it is allowed again
    const first = await prepareImport(api, { adminId: ADMIN, creatorId: c.id, link1: link(100), link2: link(200), isNewCreator: false });
    assertEquals(first.ok, true);
    const overlap = await prepareImport(api, { adminId: ADMIN, creatorId: c.id, link1: link(150), link2: link(300), isNewCreator: false });
    assertEquals(overlap.ok, false);
    assertStringIncludes(overlap.error!, "chevauche");
    await cancelImport(first.job!.id, ADMIN);
    assertEquals((await prepareImport(api, { adminId: ADMIN, creatorId: c.id, link1: link(150), link2: link(300), isNewCreator: false })).ok, true);
  } finally {
    await kv.close();
  }
});

Deno.test("UG06 IMPORT — Run: needs the rights confirmation, copies in 100-id batches, counts gaps, indexes the result", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = srcApi();
    const c = await seedCreator({ name: "Aria", topicId: 101, lastContentUpdatedAt: "2020-01-01T00:00:00Z" });
    for (const gap of [105, 106, 250]) api.missingMessageIds.add(gap);
    const { job } = await prepareImport(api, { adminId: ADMIN, creatorId: c.id, link1: link(1), link2: link(241), isNewCreator: false });
    api.copyCalls.length = 0;
    api.sentMessages.length = 0;

    assertEquals((await startImport(api, job!.id, ADMIN, false)).ok, false); // rights not confirmed
    assertEquals(api.copyCalls.length, 0);

    assertEquals((await startImport(api, job!.id, ADMIN, true)).ok, true);
    // 241 ids → batches of 100 / 100 / 41, all into the creator's topic, contiguous and ordered
    assertEquals(api.copyCalls.map((x) => x.ids.length), [100, 100, 41]);
    for (const call of api.copyCalls) {
      assertEquals(call.to, REGULAR_CHAT);
      assertEquals(call.from, SRC);
      assertEquals(call.thread, 101);
    }
    assertEquals(api.copyCalls.flatMap((x) => x.ids), Array.from({ length: 241 }, (_, i) => i + 1));

    const done = (await getImportJob(job!.id))!;
    assertEquals(done.status, "done");
    assertEquals(done.copied, 241 - 2); // 105,106 missing in range (250 is outside)
    assertEquals(done.skipped, 2);
    assertEquals((await listImportDestIds(job!.id)).length, 239);
    assertEquals((await listMediaIndex(c.id)).filter((e) => e.source === "import").length, 239);
    const after = (await getCreator(c.id))!;
    assertEquals(after.rightsStatus, "verified");
    assert(new Date(after.lastContentUpdatedAt!).getTime() > Date.parse("2020-01-01"));
    assertEquals((await getDirectorySyncState()).isDirty, true);
    // the administrator is told, with an undo button
    const note = api.sentMessages.find((m) => m.chatId === ADMIN)!;
    assertStringIncludes(note.text, "Import terminé");
    assertStringIncludes(JSON.stringify(note.options), `imp:undo:${job!.id}`);

    // Running again changes nothing
    api.copyCalls.length = 0;
    await runImportStep(api, job!.id);
    assertEquals(api.copyCalls.length, 0);
  } finally {
    await kv.close();
  }
});

Deno.test("UG06 IMPORT — Rate limit waits and resumes without re-copying; the cron continues it", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = srcApi();
    const c = await seedCreator({ name: "Aria", topicId: 101 });
    const { job } = await prepareImport(api, { adminId: ADMIN, creatorId: c.id, link1: link(1), link2: link(250), isNewCreator: false });
    api.copyCalls.length = 0;
    api.failNextCopies = { count: 1, error: { error_code: 429, description: "Too Many Requests", parameters: { retry_after: 30 } } };

    await startImport(api, job!.id, ADMIN, true);
    let j = (await getImportJob(job!.id))!;
    assertEquals(j.status, "running");
    assertEquals(j.copied, 0);
    assert((j.retryAfter ?? 0) > Date.now() + 20_000);
    const calls = api.copyCalls.length;

    // still waiting → cron does nothing
    assertEquals(await continueAllImports(api), 0);
    assertEquals(api.copyCalls.length, calls);

    await updateImportJob(job!.id, null, (x) => { x.retryAfter = Date.now() - 1; });
    assertEquals(await continueAllImports(api), 1);
    j = (await getImportJob(job!.id))!;
    assertEquals(j.status, "done");
    const all = api.copyCalls.slice(calls).flatMap((x) => x.ids);
    assertEquals(all, Array.from({ length: 250 }, (_, i) => i + 1)); // every id exactly once
  } finally {
    await kv.close();
  }
});

Deno.test("UG06 IMPORT — A failure stops safely; resume continues from the cursor with no duplicates", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = srcApi();
    const c = await seedCreator({ name: "Aria", topicId: 101 });
    const { job } = await prepareImport(api, { adminId: ADMIN, creatorId: c.id, link1: link(1), link2: link(300), isNewCreator: false });
    api.copyCalls.length = 0;
    let n = 0;
    const orig = api.copyMessages.bind(api);
    api.copyMessages = async (...args: Parameters<typeof orig>) => {
      n++;
      if (n === 2) throw new Error("Bad Request: boom");
      return orig(...args);
    };
    await startImport(api, job!.id, ADMIN, true);
    let j = (await getImportJob(job!.id))!;
    assertEquals(j.status, "failed");
    assertEquals(j.cursor, 101); // batch 1 done, batch 2 not
    api.copyMessages = orig;
    api.copyCalls.length = 0;
    await resumeImport(api, job!.id);
    j = (await getImportJob(job!.id))!;
    assertEquals(j.status, "done");
    assertEquals(api.copyCalls.flatMap((x) => x.ids), Array.from({ length: 200 }, (_, i) => i + 101)); // only the rest
    assertEquals(j.copied, 300);
  } finally {
    await kv.close();
  }
});

Deno.test("UG06 IMPORT — An interrupted batch is never re-copied blindly", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = srcApi();
    const c = await seedCreator({ name: "Aria", topicId: 101 });
    const { job } = await prepareImport(api, { adminId: ADMIN, creatorId: c.id, link1: link(1), link2: link(150), isNewCreator: false });
    // Simulate a crash after a batch was sent but before progress was saved
    await updateImportJob(job!.id, null, (x) => { x.status = "running"; x.inflight = { from: 1, to: 100 }; });
    api.copyCalls.length = 0;
    await runImportStep(api, job!.id);
    const j = (await getImportJob(job!.id))!;
    assertEquals(j.status, "needs_review");
    assertEquals(api.copyCalls.length, 0);
    assertStringIncludes(j.note!, "interrompu");
  } finally {
    await kv.close();
  }
});

Deno.test("UG06 IMPORT — Protected content found while copying blocks without any workaround", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = srcApi();
    const c = await seedCreator({ name: "Aria", topicId: 101 });
    const { job } = await prepareImport(api, { adminId: ADMIN, creatorId: c.id, link1: link(1), link2: link(50), isNewCreator: false });
    api.protectedAtCopyTime = true;
    await startImport(api, job!.id, ADMIN, true);
    const j = (await getImportJob(job!.id))!;
    assertEquals(j.status, "blocked");
    assertEquals(j.blockedReason, "protected_content");
    assertEquals(j.copied, 0);
  } finally {
    await kv.close();
  }
});

Deno.test("UG06 IMPORT — Undo removes exactly the bot's copies and nothing else", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = srcApi();
    const c = await seedCreator({ name: "Aria", topicId: 101 });
    const { job } = await prepareImport(api, { adminId: ADMIN, creatorId: c.id, link1: link(1), link2: link(120), isNewCreator: false });
    await startImport(api, job!.id, ADMIN, true);
    const dest = await listImportDestIds(job!.id);
    assertEquals(dest.length, 120);

    const res = await undoImport(api, job!.id, ADMIN);
    assertEquals(res.ok, true);
    assertEquals(res.deleted, 120);
    assertEquals(api.deletedMessages.map((d) => d.chatId), [REGULAR_CHAT, REGULAR_CHAT]);
    assertEquals(api.deletedMessages.flatMap((d) => d.ids).sort((a, b) => a - b), [...dest].sort((a, b) => a - b));
    assertEquals((await getImportJob(job!.id))!.status, "undone");
    assertEquals(api.deletedTopics.length, 0); // the topic itself is never deleted
    // the block can be imported again after an undo
    assertEquals((await prepareImport(api, { adminId: ADMIN, creatorId: c.id, link1: link(1), link2: link(120), isNewCreator: false })).ok, true);
  } finally {
    await kv.close();
  }
});

// -------------------------------- through the real bot ----------------------------------------

let updateSeq = 810000;
function topicCommand(chatId: number, userId: number, topicId: number, body: string, topicName: string | null) {
  const chat = { id: chatId, type: "supergroup" as const, title: "Forum", is_forum: true };
  return {
    update_id: updateSeq++,
    message: {
      message_id: 4000 + topicId,
      date: Math.floor(Date.now() / 1000),
      chat,
      from: { id: userId, is_bot: false, first_name: "U" },
      message_thread_id: topicId,
      is_topic_message: true,
      text: body,
      entities: [{ type: "bot_command" as const, offset: 0, length: body.split(" ")[0].length }],
      ...(topicName
        ? { reply_to_message: { message_id: topicId, date: 0, chat, message_thread_id: topicId, forum_topic_created: { name: topicName, icon_color: 0 } } }
        : {}),
    },
  };
}

Deno.test("UG06 IMPORT — /import in an unregistered Retro topic: new creator, private preview + confirmation, then done", async () => {
  const kv = await setupTestEnvironment();
  try {
    const { bot, calls } = makeBot();
    await bot.handleUpdate(topicCommand(RETRO_CHAT, ADMIN, 55, `/import ${link(10)} ${link(250)}`, "Nova") as never);

    const creator = await getCreatorByTopic(RETRO_CHAT, 55);
    assertEquals(creator?.name, "Nova");
    assertEquals(creator?.collection, "retro");
    // preview + confirm in the admin's PRIVATE chat; only a short note in the topic; nothing copied into the topic yet
    const dm = calls.find((c) => c.method === "sendMessage" && c.payload.chat_id === ADMIN)!;
    assertStringIncludes(String(dm.payload.text), "nouveau créateur");
    assertStringIncludes(String(dm.payload.text), "forum Retro");
    assertStringIncludes(JSON.stringify(dm.payload.reply_markup), "imp:go:");
    assertEquals(calls.some((c) => c.method === "copyMessages" && c.payload.chat_id === RETRO_CHAT), false);
    assertEquals(calls.filter((c) => c.method === "copyMessages" && c.payload.chat_id === ADMIN).length, 1);
    assertEquals((await listCreators()).length, 1);

    const jobId = JSON.stringify(dm.payload.reply_markup).match(/imp:go:([\w-]+)/)![1];

    // A non-admin cannot confirm
    calls.length = 0;
    await bot.handleUpdate(cb(5555, `imp:go:${jobId}`) as never);
    assertEquals(calls.some((c) => c.method === "copyMessages"), false);
    assertEquals((await getImportJob(jobId))!.status, "prepared");

    // The admin confirms → copied into the Retro topic in 3 batches, creator appears with content
    await bot.handleUpdate(cb(ADMIN, `imp:go:${jobId}`) as never);
    const topicCopies = calls.filter((c) => c.method === "copyMessages" && c.payload.chat_id === RETRO_CHAT);
    assertEquals(topicCopies.map((c) => (c.payload.message_ids as number[]).length), [100, 100, 41]);
    assertEquals(topicCopies[0].payload.message_thread_id, 55);
    assertEquals((await getImportJob(jobId))!.status, "done");
    const after = (await getCreator(creator!.id))!;
    assertEquals(after.hasContent, true);
    assertEquals(after.inventoryStatus, "complete");
    assertEquals(after.rightsStatus, "verified");
  } finally {
    await kv.close();
  }
});

Deno.test("UG06 IMPORT — /import on an existing creator updates it; protected sources and strangers are handled", async () => {
  const kv = await setupTestEnvironment();
  try {
    const existing = await seedCreator({ name: "Aria", topicId: 101 });
    const { bot, calls } = makeBot();

    // strangers: nothing at all
    await bot.handleUpdate(topicCommand(REGULAR_CHAT, 4242, 101, `/import ${link(1)} ${link(5)}`, "Aria") as never);
    assertEquals(calls.filter((c) => c.method === "sendMessage").length, 0);

    // existing creator → "mise à jour", same record
    await bot.handleUpdate(topicCommand(REGULAR_CHAT, ADMIN, 101, `/import ${link(1)} ${link(5)}`, "Aria") as never);
    const dm = calls.find((c) => c.method === "sendMessage" && c.payload.chat_id === ADMIN)!;
    assertStringIncludes(String(dm.payload.text), "mise à jour d'un créateur existant");
    assertEquals((await listCreators()).length, 1);
    assertEquals((await listCreators())[0].id, existing.id);

    // protected source → blocked message, no confirmation button
    harnessState.protectedSource = true;
    try {
      calls.length = 0;
      await bot.handleUpdate(topicCommand(REGULAR_CHAT, ADMIN, 101, `/import ${link(20)} ${link(25)}`, "Aria") as never);
      const blocked = calls.find((c) => c.method === "sendMessage" && c.payload.chat_id === ADMIN)!;
      assertStringIncludes(String(blocked.payload.text), "Bloqué");
      assert(!JSON.stringify(blocked.payload.reply_markup).includes("imp:go"));
      assertEquals(calls.filter((c) => c.method === "copyMessages").length, 0);
    } finally {
      harnessState.protectedSource = false;
    }

    // usage hint / wrong place
    calls.length = 0;
    await bot.handleUpdate(topicCommand(REGULAR_CHAT, ADMIN, 101, "/import", "Aria") as never);
    assertStringIncludes(JSON.stringify(calls.filter((c) => c.method === "sendMessage")), "Utilisation");
  } finally {
    await kv.close();
  }
});

// ------------------------- large contributions (shared publishing engine) ---------------------------

Deno.test("UG06 PUBLISH — Items are chunked into album-safe batches and never exceed Telegram's limit", () => {
  const items = Array.from({ length: 130 }, (_, i) => ({
    messageId: i + 1,
    kind: "photo" as const,
    mediaGroupId: i >= 48 && i < 53 ? "album" : undefined, // an album straddling the 50-boundary
  }));
  const batches = chunkContributionItems(items, 50);
  assert(batches.every((b) => b.length <= 100));
  assertEquals(batches.flat().length, 130);
  const albumBatches = batches.filter((b) => b.some((i) => i.mediaGroupId === "album"));
  assertEquals(albumBatches.length, 1); // album stays whole
  assertEquals(albumBatches[0].filter((i) => i.mediaGroupId === "album").length, 5);
});

Deno.test("UG06 PUBLISH — A large contribution is published in batches; failure mid-way resumes without duplicates; reward only at the end", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockMigrationApi();
    const c = await seedCreator({ name: "Aria", topicId: 101 });
    assert((await startContribution(7001, c.id)).ok);
    for (let i = 1; i <= 130; i++) await addContributionItem(7001, { messageId: i, kind: "photo" });
    const sub = (await finishContribution(api, 7001)).contribution!;
    api.copyCalls.length = 0;

    let n = 0;
    const orig = api.copyMessages.bind(api);
    api.copyMessages = async (...args: Parameters<typeof orig>) => {
      n++;
      if (n === 2) throw new Error("Bad Request: boom");
      return orig(...args);
    };
    const first = await approveContribution(api, sub.id, ADMIN, { type: "reward", scopes: ["regular"], days: 30 });
    assertEquals(first.ok, false);
    assertEquals((await getContribution(sub.id))!.status, "failed");
    assertEquals((await getContribution(sub.id))!.publishCursor, 50);
    assertEquals((await getUserEntitlements(7001)).filter((e) => e.source === "contribution").length, 0); // no reward yet

    api.copyMessages = orig;
    api.copyCalls.length = 0;
    const second = await approveContribution(api, sub.id, ADMIN, { type: "reward", scopes: ["regular"], days: 30 });
    assertEquals(second.ok, true);
    assertEquals(api.copyCalls.flatMap((x) => x.ids), Array.from({ length: 80 }, (_, i) => i + 51)); // only the remainder
    assertEquals((await getContribution(sub.id))!.status, "approved");
    assertEquals((await getContribution(sub.id))!.publishedMessageIds!.length, 130);
    assertEquals((await getUserEntitlements(7001)).filter((e) => e.source === "contribution").length, 1);
  } finally {
    await kv.close();
  }
});

Deno.test("UG06 PUBLISH — A rate limit pauses publication; the cron finishes it with nothing copied twice", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockMigrationApi();
    const c = await seedCreator({ name: "Aria", topicId: 101 });
    assert((await startContribution(7002, c.id)).ok);
    for (let i = 1; i <= 120; i++) await addContributionItem(7002, { messageId: i, kind: "photo" });
    const sub = (await finishContribution(api, 7002)).contribution!;
    api.copyCalls.length = 0;
    api.failNextCopies = { count: 1, error: { error_code: 429, description: "Too Many Requests", parameters: { retry_after: 30 } } };

    const res = await approveContribution(api, sub.id, ADMIN, { type: "reward", scopes: ["retro"], days: 10 });
    assertEquals(res.ok, true);
    assertEquals(res.inProgress, true);
    assertEquals((await getContribution(sub.id))!.status, "publishing");
    assertEquals(await continueAllPublishing(api), 0); // still waiting
    assertEquals((await getUserEntitlements(7002)).filter((e) => e.source === "contribution").length, 0);

    await transitionContribution(sub.id, ["publishing"], (x) => { x.retryAfter = Date.now() - 1; });
    assertEquals(await continueAllPublishing(api), 1);
    assertEquals((await getContribution(sub.id))!.status, "approved");
    // The rejected (429) attempt created nothing; every message was published exactly once.
    const done = (await getContribution(sub.id))!;
    assertEquals(done.publishedMessageIds!.length, 120);
    assertEquals(new Set(done.publishedMessageIds).size, 120);
    assertEquals((await getUserEntitlements(7002)).filter((e) => e.source === "contribution").length, 1);
  } finally {
    await kv.close();
  }
});

Deno.test("UG06 CANCEL — Every state has a way out: cancel before start, stop while running (keeps copies), undo (removes them)", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = srcApi();
    const c = await seedCreator({ name: "Aria", topicId: 101 });
    const { bot, calls } = makeBot();

    // 1) before confirming: the preview offers "Annuler" and nothing is ever copied
    const a = await prepareImport(api, { adminId: ADMIN, creatorId: c.id, link1: link(1), link2: link(50), isNewCreator: false });
    await bot.handleUpdate(cb(ADMIN, `imp:no:${a.job!.id}`) as never);
    assertEquals((await getImportJob(a.job!.id))!.status, "cancelled");
    assertEquals(api.copyCalls.filter((x) => x.to === REGULAR_CHAT).length, 0);
    // a stranger cannot cancel someone's import
    const b = await prepareImport(api, { adminId: ADMIN, creatorId: c.id, link1: link(1), link2: link(450), isNewCreator: false });
    await bot.handleUpdate(cb(5555, `imp:no:${b.job!.id}`) as never);
    assertEquals((await getImportJob(b.job!.id))!.status, "prepared");

    // 2) stop while running: the worker halts at the next batch; what was copied stays
    await updateImportJob(b.job!.id, null, (x) => { x.status = "running"; x.cursor = 201; x.copied = 200; x.batchesDone = 2; });
    await bot.handleUpdate(cb(ADMIN, `imp:st:${b.job!.id}`) as never);
    const shown = JSON.stringify(calls.filter((x) => x.method === "editMessageText").at(-1));
    for (const label of ["Arrêter", "Annuler et supprimer les copies", "Actualiser"]) assertStringIncludes(shown, label);
    await bot.handleUpdate(cb(ADMIN, `imp:stop:${b.job!.id}`) as never);
    assertEquals((await getImportJob(b.job!.id))!.status, "cancelled");
    api.copyCalls.length = 0;
    await runImportStep(api, b.job!.id); // a late cron tick must not copy anything
    assertEquals(api.copyCalls.length, 0);
    assertEquals(api.deletedMessages.length, 0); // "stop" never deletes
  } finally {
    await kv.close();
  }
});

Deno.test("UG06 CANCEL — Undo from the bot UI deletes the copies; /imports lists recent imports", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = srcApi();
    const c = await seedCreator({ name: "Aria", topicId: 101 });
    const { job } = await prepareImport(api, { adminId: ADMIN, creatorId: c.id, link1: link(1), link2: link(30), isNewCreator: false });
    await startImport(api, job!.id, ADMIN, true);
    assertEquals((await getImportJob(job!.id))!.status, "done");

    const { bot, calls } = makeBot();
    await bot.handleUpdate({ update_id: 9_100_001, message: { message_id: 1, date: 0, chat: { id: ADMIN, type: "private", first_name: "A" }, from: { id: ADMIN, is_bot: false, first_name: "A" }, text: "/imports", entities: [{ type: "bot_command", offset: 0, length: 8 }] } } as never);
    const listing = JSON.stringify(calls.filter((x) => x.method === "sendMessage").at(-1));
    assertStringIncludes(listing, "Aria");
    assertStringIncludes(listing, `imp:st:${job!.id}`);

    // non-admins get nothing from /imports
    calls.length = 0;
    await bot.handleUpdate({ update_id: 9_100_002, message: { message_id: 2, date: 0, chat: { id: 5555, type: "private", first_name: "X" }, from: { id: 5555, is_bot: false, first_name: "X" }, text: "/imports", entities: [{ type: "bot_command", offset: 0, length: 8 }] } } as never);
    assertEquals(calls.filter((x) => x.method === "sendMessage").length, 0);
  } finally {
    await kv.close();
  }
});

Deno.test("UG06 ROBUST — A stale unconfirmed preview never blocks a new attempt; a live overlap tells you where to look", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = srcApi();
    const c = await seedCreator({ name: "Aria", topicId: 101 });
    const first = await prepareImport(api, { adminId: ADMIN, creatorId: c.id, link1: link(1), link2: link(50), isNewCreator: false });

    // fresh preview → overlap refused with guidance
    const blocked = await prepareImport(api, { adminId: ADMIN, creatorId: c.id, link1: link(1), link2: link(50), isNewCreator: false });
    assertEquals(blocked.ok, false);
    assertStringIncludes(blocked.error!, "/imports");

    // the preview was never confirmed and is now old → it is retired automatically
    await updateImportJob(first.job!.id, null, (x) => { x.createdAt = new Date(Date.now() - 31 * 60_000).toISOString(); });
    const again = await prepareImport(api, { adminId: ADMIN, creatorId: c.id, link1: link(1), link2: link(50), isNewCreator: false });
    assertEquals(again.ok, true);
    assertEquals((await getImportJob(first.job!.id))!.status, "cancelled");
  } finally {
    await kv.close();
  }
});

Deno.test("UG06 ROBUST — A webhook request only does a short slice; the minute worker finishes the import", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = srcApi();
    const c = await seedCreator({ name: "Aria", topicId: 101 });
    const { job } = await prepareImport(api, { adminId: ADMIN, creatorId: c.id, link1: link(1), link2: link(350), isNewCreator: false });
    api.copyCalls.length = 0;
    await updateImportJob(job!.id, null, (x) => { x.status = "running"; });
    await runImportStep(api, job!.id, 0); // no time budget at all: nothing copied, nothing broken
    assertEquals(api.copyCalls.length, 0);
    assertEquals((await getImportJob(job!.id))!.status, "running");
    assertEquals((await getImportJob(job!.id))!.lockedUntil, undefined);

    assertEquals(await continueAllImports(api), 1); // the worker picks it up
    assertEquals((await getImportJob(job!.id))!.status, "done");
    assertEquals(api.copyCalls.flatMap((x) => x.ids), Array.from({ length: 350 }, (_, i) => i + 1));
  } finally {
    await kv.close();
  }
});

Deno.test("UG06 ROBUST — A rate-limit wait is shown with a countdown and can be retried immediately", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = srcApi();
    const c = await seedCreator({ name: "Aria", topicId: 101 });
    const { job } = await prepareImport(api, { adminId: ADMIN, creatorId: c.id, link1: link(1), link2: link(150), isNewCreator: false });
    api.failNextCopies = { count: 1, error: { error_code: 429, description: "Too Many Requests", parameters: { retry_after: 600 } } };
    await startImport(api, job!.id, ADMIN, true);

    const { bot, calls } = makeBot();
    await bot.handleUpdate(cb(ADMIN, `imp:st:${job!.id}`) as never);
    const shown = JSON.stringify(calls.filter((x) => x.method === "editMessageText").at(-1));
    assertStringIncludes(shown, "attendre environ 10 min");
    assertStringIncludes(shown, "Réessayer maintenant");

    await bot.handleUpdate(cb(5555, `imp:kick:${job!.id}`) as never); // strangers cannot
    assert(((await getImportJob(job!.id))!.retryAfter ?? 0) > Date.now());

    await bot.handleUpdate(cb(ADMIN, `imp:kick:${job!.id}`) as never);
    assertEquals((await getImportJob(job!.id))!.status, "done");
  } finally {
    await kv.close();
  }
});
