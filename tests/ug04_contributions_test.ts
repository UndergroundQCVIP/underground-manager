/**
 * LA CONFRÉRIE — UG-04 Pre-Publish Test Suite: ADMIN-REVIEWED MEMBER CONTRIBUTIONS
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { setupTestEnvironment } from "./test_helpers.ts";
import { MockMigrationApi, REGULAR_CHAT, seedCreator } from "./ug04_helpers.ts";
import {
  addContributionItem,
  approveContribution,
  cancelContribution,
  finishContribution,
  rejectContribution,
  startContribution,
} from "../src/contributions/service.ts";
import { getContribution } from "../src/db/contributions.ts";
import { getCreator } from "../src/db/creators.ts";
import { listMediaIndex } from "../src/db/media_index.ts";
import { createBot } from "../src/bot/bot.ts";

const MEMBER = 6001;
const ADMIN = 111111;

async function submitted(api: MockMigrationApi, creatorId: string) {
  const s = await startContribution(MEMBER, creatorId);
  assert(s.ok);
  await addContributionItem(MEMBER, { messageId: 31, kind: "photo", mediaGroupId: "g" });
  await addContributionItem(MEMBER, { messageId: 32, kind: "photo", mediaGroupId: "g" });
  await addContributionItem(MEMBER, { messageId: 33, kind: "video" });
  const f = await finishContribution(api, MEMBER);
  assert(f.ok, f.error);
  return f.contribution!;
}

Deno.test("UG04 CONTRIB — Nothing is published before admin approval; admins get a preview", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockMigrationApi();
    const c = await seedCreator({ name: "Aria", topicId: 101 });
    const sub = await submitted(api, c.id);

    assertEquals(sub.status, "pending");
    assertEquals(api.copyCalls.filter((x) => x.to === REGULAR_CHAT).length, 0); // topic untouched
    // Preview copied to each admin, with review buttons
    assertEquals(api.copyCalls.map((x) => x.to).sort(), [111111, 222222]);
    assertStringIncludes(JSON.stringify(api.sentMessages[0].options), `cadm:ok:${sub.id}`);
  } finally {
    await kv.close();
  }
});

Deno.test("UG04 CONTRIB — Approval publishes via the bot into the creator topic, once, and updates inventory + last update", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockMigrationApi();
    const c = await seedCreator({ name: "Aria", topicId: 101, lastContentUpdatedAt: "2020-01-01T00:00:00Z" });
    const sub = await submitted(api, c.id);
    api.copyCalls.length = 0;

    const res = await approveContribution(api, sub.id, ADMIN);
    assertEquals(res.ok, true);
    assertEquals(api.copyCalls.length, 1);
    assertEquals(api.copyCalls[0], { to: REGULAR_CHAT, from: MEMBER, ids: [31, 32, 33], thread: 101 });

    assertEquals((await getContribution(sub.id))?.status, "approved");
    const after = await getCreator(c.id);
    assert(new Date(after!.lastContentUpdatedAt!).getTime() > new Date("2020-01-01").getTime());
    const published = (await listMediaIndex(c.id)).filter((e) => e.source === "contribution");
    assertEquals(published.length, 3);
    assertEquals(published[0].mediaGroupId === published[1].mediaGroupId, true); // album kept together
    assertStringIncludes(api.sentMessages.at(-1)!.text, "approved"); // contributor told

    // A second approval (double tap) must not publish again
    const again = await approveContribution(api, sub.id, ADMIN);
    assertEquals(again.ok, false);
    assertEquals(api.copyCalls.length, 1);
  } finally {
    await kv.close();
  }
});

Deno.test("UG04 CONTRIB — Rejection publishes nothing and notifies the member", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockMigrationApi();
    const c = await seedCreator({ name: "Aria", topicId: 101 });
    const sub = await submitted(api, c.id);
    api.copyCalls.length = 0;

    assertEquals((await rejectContribution(api, sub.id, ADMIN)).ok, true);
    assertEquals((await getContribution(sub.id))?.status, "rejected");
    assertEquals((await approveContribution(api, sub.id, ADMIN)).ok, false);
    assertEquals(api.copyCalls.length, 0);
    assertEquals(api.sentMessages.at(-1)!.chatId, MEMBER);
  } finally {
    await kv.close();
  }
});

Deno.test("UG04 CONTRIB — Empty/cancelled sessions cannot be submitted; no cap on items", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockMigrationApi();
    const c = await seedCreator({ name: "Aria", topicId: 101 });
    assertEquals((await finishContribution(api, MEMBER)).ok, false); // no session

    await startContribution(MEMBER, c.id);
    assertEquals((await finishContribution(api, MEMBER)).ok, false); // empty
    for (let i = 1; i <= 250; i++) await addContributionItem(MEMBER, { messageId: i, kind: "photo" });
    assertEquals((await cancelContribution(MEMBER)), true);
    assertEquals((await finishContribution(api, MEMBER)).ok, false); // cancelled
    assertEquals(api.copyCalls.length, 0);

    await startContribution(MEMBER, c.id);
    for (let i = 1; i <= 250; i++) await addContributionItem(MEMBER, { messageId: i, kind: "photo" });
    const f = await finishContribution(api, MEMBER);
    assertEquals(f.contribution?.items.length, 250);
  } finally {
    await kv.close();
  }
});

Deno.test("UG04 CONTRIB — Failed/partial publishing is reported honestly and never double-posts", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockMigrationApi();
    const c = await seedCreator({ name: "Aria", topicId: 101 });
    const sub = await submitted(api, c.id);

    api.failNextCopies = { count: 1, error: new Error("Bad Request: boom") };
    const failed = await approveContribution(api, sub.id, ADMIN);
    assertEquals(failed.ok, false);
    assertEquals((await getContribution(sub.id))?.status, "failed");

    // Retry after a failure is allowed (nothing was published)
    api.missingMessageIds.add(33); // member deleted one original
    const partial = await approveContribution(api, sub.id, ADMIN);
    assertEquals(partial.ok, false);
    assertEquals(partial.published, 2);
    assertEquals((await getContribution(sub.id))?.status, "needs_review");
    // needs_review can't be retried blindly
    assertEquals((await approveContribution(api, sub.id, ADMIN)).ok, false);
  } finally {
    await kv.close();
  }
});

Deno.test("UG04 CONTRIB — Approval is held while the creator is being migrated", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockMigrationApi();
    const c = await seedCreator({ name: "Aria", topicId: 101, messageIds: [1, 2], inventory: "complete" });
    const sub = await submitted(api, c.id);
    const { prepareMigration, startMigration } = await import("../src/migration/service.ts");
    await prepareMigration(api, { creatorId: c.id, adminId: ADMIN, rightsConfirmed: true });
    const { getActiveMigrationForCreator } = await import("../src/db/migrations.ts");
    const job = (await getActiveMigrationForCreator(c.id))!;
    await startMigration(api, job.id, ADMIN);
    const res = await approveContribution(api, sub.id, ADMIN);
    assertEquals(res.ok, false);
    assertStringIncludes(res.error!, "migrated");
    assertEquals((await getContribution(sub.id))?.status, "pending");
  } finally {
    await kv.close();
  }
});

// ---- Real bot wiring -------------------------------------------------------------------

function makeBot() {
  const bot = createBot("123456:TEST_TOKEN");
  // deno-lint-ignore no-explicit-any
  (bot as any).botInfo = { id: 999999, is_bot: true, first_name: "Bot", username: "UndergroundManagerBot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false };
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  bot.api.config.use((_p, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    const msg = { message_id: 1, date: 0, chat: { id: 1, type: "private" }, text: "x" };
    if (method === "copyMessages") return Promise.resolve({ ok: true, result: ((payload as { message_ids: number[] }).message_ids).map((_, i) => ({ message_id: 900 + i })) } as never);
    return Promise.resolve({ ok: true, result: method.startsWith("edit") || method.startsWith("send") ? msg : true } as never);
  });
  return { bot, calls };
}
let uid = 5000;
const cb = (userId: number, data: string) => ({ update_id: uid++, callback_query: { id: `c${uid}`, from: { id: userId, is_bot: false, first_name: "U" }, chat_instance: "x", data, message: { message_id: 7, date: 0, chat: { id: userId, type: "private" as const, first_name: "U" }, text: "m" } } });
const photo = (userId: number, messageId: number) => ({ update_id: uid++, message: { message_id: messageId, date: 0, chat: { id: userId, type: "private" as const, first_name: "U" }, from: { id: userId, is_bot: false, first_name: "U" }, photo: [{ file_id: "f", file_unique_id: "u", width: 1, height: 1 }] } });

Deno.test("UG04 CONTRIB — End-to-end through the bot: any user contributes, only admins can approve", async () => {
  const kv = await setupTestEnvironment();
  try {
    const c = await seedCreator({ name: "Aria", topicId: 101 });
    const { bot, calls } = makeBot();

    // Any user (no membership) sees the creator list
    await bot.handleUpdate(cb(MEMBER, "contrib:start") as never);
    assertStringIncludes(JSON.stringify(calls.filter((x) => x.method === "editMessageText")), "Aria (Regular)");

    await bot.handleUpdate(cb(MEMBER, `contrib:pick:${c.id}`) as never);
    await bot.handleUpdate(photo(MEMBER, 41) as never);
    await bot.handleUpdate(photo(MEMBER, 42) as never);
    await bot.handleUpdate(cb(MEMBER, "contrib:finish") as never);

    const pending = (await (await import("../src/db/contributions.ts")).listContributions("pending"))[0];
    assertEquals(pending.items.map((i) => i.messageId), [41, 42]);

    // A non-admin cannot approve or open the queue
    calls.length = 0;
    await bot.handleUpdate(cb(MEMBER, `cadm:ok:${pending.id}`) as never);
    await bot.handleUpdate(cb(MEMBER, "cadm:queue") as never);
    assertEquals(calls.some((x) => x.method === "copyMessages"), false);
    assertEquals((await getContribution(pending.id))?.status, "pending");

    // Admin approves → bot copies from the member's chat into the creator topic
    await bot.handleUpdate(cb(ADMIN, `cadm:ok:${pending.id}`) as never);
    const copy = calls.find((x) => x.method === "copyMessages" && x.payload.chat_id === REGULAR_CHAT)!;
    assertEquals(copy.payload.from_chat_id, MEMBER);
    assertEquals(copy.payload.message_thread_id, 101);
    assertEquals((await getContribution(pending.id))?.status, "approved");
  } finally {
    await kv.close();
  }
});

Deno.test("UG04 CONTRIB — Media sent without an open session is ignored", async () => {
  const kv = await setupTestEnvironment();
  try {
    const { bot, calls } = makeBot();
    await bot.handleUpdate(photo(MEMBER, 50) as never);
    assertEquals(calls.length, 0);
  } finally {
    await kv.close();
  }
});
