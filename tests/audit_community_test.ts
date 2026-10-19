/**
 * Regression tests for defects found in the independent audit — UG-02
 * (creator directory, wanted list, voting).
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { MOCK_CONFIG, MockTelegramApi, setupTestEnvironment } from "./test_helpers.ts";
import { escapeMd } from "../src/util/markdown.ts";
import { submitCreatorNomination, supportExistingCandidate, syncWantedListChannel } from "../src/wanted/service.ts";
import {
  createWantedCandidate,
  getWantedCandidate,
  listWantedCandidates,
  mergeWantedCandidates,
  recordMemberSupport,
  updateWantedStatus,
} from "../src/db/wanted.ts";
import { createEntitlement } from "../src/db/entitlements.ts";
import { SPACE_IDS } from "../src/types.ts";
import { closeAndFinalizeBallot, prepareMonthlyBallot, castVote, retryUnannouncedBallots } from "../src/voting/service.ts";
import { getActiveBallot, getBallot, listPastBallots } from "../src/db/voting.ts";
import { syncPublicDirectory } from "../src/directory/sync.ts";
import { getDirectorySyncState, markDirectoryDirty } from "../src/db/directory.ts";
import { handleForumTopicCreated, handleForumTopicEdited, handleMediaUpload } from "../src/creators/service.ts";
import { getCreatorByTopic, listCreators } from "../src/db/creators.ts";
import { getKv } from "../src/db/kv.ts";

async function paid(userId: number) {
  await createEntitlement({
    userId, source: "telegram_stars", spaces: [...SPACE_IDS], startsAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(), status: "active",
  });
}

class FlakyApi extends MockTelegramApi {
  public editError: string | null = null;
  public sendError: string | null = null;
  public deleted: number[] = [];
  override async editMessageText(chatId: number | string, messageId: number, text: string, options?: unknown) {
    if (this.editError) throw new Error(this.editError);
    return super.editMessageText(chatId, messageId, text, options);
  }
  override async sendMessage(chatId: number | string, text: string, options?: unknown) {
    if (this.sendError) throw new Error(this.sendError);
    return super.sendMessage(chatId, text, options);
  }
  async deleteMessage(_chatId: number | string, messageId: number) {
    this.deleted.push(messageId);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Wanted list
// ---------------------------------------------------------------------------
Deno.test("AUDIT WANTED — simultaneous nominations of the same creator merge into one candidate", async () => {
  const kv = await setupTestEnvironment();
  try {
    const users = [1, 2, 3, 4, 5, 6];
    for (const u of users) await paid(u);
    const variants = ["Aria Moon", "aria moon", " ARIA   MOON ", "Aria Moon", "aria  moon", "Aria Moon"];
    await Promise.all(users.map((u, i) => submitCreatorNomination({ userId: u, name: variants[i] })));
    const all = await listWantedCandidates();
    assertEquals(all.length, 1, "one candidate, not one per nominator");
    assertEquals(all[0].supportCount, 6);
  } finally {
    await kv.close();
  }
});

Deno.test("AUDIT WANTED — merging counts unique supporters; support is refused once a candidate left the pool", async () => {
  const kv = await setupTestEnvironment();
  try {
    for (const u of [1, 2, 3]) await paid(u);
    const x = await createWantedCandidate({ name: "X", normalizedName: "x", status: "requested", suggestedBy: 1, supportCount: 0 });
    const y = await createWantedCandidate({ name: "Y", normalizedName: "y", status: "requested", suggestedBy: 2, supportCount: 0 });
    await recordMemberSupport("2026-01", 1, x.id, "nomination");
    await recordMemberSupport("2026-01", 2, x.id, "support");
    await recordMemberSupport("2026-02", 2, y.id, "support"); // user 2 backed both
    await recordMemberSupport("2026-02", 3, y.id, "support");
    const merged = await mergeWantedCandidates(y.id, x.id);
    assertEquals(merged!.supportCount, 3, "users 1,2,3 — user 2 counted once");
    assertEquals(await getWantedCandidate(y.id), null);

    await updateWantedStatus(x.id, "selected");
    const r = await supportExistingCandidate(1, x.id);
    assertEquals(r.success, false);
    const n = await submitCreatorNomination({ userId: 3, name: "x" });
    assertEquals(n.success, false);
  } finally {
    await kv.close();
  }
});

Deno.test("AUDIT WANTED — channel list is edited in place across restarts, never re-posted", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new FlakyApi();
    await paid(1);
    await submitCreatorNomination({ userId: 1, name: "Under_score" });

    assertEquals((await syncWantedListChannel(api)).success, true);
    assertEquals(api.sentMessages.length, 1);
    assert(api.sentMessages[0].text.includes("Under\\_score"), "names are escaped for Markdown");

    // identical content (e.g. a cold start next day): no Telegram call at all
    assertEquals((await syncWantedListChannel(api)).success, true);
    assertEquals(api.sentMessages.length, 1);
    assertEquals(api.editedMessages.length, 0);

    // changed content: edit, not a second post
    await paid(2);
    await submitCreatorNomination({ userId: 2, name: "Another" });
    await syncWantedListChannel(api);
    assertEquals(api.sentMessages.length, 1);
    assertEquals(api.editedMessages.length, 1);

    // transient Telegram failure must not produce a duplicate post
    await paid(3);
    await submitCreatorNomination({ userId: 3, name: "Third" });
    api.editError = "Too Many Requests: retry after 5";
    assertEquals((await syncWantedListChannel(api)).success, false);
    assertEquals(api.sentMessages.length, 1);
    api.editError = null;
    assertEquals((await syncWantedListChannel(api)).success, true);
    assertEquals(api.sentMessages.length, 1);

    // only if the message really is gone is a new one posted
    await paid(4);
    await submitCreatorNomination({ userId: 4, name: "Fourth" });
    api.editError = "Bad Request: message to edit not found";
    assertEquals((await syncWantedListChannel(api)).success, true);
    assertEquals(api.sentMessages.length, 2);
  } finally {
    await kv.close();
  }
});

// ---------------------------------------------------------------------------
// Voting
// ---------------------------------------------------------------------------
async function twoCandidates(n1 = "One", n2 = "Two", n3?: string) {
  const mk = async (name: string) => {
    const c = await createWantedCandidate({ name, normalizedName: name.toLowerCase(), status: "eligible_for_voting", suggestedBy: 1, supportCount: 2 });
    return c;
  };
  const list = [await mk(n1), await mk(n2)];
  if (n3) list.push(await mk(n3));
  return list;
}

Deno.test("AUDIT VOTING — only one ballot may be open; losers return to the pool; announcement is retried", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new FlakyApi();
    const [a, b, c] = await twoCandidates("A", "B", "C");
    for (const u of [11, 12, 13]) await paid(u);
    const ballot = await prepareMonthlyBallot({ adminId: 1 });
    await assertRejects(() => prepareMonthlyBallot({ adminId: 1 }), Error, "déjà ouvert");

    await castVote({ userId: 11, ballotId: ballot.id, candidateId: a.id });
    await castVote({ userId: 12, ballotId: ballot.id, candidateId: a.id });
    await castVote({ userId: 13, ballotId: ballot.id, candidateId: b.id });

    api.sendError = "Bad Gateway"; // results cannot be announced right now
    const summary = await closeAndFinalizeBallot(ballot.id, api);
    assertEquals(summary.winner!.candidateId, a.id);
    assertEquals((await getWantedCandidate(a.id))!.status, "selected");
    assertEquals((await getWantedCandidate(b.id))!.status, "eligible_for_voting");
    assertEquals((await getWantedCandidate(c.id))!.status, "eligible_for_voting");
    assertEquals((await getBallot(ballot.id))!.resultsAnnouncedAt, undefined);

    api.sendError = null;
    assertEquals(await retryUnannouncedBallots(api), 1);
    assertEquals(api.sentMessages.filter((m) => String(m.text).includes("Gagnant")).length, 1);
    assert((await getBallot(ballot.id))!.resultsAnnouncedAt);
    assertEquals(await retryUnannouncedBallots(api), 0);

    // The pool is usable again: next month's ballot can include the earlier losers
    await updateWantedStatus(a.id, "acquired");
    const next = await prepareMonthlyBallot({ adminId: 1 });
    assertEquals(next.candidates.map((x) => x.candidateId).sort(), [b.id, c.id].sort());
  } finally {
    await kv.close();
  }
});

Deno.test("AUDIT VOTING — no votes, and a runoff that ties again, need an administrator instead of looping", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new FlakyApi();
    const [a, b] = await twoCandidates();
    const empty = await prepareMonthlyBallot({ adminId: 1 });
    await closeAndFinalizeBallot(empty.id, api);
    assertEquals((await getBallot(empty.id))!.needsAdminDecision, true);
    assertEquals(await getActiveBallot(), null);
    assertEquals((await getWantedCandidate(a.id))!.status, "eligible_for_voting", "not stuck in 'voting'");

    for (const u of [21, 22]) await paid(u);
    const first = await prepareMonthlyBallot({ adminId: 1 });
    await castVote({ userId: 21, ballotId: first.id, candidateId: a.id });
    await castVote({ userId: 22, ballotId: first.id, candidateId: b.id });
    await closeAndFinalizeBallot(first.id, api);
    const runoff = (await getActiveBallot())!;
    assertEquals(runoff.isRunoff, true);
    await castVote({ userId: 21, ballotId: runoff.id, candidateId: a.id });
    await castVote({ userId: 22, ballotId: runoff.id, candidateId: b.id });
    await closeAndFinalizeBallot(runoff.id, api);
    assertEquals(await getActiveBallot(), null, "no third ballot is opened automatically");
    assertEquals((await getBallot(runoff.id))!.needsAdminDecision, true);
    assertEquals((await listPastBallots(20)).filter((x) => x.isRunoff).length, 1);
  } finally {
    await kv.close();
  }
});

// ---------------------------------------------------------------------------
// Directory & creators
// ---------------------------------------------------------------------------
let nextTopic = 100;
async function makeCreators(names: string[]) {
  for (const name of names) {
    const c = await handleForumTopicCreated(MOCK_CONFIG.VIP_COLLECTIONS_CHAT_ID, ++nextTopic, name);
    await handleMediaUpload(MOCK_CONFIG.VIP_COLLECTIONS_CHAT_ID, c!.topicId, MOCK_CONFIG.ADMIN_USER_IDS[0], Math.floor(Date.now() / 1000));
  }
}

Deno.test("AUDIT DIRECTORY — unchanged chunks are not re-posted; transient failures never duplicate; stale chunks are deleted", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new FlakyApi();
    // Enough creators to need more than one 3,500-char chunk
    await makeCreators(Array.from({ length: 70 }, (_, i) => `Creator Number ${String(i).padStart(3, "0")} With A Long Name`));
    const first = await syncPublicDirectory(api, true);
    assertEquals(first.updated, true);
    const chunkCount = api.sentMessages.length;
    assert(chunkCount >= 2, `expected multiple chunks, got ${chunkCount}`);

    // Telegram says "message is not modified" for chunk 1 -> must NOT post a new message
    await markDirectoryDirty();
    api.editError = "Bad Request: message is not modified";
    api.sentMessages.length = 0;
    await syncPublicDirectory(api, true);
    assertEquals(api.sentMessages.length, 0, "no duplicate post");

    // Rate limit mid-way: nothing is posted, the dirty flag survives, retry edits in place
    await makeCreators(["Zed Late Arrival"]); // content really changed
    api.editError = "Too Many Requests: retry after 3";
    const failed = await syncPublicDirectory(api, true);
    assert(failed.error);
    assertEquals(api.sentMessages.length, 0);
    assertEquals((await getDirectorySyncState()).isDirty, true);
    api.editError = null;
    assertEquals((await syncPublicDirectory(api)).updated, true);
    assert(api.editedMessages.length >= 1, "the retry edits the existing posts");

    // The directory shrinks to one chunk: the leftover message is removed
    const k = await getKv();
    for await (const e of k.list({ prefix: ["creators"] })) {
      const c = e.value as { name: string; hasContent: boolean; id: string };
      if (c.name && !c.name.endsWith("000 With A Long Name")) await k.set(e.key, { ...c, status: "archived" });
    }
    await markDirectoryDirty();
    await syncPublicDirectory(api);
    assert(api.deleted.length >= 1, "stale trailing chunk deleted");
  } finally {
    await kv.close();
  }
});

Deno.test("AUDIT DIRECTORY — a change made while a sync is running keeps the directory dirty", async () => {
  const kv = await setupTestEnvironment();
  try {
    await makeCreators(["Alpha"]);
    const api = new FlakyApi();
    // A new upload lands while the sync is talking to Telegram
    const original = api.sendMessage.bind(api);
    api.sendMessage = async (c: number | string, t: string, o?: unknown) => {
      await markDirectoryDirty();
      return original(c, t, o);
    };
    await syncPublicDirectory(api);
    assertEquals((await getDirectorySyncState()).isDirty, true, "the concurrent change is not lost");
  } finally {
    await kv.close();
  }
});

Deno.test("AUDIT CREATORS — only administrators drive the public directory; unknown topics and members are ignored", async () => {
  const kv = await setupTestEnvironment();
  try {
    const chat = MOCK_CONFIG.VIP_COLLECTIONS_CHAT_ID;
    const admin = MOCK_CONFIG.ADMIN_USER_IDS[0];
    const c = (await handleForumTopicCreated(chat, 900, "Zoe"))!;
    // media from a member, in an unknown topic, in another chat: nothing changes
    assertEquals(await handleMediaUpload(chat, 900, 424242), null);
    assertEquals(await handleMediaUpload(chat, 12345, admin), null);
    assertEquals(await handleMediaUpload(-999, 900, admin), null);
    assertEquals((await getCreatorByTopic(chat, 900))!.hasContent, false);

    // rename keeps identity, updates the alphabetical index
    const renamed = await handleForumTopicEdited(chat, 900, "Zoë Archive");
    assertEquals(renamed!.id, c.id);
    assertEquals((await listCreators()).map((x) => x.name), ["Zoë Archive"]);

    // system topics are never registered
    assertEquals(await handleForumTopicCreated(chat, 901, "General"), null);
  } finally {
    await kv.close();
  }
});

Deno.test("AUDIT MARKDOWN — user text cannot break message formatting", () => {
  assertEquals(escapeMd("a_b*c`d[e]"), "a\\_b\\*c\\`d\\[e\\]");
});
