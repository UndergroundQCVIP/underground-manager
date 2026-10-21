/**
 * LA CONFRÉRIE — UG-04 Pre-Publish Test Suite: REGULAR → RETRO MIGRATION
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { MOCK_CONFIG, setupTestEnvironment } from "./test_helpers.ts";
import { MockMigrationApi, pay, REGULAR_CHAT, RETRO_CHAT, seedCreator } from "./ug04_helpers.ts";
import { setConfigForTesting } from "../src/config.ts";
import {
  buildBatches,
  buildUnits,
  cancelMigration,
  confirmSourceDeletion,
  excludeUnresolvedItems,
  finalizeMigration,
  prepareMigration,
  reevaluateMigration,
  requestSourceDeletion,
  runMigrationStep,
  startMigration,
  verifyMigration,
} from "../src/migration/service.ts";
import { getMigrationJob, listMigrationItems, updateMigrationJob } from "../src/db/migrations.ts";
import { getCreator, listCreators, getCreatorByTopic } from "../src/db/creators.ts";
import { hasAccessToSpace } from "../src/db/entitlements.ts";
import { attestInventoryComplete, relinkCreatorToRetroTopic } from "../src/creators/admin.ts";
import { buildDirectorySections } from "../src/directory/sync.ts";
import { getDirectorySyncState } from "../src/db/directory.ts";
import { Creator } from "../src/types.ts";

const ADMIN = 111111;

/** 6 messages: 10, [11,12] album, 13, [14,15] album. */
async function seedStandard(opts: { inventory?: "complete" | "partial"; name?: string } = {}): Promise<Creator> {
  return await seedCreator({
    name: opts.name ?? "Aria",
    topicId: 101,
    messageIds: [10, 11, 12, 13, 14, 15],
    albums: [[11, 12], [14, 15]],
    inventory: opts.inventory ?? "complete",
  });
}

async function prepared(api: MockMigrationApi, creator: Creator) {
  const res = await prepareMigration(api, { creatorId: creator.id, adminId: ADMIN, rightsConfirmed: true });
  assert(res.ok && res.job, res.error);
  return res.job!;
}

async function runToCompletion(api: MockMigrationApi, jobId: string) {
  for (let i = 0; i < 20; i++) {
    const r = await runMigrationStep(api, jobId);
    if (r.status !== "copying") return r;
  }
  throw new Error("migration did not settle");
}

// --------------------------------------------------------------------------------------

Deno.test("UG04 MIGRATION — Albums are never split across batches and ordering is preserved", () => {
  const items = [10, 11, 12, 13, 14, 15].map((id) => ({
    sourceMessageId: id,
    kind: "photo" as const,
    mediaGroupId: [11, 12].includes(id) ? "a" : [14, 15].includes(id) ? "b" : undefined,
    hasCaption: false,
    status: "pending" as const,
    attempts: 0,
    updatedAt: "",
  }));
  const units = buildUnits(items);
  assertEquals(units.map((u) => u.messageIds), [[10], [11, 12], [13], [14, 15]]);
  assertEquals(buildBatches(units, 3), [[10, 11, 12], [13, 14, 15]]); // album [14,15] stays together
  assertEquals(buildBatches(units, 2), [[10], [11, 12], [13], [14, 15]]);
  assertEquals(buildBatches(units, 100), [[10, 11, 12, 13, 14, 15]]);
});

Deno.test("UG04 MIGRATION — Prepare requires rights confirmation and is a pure dry-run (nothing copied or created)", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockMigrationApi();
    const c = await seedStandard();

    const refused = await prepareMigration(api, { creatorId: c.id, adminId: ADMIN, rightsConfirmed: false });
    assertEquals(refused.ok, false);

    const job = await prepared(api, c);
    assertEquals(job.status, "prepared");
    assertEquals(job.dryRun, true);
    assertEquals(job.preflight?.ok, true);
    assertEquals(job.totals.items, 6);
    assertEquals(job.totals.albums, 2);
    assertEquals(api.copyCalls.length, 0);
    assertEquals(api.createdTopics.length, 0);
    assertEquals(api.deletedTopics.length, 0);

    const after = await getCreator(c.id);
    assertEquals(after?.rightsStatus, "verified");
    assertEquals(after?.chatId, REGULAR_CHAT); // untouched
    assertEquals(after?.collection, "regular");
  } finally {
    await kv.close();
  }
});

Deno.test("UG04 MIGRATION — Unindexed/legacy media is flagged and blocks the migration until accounted for", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockMigrationApi();

    // No inventory at all
    const empty = await seedCreator({ name: "Empty", topicId: 1, messageIds: [], inventory: "partial" });
    const j1 = await prepared(api, empty);
    assertEquals(j1.status, "blocked");
    assertEquals(j1.blockedReason, "no_inventory");

    // Partial inventory of an older collection
    const legacy = await seedCreator({ name: "Legacy", topicId: 2, messageIds: [5, 6], inventory: "partial" });
    const j2 = await prepared(api, legacy);
    assertEquals(j2.status, "blocked");
    assertEquals(j2.preflight?.blockers.some((b) => b.reason === "incomplete_inventory"), true);
    const started = await startMigration(api, j2.id, ADMIN);
    assertEquals(started.ok, false);
    assertEquals(api.copyCalls.length, 0);
    assertEquals(api.createdTopics.length, 0);

    // Administrator attests after manual indexing -> becomes ready
    await attestInventoryComplete(ADMIN, (await getCreator(legacy.id))!);
    const j3 = await prepareMigration(api, { creatorId: legacy.id, adminId: ADMIN, rightsConfirmed: true });
    assertEquals(j3.job?.status, "prepared");
  } finally {
    await kv.close();
  }
});

Deno.test("UG04 MIGRATION — Retro forum unconfigured blocks safely", async () => {
  const kv = await setupTestEnvironment();
  try {
    setConfigForTesting({ ...MOCK_CONFIG, TELEGRAM_RETRO_FORUM_CHAT_ID: 0 });
    const api = new MockMigrationApi();
    const job = await prepared(api, await seedStandard());
    assertEquals(job.status, "blocked");
    assertEquals(job.blockedReason, "retro_not_configured");
  } finally {
    await kv.close();
  }
});

Deno.test("UG04 MIGRATION — Protected source forum blocks copy; bot neither bypasses nor disables protection", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockMigrationApi();
    api.chats.set(REGULAR_CHAT, { is_forum: true, has_protected_content: true });
    const c = await seedStandard();
    const job = await prepared(api, c);
    assertEquals(job.status, "blocked");
    assertEquals(job.blockedReason, "protected_content");

    const started = await startMigration(api, job.id, ADMIN);
    assertEquals(started.ok, false);
    assertEquals(api.copyCalls.length, 0);
    assertEquals(api.createdTopics.length, 0);
    assertEquals((await getCreator(c.id))?.chatId, REGULAR_CHAT);
  } finally {
    await kv.close();
  }
});

Deno.test("UG04 MIGRATION — Telegram rejecting the copy as protected stops safely with nothing marked copied", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockMigrationApi();
    const c = await seedStandard();
    const job = await prepared(api, c);
    api.protectedAtCopyTime = true;

    const started = await startMigration(api, job.id, ADMIN);
    assertEquals(started.ok, true);
    const run = await runMigrationStep(api, job.id);
    assertEquals(run.reason, "blocked");

    const after = (await getMigrationJob(job.id))!;
    assertEquals(after.status, "blocked");
    assertEquals(after.blockedReason, "protected_content");
    assertStringIncludes(after.notes.join(" "), "ne la contourne ni ne la désactive");
    assertEquals(after.totals.copied, 0);
    assertEquals(api.copyCalls.length, 1); // one rejected probe batch, then stop
    assertEquals(api.deletedTopics.length, 0);
    const creator = await getCreator(c.id);
    assertEquals(creator?.chatId, REGULAR_CHAT);
    assertEquals(creator?.collection, "regular");
  } finally {
    await kv.close();
  }
});

Deno.test("UG04 MIGRATION — Full flow: copy, verify, approve, finalize; same creator record; nothing deleted", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockMigrationApi();
    const c = await seedStandard();
    const job = await prepared(api, c);
    assertEquals((await startMigration(api, job.id, ADMIN)).ok, true);

    // Destination topic created once in the Retro forum, id persisted before copying
    assertEquals(api.createdTopics.length, 1);
    assertEquals(api.createdTopics[0].chatId, RETRO_CHAT);
    assertEquals(api.createdTopics[0].name, "Aria");

    const result = await runToCompletion(api, job.id);
    assertEquals(result.status, "ready_to_finalize");

    // Copies target the Retro topic, from the Regular forum, in ascending order, albums intact
    const topicId = api.createdTopics[0].id;
    for (const call of api.copyCalls) {
      assertEquals(call.to, RETRO_CHAT);
      assertEquals(call.from, REGULAR_CHAT);
      assertEquals(call.thread, topicId);
      assertEquals([...call.ids].sort((a, b) => a - b), call.ids);
    }
    const flat = api.copyCalls.flatMap((c) => c.ids);
    assertEquals(flat, [10, 11, 12, 13, 14, 15]);
    for (const call of api.copyCalls) {
      // an album is never split
      assertEquals(call.ids.includes(11) === call.ids.includes(12), true);
      assertEquals(call.ids.includes(14) === call.ids.includes(15), true);
    }

    const items = await listMigrationItems(job.id);
    assertEquals(items.every((i) => i.status === "copied" && i.destMessageId !== undefined), true);
    assertEquals(new Set(items.map((i) => i.destMessageId)).size, 6);

    // Not finalized yet: directory and creator unchanged
    assertEquals((await getCreator(c.id))?.chatId, REGULAR_CHAT);

    const v = await verifyMigration(api, job.id);
    assertEquals(v.ok, true);
    assertEquals(v.albumsPreserved, 2);
    assertEquals(v.destinationTopicOk, true);

    const fin = await finalizeMigration(api, job.id, ADMIN);
    assertEquals(fin.ok, true);

    const after = (await getCreator(c.id))!;
    assertEquals(after.id, c.id); // stable internal creator ID
    assertEquals(after.collection, "retro");
    assertEquals(after.chatId, RETRO_CHAT);
    assertEquals(after.topicId, topicId);
    assertEquals(after.lastContentUpdatedAt, c.lastContentUpdatedAt); // timestamp preserved
    assertEquals((await listCreators()).length, 1); // no duplicate entries
    assertEquals(await getCreatorByTopic(REGULAR_CHAT, 101), null);
    assertEquals((await getCreatorByTopic(RETRO_CHAT, topicId))?.id, c.id);

    // Directory now says Retro, with the same deep link
    const listing = buildDirectorySections(await listCreators(), "TestBot", { collection: "retro" })[0];
    assertStringIncludes(listing, "*qui ne sont plus en activité*");
    assertStringIncludes(listing, "[Aria]");
    assertStringIncludes(listing, `creator_${c.id}`);
    assertEquals((await getDirectorySyncState()).isDirty, true);

    // Source topic was never deleted by finalization
    assertEquals(api.deletedTopics.length, 0);
    assertEquals((await getMigrationJob(job.id))?.status, "finalized");

    // Finalize is idempotent
    assertEquals((await finalizeMigration(api, job.id, ADMIN)).ok, true);
  } finally {
    await kv.close();
  }
});

Deno.test("UG04 MIGRATION — Partial failure → needs review; resume retries ONLY failed items (no duplicate copies)", async () => {
  const kv = await setupTestEnvironment();
  try {
    setConfigForTesting({ ...MOCK_CONFIG, MIGRATION_BATCH_SIZE: 3 });
    const api = new MockMigrationApi();
    const c = await seedStandard();
    const job = await prepared(api, c);
    await startMigration(api, job.id, ADMIN);

    // 2nd batch ([13,14,15]) fails 3 times in a row (also trips the consecutive-failure stop)
    let call = 0;
    const origCopy = api.copyMessages.bind(api);
    api.copyMessages = async (...args: Parameters<typeof origCopy>) => {
      call++;
      if (call >= 2 && call <= 4) throw new Error("Bad Request: temporary failure");
      return origCopy(...args);
    };

    const r = await runToCompletion(api, job.id);
    assertEquals(r.status, "needs_review");
    let items = await listMigrationItems(job.id);
    assertEquals(items.filter((i) => i.status === "copied").map((i) => i.sourceMessageId), [10, 11, 12]);
    assertEquals(items.filter((i) => i.status === "failed").map((i) => i.sourceMessageId), [13, 14, 15]);

    // Cannot finalize an incomplete migration
    assertEquals((await finalizeMigration(api, job.id, ADMIN)).ok, false);
    assertEquals((await getCreator(c.id))?.chatId, REGULAR_CHAT);

    // Resume (service healthy again)
    api.copyMessages = origCopy;
    const before = api.copyCalls.length;
    assertEquals((await startMigration(api, job.id, ADMIN)).ok, true);
    const done = await runToCompletion(api, job.id);
    assertEquals(done.status, "ready_to_finalize");

    // Already-verified items were not copied again
    const recopied = api.copyCalls.slice(before).flatMap((c) => c.ids);
    assertEquals(recopied, [13, 14, 15]);
    items = await listMigrationItems(job.id);
    assertEquals(new Set(items.map((i) => i.destMessageId)).size, 6);
    assertEquals((await finalizeMigration(api, job.id, ADMIN)).ok, true);
  } finally {
    await kv.close();
  }
});

Deno.test("UG04 MIGRATION — Missing source messages are flagged ambiguous, never auto-retried, and block finalization until reviewed", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockMigrationApi();
    const c = await seedStandard();
    api.missingMessageIds.add(13); // deleted in Telegram, but still in our inventory
    const job = await prepared(api, c);
    await startMigration(api, job.id, ADMIN);

    const r = await runToCompletion(api, job.id);
    assertEquals(r.status, "needs_review");
    const items = await listMigrationItems(job.id);
    assertEquals(items.every((i) => i.status === "ambiguous"), true); // single batch: attribution impossible
    const callsAfterFirstRun = api.copyCalls.length;

    // Resuming must not re-copy ambiguous items (duplicate risk)
    await startMigration(api, job.id, ADMIN);
    await runMigrationStep(api, job.id);
    assertEquals(api.copyCalls.length, callsAfterFirstRun);

    assertEquals((await finalizeMigration(api, job.id, ADMIN)).ok, false);
    assertEquals((await getCreator(c.id))?.collection, "regular");

    // Administrator reviews the Retro topic and explicitly accepts the gap
    const n = await excludeUnresolvedItems(job.id, ADMIN, "message 13 was deleted; other copies reviewed manually");
    assertEquals(n, 6);
    const re = await reevaluateMigration(api, job.id);
    assertEquals(re.status, "ready_to_finalize");
    assertStringIncludes(re.notes.join(" "), "exclu 6");
  } finally {
    await kv.close();
  }
});

Deno.test("UG04 MIGRATION — Completely uncopyable batch (nothing copied) is retryable, not ambiguous", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockMigrationApi();
    const c = await seedCreator({ name: "Solo", topicId: 9, messageIds: [20, 21], inventory: "complete" });
    api.missingMessageIds.add(20);
    api.missingMessageIds.add(21);
    const job = await prepared(api, c);
    await startMigration(api, job.id, ADMIN);
    await runToCompletion(api, job.id);
    const items = await listMigrationItems(job.id);
    assertEquals(items.every((i) => i.status === "failed"), true);
  } finally {
    await kv.close();
  }
});

Deno.test("UG04 MIGRATION — Rate limit (429) pauses with backoff and resumes without duplicates", async () => {
  const kv = await setupTestEnvironment();
  try {
    setConfigForTesting({ ...MOCK_CONFIG, MIGRATION_BATCH_SIZE: 3 });
    const api = new MockMigrationApi();
    const c = await seedStandard();
    const job = await prepared(api, c);
    await startMigration(api, job.id, ADMIN);
    api.failNextCopies = { count: 1, error: { error_code: 429, description: "Too Many Requests", parameters: { retry_after: 30 } } };

    const first = await runMigrationStep(api, job.id);
    assertEquals(first.reason, "rate_limited");
    let state = (await getMigrationJob(job.id))!;
    assertEquals(state.status, "copying");
    assert((state.nextRunAfter ?? 0) > Date.now() + 20_000);
    assertEquals(state.totals.copied, 0);

    // While backing off nothing is sent
    const calls = api.copyCalls.length;
    const during = await runMigrationStep(api, job.id);
    assertEquals(during.reason, "rate_limited");
    assertEquals(api.copyCalls.length, calls);

    // After the wait, it resumes and finishes
    await updateMigrationJob(job.id, (j) => {
      j.nextRunAfter = Date.now() - 1;
    });
    const done = await runToCompletion(api, job.id);
    assertEquals(done.status, "ready_to_finalize");
    const items = await listMigrationItems(job.id);
    assertEquals(new Set(items.map((i) => i.destMessageId)).size, 6);
  } finally {
    await kv.close();
  }
});

Deno.test("UG04 MIGRATION — Interrupted migration resumes from where it stopped (pause / resume)", async () => {
  const kv = await setupTestEnvironment();
  try {
    setConfigForTesting({ ...MOCK_CONFIG, MIGRATION_BATCH_SIZE: 2 });
    const api = new MockMigrationApi();
    const c = await seedStandard();
    const job = await prepared(api, c);
    await startMigration(api, job.id, ADMIN);

    const part = await runMigrationStep(api, job.id, { maxBatches: 1 });
    assertEquals(part.batchesRun, 1);
    assertEquals((await getMigrationJob(job.id))!.totals.copied, 1); // first unit [10]
    const copiedSoFar = api.copyCalls.flatMap((c) => c.ids);

    // "Crash": simply run again (new process) — continues, never re-sends copied ids
    const done = await runToCompletion(api, job.id);
    assertEquals(done.status, "ready_to_finalize");
    const all = api.copyCalls.flatMap((c) => c.ids);
    assertEquals(all, [10, 11, 12, 13, 14, 15]);
    assertEquals(all.slice(0, copiedSoFar.length), copiedSoFar);
  } finally {
    await kv.close();
  }
});

Deno.test("UG04 MIGRATION — Duplicate concurrent execution is prevented by the job lease; duplicate prepare reuses the job", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockMigrationApi();
    api.delayMs = 15;
    const c = await seedStandard();
    const job = await prepared(api, c);

    const again = await prepareMigration(api, { creatorId: c.id, adminId: ADMIN, rightsConfirmed: true });
    assertEquals(again.job?.id, job.id); // no second job

    await startMigration(api, job.id, ADMIN);
    const [a, b] = await Promise.all([runMigrationStep(api, job.id), runMigrationStep(api, job.id)]);
    assertEquals([a.reason, b.reason].includes("locked"), true);

    const all = api.copyCalls.flatMap((c) => c.ids);
    assertEquals(all.length, new Set(all).size); // no source message copied twice
    assertEquals((await getMigrationJob(job.id))!.lockedUntil, undefined); // lease released

    // Once running, a second "prepare" is refused instead of creating another job
    const refused = await prepareMigration(api, { creatorId: c.id, adminId: ADMIN, rightsConfirmed: true });
    assertEquals(refused.ok, false);
  } finally {
    await kv.close();
  }
});

Deno.test("UG04 MIGRATION — Cancel leaves the source topic and creator record untouched", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockMigrationApi();
    const c = await seedStandard();
    const job = await prepared(api, c);
    await startMigration(api, job.id, ADMIN);
    await runMigrationStep(api, job.id, { maxBatches: 1 });

    assertEquals((await cancelMigration(job.id, ADMIN)).ok, true);
    assertEquals((await getMigrationJob(job.id))?.status, "cancelled");
    const creator = await getCreator(c.id);
    assertEquals(creator?.chatId, REGULAR_CHAT);
    assertEquals(creator?.topicId, 101);
    assertEquals(creator?.collection, "regular");
    assertEquals(api.deletedTopics.length, 0);

    // A cancelled job frees the creator for a fresh migration
    const again = await prepareMigration(api, { creatorId: c.id, adminId: ADMIN, rightsConfirmed: true });
    assertEquals(again.ok, true);
    assert(again.job!.id !== job.id);
  } finally {
    await kv.close();
  }
});

Deno.test("UG04 MIGRATION — Source topic is NEVER deleted automatically; deletion needs two explicit confirmations", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockMigrationApi();
    const c = await seedStandard();
    const job = await prepared(api, c);
    await startMigration(api, job.id, ADMIN);
    await runToCompletion(api, job.id);

    // Not even requestable before finalization
    assertEquals((await requestSourceDeletion(job.id, ADMIN, true)).ok, false);
    await finalizeMigration(api, job.id, ADMIN);
    assertEquals(api.deletedTopics.length, 0);

    // Confirm without a prior review request
    assertEquals((await confirmSourceDeletion(api, job.id, ADMIN)).ok, false);
    // Request without the "manually reviewed" attestation
    assertEquals((await requestSourceDeletion(job.id, ADMIN, false)).ok, false);
    assertEquals(api.deletedTopics.length, 0);

    // Step 1: shows exact source forum/topic/results
    const req = await requestSourceDeletion(job.id, ADMIN, true);
    assertEquals(req.ok, true);
    assertEquals(req.summary?.sourceChatId, REGULAR_CHAT);
    assertEquals(req.summary?.sourceTopicId, 101);
    assertEquals(req.summary?.copied, 6);
    assertEquals(api.deletedTopics.length, 0);

    // Expired confirmation window is refused
    await updateMigrationJob(job.id, (j) => {
      j.deletionRequestedAt = new Date(Date.now() - 11 * 60_000).toISOString();
    });
    assertEquals((await confirmSourceDeletion(api, job.id, ADMIN)).ok, false);
    assertEquals(api.deletedTopics.length, 0);

    // Fresh request + explicit confirm deletes exactly the source topic, records who/when
    await requestSourceDeletion(job.id, 222222, true);
    assertEquals((await confirmSourceDeletion(api, job.id, 222222)).ok, true);
    assertEquals(api.deletedTopics, [{ chatId: REGULAR_CHAT, topicId: 101 }]);
    const done = (await getMigrationJob(job.id))!;
    assertEquals(done.status, "source_deleted");
    assertEquals(done.sourceDeletedBy, 222222);
    assert(done.sourceDeletedAt);

    // Creator keeps pointing at the Retro topic; record survives
    assertEquals((await getCreator(c.id))?.collection, "retro");
    assertEquals((await listCreators()).length, 1);
  } finally {
    await kv.close();
  }
});

Deno.test("UG04 MIGRATION — Deletion is refused while discrepancies remain", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockMigrationApi();
    const c = await seedStandard();
    const job = await prepared(api, c);
    await startMigration(api, job.id, ADMIN);
    await runToCompletion(api, job.id);
    await finalizeMigration(api, job.id, ADMIN);

    // Tamper: an item regresses to failed after finalization
    const items = await listMigrationItems(job.id);
    const { saveMigrationItem } = await import("../src/db/migrations.ts");
    await saveMigrationItem(job.id, { ...items[0], status: "failed" });

    assertEquals((await requestSourceDeletion(job.id, ADMIN, true)).ok, false);
    assertEquals(api.deletedTopics.length, 0);
  } finally {
    await kv.close();
  }
});

Deno.test("UG04 MIGRATION — Finalization re-verifies and refuses a stale 'ready' state", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockMigrationApi();
    const c = await seedStandard();
    const job = await prepared(api, c);
    await startMigration(api, job.id, ADMIN);
    await runToCompletion(api, job.id);
    assertEquals((await getMigrationJob(job.id))!.status, "ready_to_finalize");

    const items = await listMigrationItems(job.id);
    const { saveMigrationItem } = await import("../src/db/migrations.ts");
    await saveMigrationItem(job.id, { ...items[2], status: "pending" });

    const fin = await finalizeMigration(api, job.id, ADMIN);
    assertEquals(fin.ok, false);
    assertEquals((await getMigrationJob(job.id))!.status, "needs_review");
    assertEquals((await getCreator(c.id))?.chatId, REGULAR_CHAT);
  } finally {
    await kv.close();
  }
});

Deno.test("UG04 MIGRATION — Access restrictions stay intact throughout; Regular members keep the original until it is removed", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockMigrationApi();
    await pay(8001, "regular", "ch_m_reg");
    await pay(8002, "retro_plus", "ch_m_retro");
    const c = await seedStandard();

    const check = async () => {
      assertEquals(await hasAccessToSpace(8001, "retro_collections"), false);
      assertEquals(await hasAccessToSpace(8001, "vip_collections"), true);
      assertEquals(await hasAccessToSpace(8002, "retro_collections"), true);
    };
    await check();
    const job = await prepared(api, c);
    await check();
    await startMigration(api, job.id, ADMIN);
    await check();
    await runToCompletion(api, job.id);
    await check();
    await finalizeMigration(api, job.id, ADMIN);
    await check(); // creator moved, entitlements unchanged: Regular STILL cannot get Retro
  } finally {
    await kv.close();
  }
});

Deno.test("UG04 MIGRATION — Directory stays consistent after a failed migration", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockMigrationApi();
    const c = await seedStandard();
    const job = await prepared(api, c);
    await startMigration(api, job.id, ADMIN);
    api.failNextCopies = { count: 99, error: new Error("Bad Request: boom") };
    await runToCompletion(api, job.id);
    assertEquals((await getMigrationJob(job.id))!.status, "needs_review");

    const listing = buildDirectorySections(await listCreators({ status: "active", hasContentOnly: true }), "TestBot")[0];
    assertStringIncludes(listing, "*toujours en activité*");
    assertStringIncludes(listing, "[Aria]");
    assertEquals((await listCreators()).length, 1);
    assertEquals((await getCreator(c.id))?.chatId, REGULAR_CHAT);
  } finally {
    await kv.close();
  }
});

Deno.test("UG04 MIGRATION — Bot lacking Retro rights is blocked with a precise reason", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockMigrationApi();
    api.botRights[RETRO_CHAT] = { can_manage_topics: false };
    const job = await prepared(api, await seedStandard());
    assertEquals(job.status, "blocked");
    assertEquals(job.blockedReason, "missing_permissions");
    assertStringIncludes(job.preflight!.blockers[0].detail, "Gérer les sujets");
  } finally {
    await kv.close();
  }
});

Deno.test("UG04 MIGRATION — Republishing fallback relinks the SAME creator to a manually built Retro topic", async () => {
  const kv = await setupTestEnvironment();
  try {
    const c = await seedStandard();

    // Rights must be verified first
    assertEquals((await relinkCreatorToRetroTopic(ADMIN, c, 650)).ok, false);

    const api = new MockMigrationApi();
    api.chats.set(REGULAR_CHAT, { is_forum: true, has_protected_content: true });
    await prepared(api, c); // verifies rights, blocks on protection
    const refreshed = (await getCreator(c.id))!;
    const res = await relinkCreatorToRetroTopic(ADMIN, refreshed, 650);
    assertEquals(res.ok, true);
    const after = (await getCreator(c.id))!;
    assertEquals(after.id, c.id);
    assertEquals(after.chatId, RETRO_CHAT);
    assertEquals(after.topicId, 650);
    assertEquals((await listCreators()).length, 1);

    // Retro topic ids are unique per creator
    const other = await seedCreator({ name: "Other", topicId: 7, messageIds: [1], inventory: "complete" });
    await prepared(api, other);
    const clash = await relinkCreatorToRetroTopic(ADMIN, (await getCreator(other.id))!, 650);
    assertEquals(clash.ok, false);
  } finally {
    await kv.close();
  }
});
