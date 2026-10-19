/**
 * LA CONFRÉRIE — UG-05 Pre-Publish Test Suite: CONTRIBUTION REWARDS & NEW CREATORS
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { setupTestEnvironment } from "./test_helpers.ts";
import { MockMigrationApi, pay, REGULAR_CHAT, RETRO_CHAT, seedCreator } from "./ug04_helpers.ts";
import { cb, makeBot, photo, text } from "./ug05_harness.ts";
import {
  addContributionItem,
  approveContribution,
  finishContribution,
  rejectContribution,
  resolvePartialPublication,
  retryContributionReward,
  startContribution,
  startNewCreatorContribution,
  submitProposalCollection,
  submitProposalName,
  submitProposalUrl,
  adminUpdateProposal,
  findSimilarCreators,
} from "../src/contributions/service.ts";
import { getContribution } from "../src/db/contributions.ts";
import { grantContributionReward, getContributionReward, processContributionReminders } from "../src/contributions/rewards.ts";
import {
  countEligibleParticipants,
  getActiveUserEntitlements,
  getMembershipSummary,
  hasAccessToSpace,
  getUserEntitlements,
} from "../src/db/entitlements.ts";
import { getCreator, listCreators } from "../src/db/creators.ts";
import { reconcileAllMembers } from "../src/access/sync.ts";
import { recordSyncState } from "../src/db/sync.ts";
import { getKv } from "../src/db/kv.ts";
import { updateSystemSettings } from "../src/db/settings.ts";
import { submitCreatorNomination } from "../src/wanted/service.ts";
import { grantComplimentaryAccess } from "../src/complimentary/service.ts";
import { getDirectorySyncState } from "../src/db/directory.ts";

const MEMBER = 6001;
const ADMIN = 111111;
const DAY = 86_400_000;

async function submit(api: MockMigrationApi, creatorId: string, user = MEMBER, ids = [31, 32, 33]) {
  assert((await startContribution(user, creatorId)).ok);
  for (const id of ids) await addContributionItem(user, { messageId: id, kind: "photo", mediaGroupId: id < 33 ? "g" : undefined });
  const f = await finishContribution(api, user);
  assert(f.ok, f.error);
  return f.contribution!;
}

const contribEnts = async (user: number) =>
  (await getUserEntitlements(user)).filter((e) => e.source === "contribution");

// ---------------------------------------------------------------------------------------------

Deno.test("UG05 APPROVAL — Approve WITHOUT reward publishes, updates inventory, grants nothing", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockMigrationApi();
    const c = await seedCreator({ name: "Aria", topicId: 101, lastContentUpdatedAt: "2020-01-01T00:00:00Z" });
    const sub = await submit(api, c.id);

    assertEquals(await hasAccessToSpace(MEMBER, "vip_collections"), false); // submission alone grants nothing
    const res = await approveContribution(api, sub.id, ADMIN, { type: "no_reward" });
    assertEquals(res.ok, true);

    const done = (await getContribution(sub.id))!;
    assertEquals(done.status, "approved");
    assertEquals(done.rewardStatus, "none");
    assertEquals((await contribEnts(MEMBER)).length, 0);
    assertEquals(await getContributionReward(sub.id), null);
    assertEquals(await hasAccessToSpace(MEMBER, "vip_collections"), false);
    assert(new Date((await getCreator(c.id))!.lastContentUpdatedAt!).getTime() > Date.parse("2020-01-01"));
    assertStringIncludes(api.sentMessages.at(-1)!.text, "Aucun jour d'adhésion supplémentaire");
  } finally {
    await kv.close();
  }
});

Deno.test("UG05 REWARD — Regular only: 30 days, community spaces included, NO Retro", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockMigrationApi();
    const c = await seedCreator({ name: "Maya", topicId: 5, collection: "retro" }); // Retro creator
    const sub = await submit(api, c.id);
    const res = await approveContribution(api, sub.id, ADMIN, { type: "reward", scopes: ["regular"], days: 30 });
    assertEquals(res.ok, true);

    // Retro CREATOR did not auto-grant Retro ACCESS: the admin chose Regular only.
    assertEquals(await hasAccessToSpace(MEMBER, "vip_collections"), true);
    assertEquals(await hasAccessToSpace(MEMBER, "retro_collections"), false);
    assertEquals(await hasAccessToSpace(MEMBER, "wanted_list"), true);
    assertEquals(await hasAccessToSpace(MEMBER, "general_chat"), true);

    const ents = await contribEnts(MEMBER);
    assertEquals(ents.length, 1);
    assertEquals(ents[0].contributionScope, "regular");
    const days = (new Date(ents[0].expiresAt).getTime() - Date.now()) / DAY;
    assert(days > 29.99 && days <= 30.001);
    assertEquals((await getContribution(sub.id))!.rewardStatus, "granted");
    const note = api.sentMessages.at(-1)!.text;
    assertStringIncludes(note, "Récompense : 30 jours");
    assertStringIncludes(note, "Accès : Regular");
    assert(!note.includes("Retro"));
  } finally {
    await kv.close();
  }
});

Deno.test("UG05 REWARD — Retro only, and Both", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockMigrationApi();
    const c = await seedCreator({ name: "Aria", topicId: 101 });

    const s1 = await submit(api, c.id, 7001);
    await approveContribution(api, s1.id, ADMIN, { type: "reward", scopes: ["retro"], days: 7 });
    assertEquals(await hasAccessToSpace(7001, "retro_collections"), true);
    assertEquals(await hasAccessToSpace(7001, "vip_collections"), false);
    assertEquals((await getMembershipSummary(7001)).canParticipate, true);

    const s2 = await submit(api, c.id, 7002, [41, 42]);
    await approveContribution(api, s2.id, ADMIN, { type: "reward", scopes: ["regular", "retro"], days: 15 });
    assertEquals(await hasAccessToSpace(7002, "retro_collections"), true);
    assertEquals(await hasAccessToSpace(7002, "vip_collections"), true);
    assertEquals((await contribEnts(7002)).length, 2);
    assertStringIncludes(api.sentMessages.at(-1)!.text, "Accès : Regular + Retro");
  } finally {
    await kv.close();
  }
});

Deno.test("UG05 REWARD — Days accumulate per scope; scopes keep independent expirations; custom duration", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockMigrationApi();
    const c = await seedCreator({ name: "Aria", topicId: 101 });

    const a = await submit(api, c.id, MEMBER, [1]);
    await approveContribution(api, a.id, ADMIN, { type: "reward", scopes: ["regular"], days: 30 });
    const first = (await contribEnts(MEMBER))[0];

    const b = await submit(api, c.id, MEMBER, [2]);
    await approveContribution(api, b.id, ADMIN, { type: "reward", scopes: ["regular"], days: 30 });
    const ents = await contribEnts(MEMBER);
    assertEquals(ents.length, 1); // one entitlement per scope, extended — not duplicated
    // max(now, existing) + 30 d : the remaining time is preserved and 30 d added
    assertEquals(new Date(ents[0].expiresAt).getTime() - new Date(first.expiresAt).getTime(), 30 * DAY);

    // A later Retro reward leaves Regular untouched
    const regularExpiry = ents[0].expiresAt;
    const r = await submit(api, c.id, MEMBER, [3]);
    await approveContribution(api, r.id, ADMIN, { type: "reward", scopes: ["retro"], days: 45 }); // custom
    const all = await contribEnts(MEMBER);
    assertEquals(all.length, 2);
    const reg = all.find((e) => e.contributionScope === "regular")!;
    const retro = all.find((e) => e.contributionScope === "retro")!;
    assertEquals(reg.expiresAt, regularExpiry);
    const retroDays = (new Date(retro.expiresAt).getTime() - Date.now()) / DAY;
    assert(retroDays > 44.99 && retroDays <= 45.001);
    assertEquals(await hasAccessToSpace(MEMBER, "retro_collections"), true);
  } finally {
    await kv.close();
  }
});

Deno.test("UG05 REWARD — Invalid durations/scopes are rejected before anything is published", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockMigrationApi();
    const c = await seedCreator({ name: "Aria", topicId: 101 });
    const sub = await submit(api, c.id);
    api.copyCalls.length = 0;
    for (const bad of [
      { type: "reward" as const, scopes: [] as ("regular" | "retro")[], days: 30 },
      { type: "reward" as const, scopes: ["regular" as const], days: 0 },
      { type: "reward" as const, scopes: ["regular" as const], days: 1.5 },
      { type: "reward" as const, scopes: ["regular" as const], days: 99999 },
    ]) {
      assertEquals((await approveContribution(api, sub.id, ADMIN, bad)).ok, false);
    }
    assertEquals(api.copyCalls.length, 0);
    assertEquals((await getContribution(sub.id))!.status, "pending");
  } finally {
    await kv.close();
  }
});

Deno.test("UG05 REWARD — Never shortens or cancels a paid subscription; overlapping entitlements keep access", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockMigrationApi();
    const c = await seedCreator({ name: "Aria", topicId: 101 });
    await pay(MEMBER, "regular", "ch_keep", { expiresInDays: 90 });
    const paidBefore = (await getActiveUserEntitlements(MEMBER)).find((e) => e.source === "telegram_stars")!;

    const sub = await submit(api, c.id);
    await approveContribution(api, sub.id, ADMIN, { type: "reward", scopes: ["regular"], days: 7 });

    const paidAfter = (await getActiveUserEntitlements(MEMBER)).find((e) => e.source === "telegram_stars")!;
    assertEquals(paidAfter.expiresAt, paidBefore.expiresAt);
    assertEquals(api.starSubscriptionEdits.length, 0); // no Stars subscription touched

    // The contribution days run out, but the paid subscription still authorizes access.
    const kvh = await getKv();
    const ent = (await contribEnts(MEMBER))[0];
    const expired = { ...ent, expiresAt: new Date(Date.now() - 1000).toISOString() };
    await kvh.set(["entitlements", ent.id], expired);
    await kvh.set(["entitlements_by_user", MEMBER, ent.id], expired);
    for (const [spaceId, chatId] of [["vip_collections", REGULAR_CHAT]] as const) {
      await recordSyncState({ userId: MEMBER, spaceId, chatId, status: "admitted", lastSyncAt: new Date().toISOString() });
    }
    await reconcileAllMembers(api);
    assertEquals(api.bannedMembers.length, 0);
    assertEquals(await hasAccessToSpace(MEMBER, "vip_collections"), true);
  } finally {
    await kv.close();
  }
});

Deno.test("UG05 EXPIRY — Expired contribution access is removed by the existing reconciliation (only what is unauthorized)", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockMigrationApi();
    const c = await seedCreator({ name: "Aria", topicId: 101 });
    const sub = await submit(api, c.id);
    await approveContribution(api, sub.id, ADMIN, { type: "reward", scopes: ["regular", "retro"], days: 30 });
    // Regular lapses, Retro still has time
    const kvh = await getKv();
    const reg = (await contribEnts(MEMBER)).find((e) => e.contributionScope === "regular")!;
    const lapsed = { ...reg, expiresAt: new Date(Date.now() - 1000).toISOString() };
    await kvh.set(["entitlements", reg.id], lapsed);
    await kvh.set(["entitlements_by_user", MEMBER, reg.id], lapsed);
    await recordSyncState({ userId: MEMBER, spaceId: "vip_collections", chatId: REGULAR_CHAT, status: "admitted", lastSyncAt: "" });
    await recordSyncState({ userId: MEMBER, spaceId: "retro_collections", chatId: RETRO_CHAT, status: "admitted", lastSyncAt: "" });

    await reconcileAllMembers(api);
    assertEquals(api.bannedMembers.map((b) => b.chatId), [REGULAR_CHAT]); // Regular forum only
    assertEquals(await hasAccessToSpace(MEMBER, "retro_collections"), true);
    assertEquals(await hasAccessToSpace(MEMBER, "vip_collections"), false);

    // A fresh reward revives the lapsed scope from "now" (max(now, expired)+days)
    const s2 = await submit(api, c.id, MEMBER, [9]);
    await approveContribution(api, s2.id, ADMIN, { type: "reward", scopes: ["regular"], days: 10 });
    assertEquals(await hasAccessToSpace(MEMBER, "vip_collections"), true);
    assertEquals((await contribEnts(MEMBER)).length, 2);
  } finally {
    await kv.close();
  }
});

Deno.test("UG05 IDEMPOTENCY — Repeated or concurrent approvals publish once and reward once", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockMigrationApi();
    const c = await seedCreator({ name: "Aria", topicId: 101 });
    const sub = await submit(api, c.id);
    api.copyCalls.length = 0;
    const decision = { type: "reward" as const, scopes: ["regular" as const], days: 30 };

    const results = await Promise.all([
      approveContribution(api, sub.id, ADMIN, decision),
      approveContribution(api, sub.id, ADMIN, decision),
      approveContribution(api, sub.id, 222222, decision),
    ]);
    assertEquals(results.filter((r) => r.ok).length, 1);
    assertEquals(api.copyCalls.filter((x) => x.to === REGULAR_CHAT).length, 1);
    const once = (await contribEnts(MEMBER))[0].expiresAt;

    assertEquals((await approveContribution(api, sub.id, ADMIN, decision)).ok, false);
    // The reward ledger itself is also idempotent per submission
    const again = await grantContributionReward({ contributionId: sub.id, userId: MEMBER, scopes: ["regular"], days: 30, adminId: ADMIN });
    assertEquals(again.alreadyGranted, true);
    assertEquals((await contribEnts(MEMBER))[0].expiresAt, once);
    assertEquals((await contribEnts(MEMBER)).length, 1);
  } finally {
    await kv.close();
  }
});

Deno.test("UG05 SAFETY — Partial publication grants NO reward until the administrator resolves it", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockMigrationApi();
    const c = await seedCreator({ name: "Aria", topicId: 101 });
    const sub = await submit(api, c.id);
    api.missingMessageIds.add(33);

    const res = await approveContribution(api, sub.id, ADMIN, { type: "reward", scopes: ["regular"], days: 30 });
    assertEquals(res.ok, false);
    assertEquals(res.published, 2);
    const held = (await getContribution(sub.id))!;
    assertEquals(held.status, "needs_review");
    assertEquals((await contribEnts(MEMBER)).length, 0);
    assertEquals(await getContributionReward(sub.id), null);
    assertEquals(held.publishedMessageIds?.length, 2);
    // not blindly re-publishable (no duplicates)
    const copies = api.copyCalls.length;
    assertEquals((await approveContribution(api, sub.id, ADMIN, { type: "no_reward" })).ok, false);
    assertEquals(api.copyCalls.length, copies);

    // Administrator verifies the topic and accepts → the stored decision is applied exactly once
    const resolved = await resolvePartialPublication(api, sub.id, ADMIN);
    assertEquals(resolved.ok, true);
    assertEquals((await contribEnts(MEMBER)).length, 1);
    assertEquals((await resolvePartialPublication(api, sub.id, ADMIN)).ok, false);
    assertEquals((await contribEnts(MEMBER)).length, 1);
  } finally {
    await kv.close();
  }
});

Deno.test("UG05 SAFETY — Failed publication grants no reward; a retry publishes and rewards once", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockMigrationApi();
    const c = await seedCreator({ name: "Aria", topicId: 101 });
    const sub = await submit(api, c.id);
    const decision = { type: "reward" as const, scopes: ["retro" as const], days: 30 };

    api.failNextCopies = { count: 1, error: new Error("Bad Request: boom") };
    assertEquals((await approveContribution(api, sub.id, ADMIN, decision)).ok, false);
    assertEquals((await getContribution(sub.id))!.status, "failed");
    assertEquals((await contribEnts(MEMBER)).length, 0);

    assertEquals((await approveContribution(api, sub.id, ADMIN, decision)).ok, true);
    assertEquals((await contribEnts(MEMBER)).length, 1);
    assertEquals((await getMembershipSummary(MEMBER)).hasRetroAccess, true);
  } finally {
    await kv.close();
  }
});

Deno.test("UG05 SAFETY — A reward left pending after publication is retryable without republishing, and applied once", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockMigrationApi();
    const c = await seedCreator({ name: "Aria", topicId: 101 });
    const sub = await submit(api, c.id);
    await approveContribution(api, sub.id, ADMIN, { type: "no_reward" });

    // Reproduce the state left by a storage failure right after publication:
    // published + approved, decision says "reward", ledger not yet applied.
    const { transitionContribution } = await import("../src/db/contributions.ts");
    await transitionContribution(sub.id, ["approved"], (x) => {
      x.decision = { type: "reward", scopes: ["regular", "retro"], days: 20 };
      x.rewardStatus = "pending";
    });
    assertEquals((await contribEnts(MEMBER)).length, 0);
    api.copyCalls.length = 0;

    assertEquals((await retryContributionReward(api, sub.id, ADMIN)).ok, true);
    assertEquals(api.copyCalls.length, 0); // nothing is republished
    assertEquals((await contribEnts(MEMBER)).length, 2);
    assertEquals((await getContribution(sub.id))!.rewardStatus, "granted");

    // Retrying again (double click) neither re-extends nor errors destructively
    const before = (await contribEnts(MEMBER)).map((e) => e.expiresAt).sort();
    assertEquals((await retryContributionReward(api, sub.id, ADMIN)).ok, false);
    assertEquals((await contribEnts(MEMBER)).map((e) => e.expiresAt).sort(), before);
  } finally {
    await kv.close();
  }
});

Deno.test("UG05 REJECT — Rejection grants nothing, stores the reason, purges message references, notifies", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockMigrationApi();
    const c = await seedCreator({ name: "Aria", topicId: 101 });
    const sub = await submit(api, c.id);
    api.copyCalls.length = 0;

    assertEquals((await rejectContribution(api, sub.id, ADMIN, "Qualité insuffisante")).ok, true);
    const r = (await getContribution(sub.id))!;
    assertEquals(r.status, "rejected");
    assertEquals(r.rejectionReason, "Qualité insuffisante");
    assertEquals(r.items.length, 0);
    assertEquals(r.itemCount, 3);
    assertEquals(api.copyCalls.length, 0);
    assertEquals((await contribEnts(MEMBER)).length, 0);
    assertStringIncludes(api.sentMessages.at(-1)!.text, "Raison : Qualité insuffisante");
    assertEquals((await approveContribution(api, sub.id, ADMIN, { type: "no_reward" })).ok, false);

    // No reason is fine too
    const s2 = await submit(api, c.id, 6002, [5]);
    assertEquals((await rejectContribution(api, s2.id, ADMIN)).ok, true);
    assert(!api.sentMessages.at(-1)!.text.includes("Raison"));
  } finally {
    await kv.close();
  }
});

Deno.test("UG05 SAFETY — Contributions to a creator being migrated stay blocked (no publish, no reward)", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockMigrationApi();
    const c = await seedCreator({ name: "Aria", topicId: 101, messageIds: [1, 2], inventory: "complete" });
    const sub = await submit(api, c.id);
    const { prepareMigration, startMigration } = await import("../src/migration/service.ts");
    await prepareMigration(api, { creatorId: c.id, adminId: ADMIN, rightsConfirmed: true });
    const { getActiveMigrationForCreator } = await import("../src/db/migrations.ts");
    await startMigration(api, (await getActiveMigrationForCreator(c.id))!.id, ADMIN);
    const res = await approveContribution(api, sub.id, ADMIN, { type: "reward", scopes: ["regular"], days: 30 });
    assertEquals(res.ok, false);
    assertEquals((await contribEnts(MEMBER)).length, 0);
    assertEquals((await getContribution(sub.id))!.status, "pending");
  } finally {
    await kv.close();
  }
});

Deno.test("UG05 COMMUNITY — Contribution members may nominate/vote; complimentary stay excluded; counted as eligible", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockMigrationApi();
    const c = await seedCreator({ name: "Aria", topicId: 101 });
    const sub = await submit(api, c.id);
    assertEquals((await submitCreatorNomination({ userId: MEMBER, name: "Nova" })).success, false); // before reward
    await approveContribution(api, sub.id, ADMIN, { type: "reward", scopes: ["retro"], days: 30 });

    const summary = await getMembershipSummary(MEMBER);
    assertEquals(summary.canParticipate, true);
    assertEquals(summary.hasPaid, false);
    assertEquals(summary.primaryType, "Contribution");
    assertEquals((await submitCreatorNomination({ userId: MEMBER, name: "Nova" })).success, true);

    await grantComplimentaryAccess({ adminId: ADMIN, userId: 6100, durationDays: 30, reason: "partnership", level: "full" });
    assertEquals((await getMembershipSummary(6100)).canParticipate, false);
    assertEquals((await submitCreatorNomination({ userId: 6100, name: "Zed" })).success, false);

    await pay(6200, "regular", "ch_e1");
    assertEquals(await countEligibleParticipants(), 2); // contributor + payer, not the complimentary member
  } finally {
    await kv.close();
  }
});

Deno.test("UG05 REMINDER — 3-day heads-up for earned access, once, without promising an extension", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockMigrationApi();
    const c = await seedCreator({ name: "Aria", topicId: 101 });
    const sub = await submit(api, c.id);
    await approveContribution(api, sub.id, ADMIN, { type: "reward", scopes: ["regular"], days: 2 });
    api.sentMessages.length = 0;

    const r1 = await processContributionReminders(api);
    assertEquals(r1.remindedCount, 1);
    assertStringIncludes(api.sentMessages[0].text, "ne garantit pas une prolongation");
    assertEquals((await processContributionReminders(api)).remindedCount, 0); // only once

    // A new reward re-arms the reminder; far-off expiry sends nothing
    const s2 = await submit(api, c.id, MEMBER, [8]);
    await approveContribution(api, s2.id, ADMIN, { type: "reward", scopes: ["regular"], days: 60 });
    assertEquals((await processContributionReminders(api)).remindedCount, 0);
  } finally {
    await kv.close();
  }
});

// ----------------------------- NEW CREATOR SUBMISSIONS -------------------------------------------

Deno.test("UG05 NEW CREATOR — Duplicate and near-duplicate names are detected", async () => {
  const kv = await setupTestEnvironment();
  try {
    await seedCreator({ name: "Aria", topicId: 1 });
    await seedCreator({ name: "Valentina", topicId: 2 });
    assertEquals((await findSimilarCreators("aria")).length, 1);
    assertEquals((await findSimilarCreators("Arya")).length, 1); // one typo away
    assertEquals((await findSimilarCreators("Valentin")).length, 1); // contained
    assertEquals((await findSimilarCreators("Xander")).length, 0);

    await startNewCreatorContribution(MEMBER);
    const res = await submitProposalName(MEMBER, "ARIA ");
    assertEquals(res.duplicates?.length, 1);
    assertEquals(res.contribution?.proposal?.duplicateCandidateIds.length, 1);
    assertEquals((await submitProposalName(MEMBER, "x")).ok, false); // wrong step/too short
  } finally {
    await kv.close();
  }
});

Deno.test("UG05 NEW CREATOR — Proposal flow through the bot creates NOTHING until approval", async () => {
  const kv = await setupTestEnvironment();
  try {
    const { bot, calls } = makeBot();
    await bot.handleUpdate(cb(MEMBER, "contrib:new") as never);
    await bot.handleUpdate(photo(MEMBER, 10) as never); // media before details are complete: ignored
    await bot.handleUpdate(text(MEMBER, "Nova Star") as never);
    await bot.handleUpdate(text(MEMBER, "pas un lien") as never); // invalid URL is refused
    await bot.handleUpdate(text(MEMBER, "https://example.com/nova") as never);
    await bot.handleUpdate(cb(MEMBER, "contrib:col:retro") as never);
    await bot.handleUpdate(photo(MEMBER, 11, "g1") as never);
    await bot.handleUpdate(photo(MEMBER, 12, "g1") as never);
    await bot.handleUpdate(cb(MEMBER, "contrib:finish") as never);

    const { listContributions } = await import("../src/db/contributions.ts");
    const [pending] = await listContributions("pending");
    assertEquals(pending.kind, "new");
    assertEquals(pending.proposal?.name, "Nova Star");
    assertEquals(pending.proposal?.collection, "retro");
    assertEquals(pending.proposal?.profileUrl, "https://example.com/nova");
    assertEquals(pending.items.map((i) => i.messageId), [11, 12]);
    assertEquals(pending.creatorId, "");

    assertEquals((await listCreators()).length, 0); // no creator
    assertEquals(calls.filter((c) => c.method === "createForumTopic").length, 0); // no topic
    assertEquals(calls.filter((c) => c.method === "copyMessages" && c.payload.chat_id === RETRO_CHAT).length, 0);
  } finally {
    await kv.close();
  }
});

Deno.test("UG05 NEW CREATOR — Contributor can switch to the existing creator when a duplicate is flagged", async () => {
  const kv = await setupTestEnvironment();
  try {
    const existing = await seedCreator({ name: "Aria", topicId: 1 });
    const { bot, calls } = makeBot();
    await bot.handleUpdate(cb(MEMBER, "contrib:new") as never);
    await bot.handleUpdate(text(MEMBER, "Aria") as never);
    assertStringIncludes(JSON.stringify(calls.filter((c) => c.method === "sendMessage")), "contrib:dupuse:0");
    await bot.handleUpdate(cb(MEMBER, "contrib:dupuse:0") as never);
    await bot.handleUpdate(photo(MEMBER, 21) as never);
    await bot.handleUpdate(cb(MEMBER, "contrib:finish") as never);
    const { listContributions } = await import("../src/db/contributions.ts");
    const [pending] = await listContributions("pending");
    assertEquals(pending.kind, "existing");
    assertEquals(pending.creatorId, existing.id);
  } finally {
    await kv.close();
  }
});

async function newProposal(api: MockMigrationApi, name: string, collection: "regular" | "retro") {
  await startNewCreatorContribution(MEMBER);
  await submitProposalName(MEMBER, name);
  await submitProposalUrl(MEMBER, null);
  await submitProposalCollection(MEMBER, collection);
  await addContributionItem(MEMBER, { messageId: 61, kind: "photo" });
  await addContributionItem(MEMBER, { messageId: 62, kind: "video" });
  const f = await finishContribution(api, MEMBER);
  assert(f.ok, f.error);
  return f.contribution!;
}

Deno.test("UG05 NEW CREATOR — Approval needs identity+rights attestation, then creates ONE topic/creator in the right forum and publishes", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockMigrationApi();
    const sub = await newProposal(api, "Nova", "retro");

    // Without the explicit attestation: refused, nothing created
    const refused = await approveContribution(api, sub.id, ADMIN, { type: "no_reward" });
    assertEquals(refused.ok, false);
    assertEquals(api.createdTopics.length, 0);
    assertEquals((await listCreators()).length, 0);

    // Admin corrects the proposal, attests and approves with a Retro-only reward
    assertEquals((await adminUpdateProposal(sub.id, { name: "Nova Star", collection: "retro", identityRightsConfirmed: true })).ok, true);
    const res = await approveContribution(api, sub.id, ADMIN, { type: "reward", scopes: ["retro"], days: 30 });
    assertEquals(res.ok, true);

    assertEquals(api.createdTopics.length, 1);
    assertEquals(api.createdTopics[0].chatId, RETRO_CHAT);
    assertEquals(api.createdTopics[0].name, "Nova Star");
    const creators = await listCreators();
    assertEquals(creators.length, 1);
    assertEquals(creators[0].name, "Nova Star");
    assertEquals(creators[0].collection, "retro");
    assertEquals(creators[0].rightsStatus, "verified");
    assertEquals(creators[0].chatId, RETRO_CHAT);
    // published into the NEW topic, only after it existed
    const copy = api.copyCalls.find((x) => x.to === RETRO_CHAT && x.from === MEMBER)!;
    assertEquals(copy.thread, api.createdTopics[0].id);
    assertEquals(creators[0].hasContent, true);
    assertEquals((await getDirectorySyncState()).isDirty, true); // scheduled for the daily directory update
    assertEquals(await hasAccessToSpace(MEMBER, "retro_collections"), true);
  } finally {
    await kv.close();
  }
});

Deno.test("UG05 NEW CREATOR — A failed publication retried later reuses the topic/creator (no duplicates)", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockMigrationApi();
    const sub = await newProposal(api, "Nova", "regular");
    await adminUpdateProposal(sub.id, { identityRightsConfirmed: true });

    api.failNextCopies = { count: 1, error: new Error("Bad Request: boom") };
    assertEquals((await approveContribution(api, sub.id, ADMIN, { type: "reward", scopes: ["regular"], days: 30 })).ok, false);
    assertEquals((await contribEnts(MEMBER)).length, 0);
    assertEquals(api.createdTopics.length, 1);

    assertEquals((await approveContribution(api, sub.id, ADMIN, { type: "reward", scopes: ["regular"], days: 30 })).ok, true);
    assertEquals(api.createdTopics.length, 1); // topic NOT created again
    assertEquals((await listCreators()).length, 1);
    assertEquals(api.createdTopics[0].chatId, REGULAR_CHAT);
    assertEquals((await contribEnts(MEMBER)).length, 1);
  } finally {
    await kv.close();
  }
});

Deno.test("UG05 NEW CREATOR — Admin picks the existing creator for a duplicate: no new topic or creator", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockMigrationApi();
    const existing = await seedCreator({ name: "Aria", topicId: 101 });
    const sub = await newProposal(api, "Arya", "retro"); // near-duplicate
    assertEquals(sub.proposal!.duplicateCandidateIds, [existing.id]);

    await adminUpdateProposal(sub.id, { useExistingCreatorId: existing.id, identityRightsConfirmed: true });
    assertEquals((await approveContribution(api, sub.id, ADMIN, { type: "no_reward" })).ok, true);
    assertEquals(api.createdTopics.length, 0);
    assertEquals((await listCreators()).length, 1);
    const copy = api.copyCalls.find((x) => x.from === MEMBER && x.to === REGULAR_CHAT)!;
    assertEquals(copy.thread, 101);
    assertEquals((await getCreator(existing.id))!.collection, "regular"); // classification untouched
  } finally {
    await kv.close();
  }
});

Deno.test("UG05 NEW CREATOR — An exact existing name cannot be created again unless the admin selects it", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockMigrationApi();
    await seedCreator({ name: "Nova", topicId: 101 });
    const sub = await newProposal(api, "Nova", "regular");
    await adminUpdateProposal(sub.id, { identityRightsConfirmed: true });
    const res = await approveContribution(api, sub.id, ADMIN, { type: "no_reward" });
    assertEquals(res.ok, false);
    assertStringIncludes(res.error!, "existe déjà");
    assertEquals(api.createdTopics.length, 0);
    assertEquals((await listCreators()).length, 1);
  } finally {
    await kv.close();
  }
});

// ----------------------------- ADMIN UI WIRING ---------------------------------------------------

Deno.test("UG05 ADMIN UI — Reward flow through the bot: scope must be chosen explicitly; only admins can act", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockMigrationApi();
    const c = await seedCreator({ name: "Maya", topicId: 5, collection: "retro" });
    const sub = await submit(api, c.id);
    const { bot, calls } = makeBot();

    // Config screen: no confirm button until a scope is chosen; Retro is NOT preselected
    await bot.handleUpdate(cb(ADMIN, `cadm:rw:${sub.id}`) as never);
    const screen = JSON.stringify(calls.filter((x) => x.method === "editMessageText").at(-1));
    assertStringIncludes(screen, "Regular seulement");
    assertStringIncludes(screen, "Les deux");
    assertStringIncludes(screen, "Personnalisé");
    assert(!screen.includes(`cadm:cf:${sub.id}`));

    // A non-admin cannot confirm or even configure
    calls.length = 0;
    await bot.handleUpdate(cb(MEMBER, `cadm:sc:${sub.id}:bo`) as never);
    await bot.handleUpdate(cb(MEMBER, `cadm:cf:${sub.id}`) as never);
    await bot.handleUpdate(cb(MEMBER, `cadm:nr:${sub.id}`) as never);
    assertEquals(calls.some((x) => x.method === "copyMessages"), false);
    assertEquals((await getContribution(sub.id))!.status, "pending");
    assertEquals((await getContribution(sub.id))!.draft, undefined);

    // Admin picks Both + 60 days and confirms
    await bot.handleUpdate(cb(ADMIN, `cadm:sc:${sub.id}:bo`) as never);
    await bot.handleUpdate(cb(ADMIN, `cadm:du:${sub.id}:60`) as never);
    const withConfirm = JSON.stringify(calls.filter((x) => x.method === "editMessageText").at(-1));
    assertStringIncludes(withConfirm, `cadm:cf:${sub.id}`);
    await bot.handleUpdate(cb(ADMIN, `cadm:cf:${sub.id}`) as never);
    const done = (await getContribution(sub.id))!;
    assertEquals(done.status, "approved");
    assertEquals(done.decision, { type: "reward", scopes: ["regular", "retro"], days: 60 });
    assertEquals((await contribEnts(MEMBER)).length, 2);

    // Double-pressing confirm does not duplicate anything
    const before = (await contribEnts(MEMBER)).map((e) => e.expiresAt).sort();
    await bot.handleUpdate(cb(ADMIN, `cadm:cf:${sub.id}`) as never);
    assertEquals((await contribEnts(MEMBER)).map((e) => e.expiresAt).sort(), before);
  } finally {
    await kv.close();
  }
});

Deno.test("UG05 ADMIN UI — Custom duration via admin text prompt; default duration is configurable", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockMigrationApi();
    const c = await seedCreator({ name: "Aria", topicId: 101 });
    const sub = await submit(api, c.id);
    const { bot, calls } = makeBot();

    await bot.handleUpdate(cb(ADMIN, "cadm:defdays:60") as never);
    await bot.handleUpdate(cb(ADMIN, `cadm:rw:${sub.id}`) as never);
    assertStringIncludes(JSON.stringify(calls.filter((x) => x.method === "editMessageText").at(-1)), "• 60 jours");

    await bot.handleUpdate(cb(ADMIN, `cadm:duc:${sub.id}`) as never);
    await bot.handleUpdate(text(ADMIN, "0") as never); // invalid → asked again
    assertEquals((await getContribution(sub.id))!.draft?.days ?? 60, 60);
    await bot.handleUpdate(text(ADMIN, "45") as never);
    assertEquals((await getContribution(sub.id))!.draft?.days, 45);
    // A random member's text is NOT taken as the admin's answer
    await bot.handleUpdate(text(MEMBER, "99") as never);
    assertEquals((await getContribution(sub.id))!.draft?.days, 45);
  } finally {
    await kv.close();
  }
});

Deno.test("UG05 ADMIN UI — Reject with an optional reason through the bot", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockMigrationApi();
    const c = await seedCreator({ name: "Aria", topicId: 101 });
    const sub = await submit(api, c.id);
    const { bot, calls } = makeBot();
    await bot.handleUpdate(cb(ADMIN, `cadm:nor:${sub.id}`) as never);
    await bot.handleUpdate(text(ADMIN, "Doublon d'un envoi précédent") as never);
    const r = (await getContribution(sub.id))!;
    assertEquals(r.status, "rejected");
    assertEquals(r.rejectionReason, "Doublon d'un envoi précédent");
    assertStringIncludes(JSON.stringify(calls.filter((x) => x.method === "sendMessage" && x.payload.chat_id === MEMBER)), "Raison");
  } finally {
    await kv.close();
  }
});

Deno.test("UG05 REWARD LOCK — In Stars-only mode rewards are disabled unless explicitly allowed; no-reward approval still works", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockMigrationApi();
    const c = await seedCreator({ name: "Aria", topicId: 101 });
    const sub = await submit(api, c.id);
    await updateSystemSettings({ membershipMode: "stars_only" });
    api.copyCalls.length = 0;

    const denied = await approveContribution(api, sub.id, ADMIN, { type: "reward", scopes: ["regular"], days: 30 });
    assertEquals(denied.ok, false);
    assertEquals(api.copyCalls.length, 0);

    await updateSystemSettings({ contributionRewardsInStarsMode: true });
    assertEquals((await approveContribution(api, sub.id, ADMIN, { type: "reward", scopes: ["regular"], days: 30 })).ok, true);

    const s2 = await submit(api, c.id, 6002, [4]);
    await updateSystemSettings({ contributionRewardsInStarsMode: false });
    assertEquals((await approveContribution(api, s2.id, ADMIN, { type: "no_reward" })).ok, true);
  } finally {
    await kv.close();
  }
});

Deno.test("UG05 RETRIES — retryContributionReward refuses when there is nothing pending", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockMigrationApi();
    const c = await seedCreator({ name: "Aria", topicId: 101 });
    const sub = await submit(api, c.id);
    await approveContribution(api, sub.id, ADMIN, { type: "no_reward" });
    assertEquals((await retryContributionReward(api, sub.id, ADMIN)).ok, false);
  } finally {
    await kv.close();
  }
});
