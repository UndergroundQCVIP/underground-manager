/**
 * LA CONFRÉRIE — UG-07 Pre-Publish Test Suite: POINTS, LEADERBOARD & MONTHLY PRIZE
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { MOCK_CONFIG, MockTelegramApi, setupTestEnvironment } from "./test_helpers.ts";
import { MockMigrationApi, pay, seedCreator } from "./ug04_helpers.ts";
import { cb, makeBot, text } from "./ug05_harness.ts";
import { setConfigForTesting } from "../src/config.ts";
import { TelegramStarsProvider } from "../src/payments/stars.ts";
import { addPoints, getTotals, getPrize } from "../src/db/points.ts";
import { upsertMember } from "../src/db/members.ts";
import { getKv } from "../src/db/kv.ts";
import { updateSystemSettings } from "../src/db/settings.ts";
import {
  addContributionItem,
  approveContribution,
  finishContribution,
  rejectContribution,
  resolvePartialPublication,
  startContribution,
} from "../src/contributions/service.ts";
import { attributeReferral } from "../src/referrals/service.ts";
import { getOrCreateReferralCode } from "../src/db/referrals.ts";
import { awardMonthlyPrize, displayName, myStanding, recalculatePoints, topList } from "../src/points/service.ts";
import { syncLeaderboardPost } from "../src/points/post.ts";
import { grantComplimentaryAccess } from "../src/complimentary/service.ts";
import { getUserEntitlements } from "../src/db/entitlements.ts";
import { torontoMonthCycle } from "../src/util/time.ts";

const ADMIN = 111111;

async function contribute(api: MockMigrationApi, user: number, n: number, decision: Parameters<typeof approveContribution>[3]) {
  const c = await seedCreator({ name: `C${Math.random().toString(36).slice(2, 8)}`, topicId: Math.floor(Math.random() * 1e6) });
  assert((await startContribution(user, c.id)).ok);
  for (let i = 1; i <= n; i++) await addContributionItem(user, { messageId: i, kind: "photo" });
  const sub = (await finishContribution(api, user)).contribution!;
  return { sub, creator: c, result: await approveContribution(api, sub.id, ADMIN, decision) };
}

const nextMonthMiddle = () => {
  const [y, m] = torontoMonthCycle().split("-").map(Number);
  return new Date(Date.UTC(y, m, 15)); // the 15th of NEXT month
};

// -----------------------------------------------------------------------------------------------

Deno.test("UG07 POINTS — Stars: 1 point per 10 Stars, renewals count, duplicates and refunds are handled", async () => {
  const kv = await setupTestEnvironment();
  try {
    await pay(1001, "regular", "ch_p1"); // 750 → 75
    assertEquals((await getTotals(1001)).total, 75);
    await pay(1001, "regular", "ch_p2"); // renewal
    assertEquals((await getTotals(1001)).total, 150);
    await pay(1001, "regular", "ch_p2"); // duplicate webhook
    assertEquals((await getTotals(1001)).total, 150);
    await pay(1002, "retro_plus", "ch_p3"); // 1500 → 150
    assertEquals((await getTotals(1002)).total, 150);

    // refund takes back exactly those points (and only once)
    await TelegramStarsProvider.handleRefund(1001, "ch_p2");
    assertEquals((await getTotals(1001)).total, 75);
    await TelegramStarsProvider.handleRefund(1001, "ch_p2");
    assertEquals((await getTotals(1001)).total, 75);
    assertEquals((await getTotals(1001)).months[torontoMonthCycle()], 75);
  } finally {
    await kv.close();
  }
});

Deno.test("UG07 POINTS — Contributions: 5 per published item, +20 only with a reward; nothing for rejects, partials or complimentary", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockMigrationApi();
    await contribute(api, 2001, 4, { type: "no_reward" });
    assertEquals((await getTotals(2001)).total, 20);

    await contribute(api, 2002, 3, { type: "reward", scopes: ["regular"], days: 10 });
    assertEquals((await getTotals(2002)).total, 15 + 20);

    // rejected → nothing
    const c = await seedCreator({ name: "Zed", topicId: 77 });
    await startContribution(2003, c.id);
    await addContributionItem(2003, { messageId: 1, kind: "photo" });
    const sub = (await finishContribution(api, 2003)).contribution!;
    await rejectContribution(api, sub.id, ADMIN, "non");
    assertEquals((await getTotals(2003)).total, 0);

    // partial publication → no points until the admin resolves; then only what was published
    await startContribution(2004, c.id);
    for (const id of [1, 2, 3]) await addContributionItem(2004, { messageId: id, kind: "photo" });
    const p = (await finishContribution(api, 2004)).contribution!;
    api.missingMessageIds.add(3);
    await approveContribution(api, p.id, ADMIN, { type: "reward", scopes: ["regular"], days: 5 });
    assertEquals((await getTotals(2004)).total, 0);
    await resolvePartialPublication(api, p.id, ADMIN);
    assertEquals((await getTotals(2004)).total, 2 * 5 + 20);
    await resolvePartialPublication(api, p.id, ADMIN); // repeat
    assertEquals((await getTotals(2004)).total, 30);

    // complimentary access never earns points
    await grantComplimentaryAccess({ adminId: ADMIN, userId: 2005, durationDays: 30, reason: "partnership", level: "full" });
    assertEquals((await getTotals(2005)).total, 0);
  } finally {
    await kv.close();
  }
});

Deno.test("UG07 POINTS — Referral join: 25 points to the referrer, once; self and repeat links earn nothing", async () => {
  const kv = await setupTestEnvironment();
  try {
    const code = await getOrCreateReferralCode(3001);
    assert(await attributeReferral({ payload: `ref_${code}`, refereeId: 3002, isNewToBot: true }));
    assertEquals((await getTotals(3001)).total, 25);
    await attributeReferral({ payload: `ref_${code}`, refereeId: 3002, isNewToBot: true });
    await attributeReferral({ payload: `ref_${code}`, refereeId: 3001, isNewToBot: true });
    await attributeReferral({ payload: `ref_${code}`, refereeId: 3003, isNewToBot: false });
    assertEquals((await getTotals(3001)).total, 25);
    await attributeReferral({ payload: `ref_${code}`, refereeId: 3004, isNewToBot: true });
    assertEquals((await getTotals(3001)).total, 50);
  } finally {
    await kv.close();
  }
});

Deno.test("UG07 RANKING — Tabs, ties, month separation, admin exclusion and stable anonymous aliases", async () => {
  const kv = await setupTestEnvironment();
  try {
    const month = torontoMonthCycle();
    const old = "2020-01";
    const now = new Date().toISOString();
    await addPoints({ key: "t:a", userId: 4001, points: 100, reason: "payment", month, at: "2026-10-01T10:00:00Z" });
    await addPoints({ key: "t:b", userId: 4002, points: 100, reason: "payment", month, at: "2026-10-01T09:00:00Z" }); // same score, earlier → ahead
    await addPoints({ key: "t:c", userId: 4003, points: 500, reason: "payment", month: old, at: now });             // big, but last year
    await addPoints({ key: "t:d", userId: ADMIN, points: 9999, reason: "payment", month, at: now });                  // admin: excluded
    await addPoints({ key: "t:e", userId: 4004, points: 30, reason: "payment", month, at: now });

    const monthly = await topList("month");
    assertEquals(monthly.map((r) => r.userId), [4002, 4001, 4004]);
    const all = await topList("all");
    assertEquals(all.map((r) => r.userId), [4003, 4002, 4001, 4004]);
    assert(!all.some((r) => r.userId === ADMIN));

    const me = await myStanding(4001);
    assertEquals([me.month, me.all, me.rankMonth, me.rankAll], [100, 100, 2, 3]);

    // aliases are anonymous, stable and never reveal the real name unless the member opts in
    await upsertMember({ id: 4001, username: "alice", first_name: "Alice" });
    const alias = await displayName(4001);
    assert(/^Anonyme-[0-9A-Z]{4}$/.test(alias));
    assertEquals(await displayName(4001), alias);
    assert(!alias.toLowerCase().includes("alice"));
  } finally {
    await kv.close();
  }
});

Deno.test("UG07 RANKING — 'Who shares the most' ranks referrers by people brought in", async () => {
  const kv = await setupTestEnvironment();
  try {
    const a = await getOrCreateReferralCode(5001);
    const b = await getOrCreateReferralCode(5002);
    for (const id of [6001, 6002, 6003]) await attributeReferral({ payload: `ref_${a}`, refereeId: id, isNewToBot: true });
    await attributeReferral({ payload: `ref_${b}`, refereeId: 6004, isNewToBot: true });
    const refs = await topList("referrers");
    assertEquals(refs.map((r) => [r.userId, r.value]), [[5001, 3], [5002, 1]]);
    assertEquals((await myStanding(5001)).referred, 3);
    assertEquals((await myStanding(5001)).rankReferrers, 1);
  } finally {
    await kv.close();
  }
});

Deno.test("UG07 UI — Menu shows the ranking, my position and the privacy toggle (anonymous by default)", async () => {
  const kv = await setupTestEnvironment();
  try {
    await pay(7001, "regular", "ch_ui");
    await pay(7002, "regular", "ch_ui2");
    const { bot, calls } = makeBot();

    await bot.handleUpdate(text(7001, "/start") as never);
    assertStringIncludes(JSON.stringify(calls.filter((c) => c.method === "sendMessage")), "lb:month");

    await bot.handleUpdate(cb(7001, "lb:month") as never);
    let t = String((calls.filter((c) => c.method === "editMessageText").at(-1)!.payload as { text: string }).text);
    assertStringIncludes(t, "CLASSEMENT");
    assertStringIncludes(t, "Anonyme-");
    assert(!/ U — /.test(t)); // real name hidden by default
    assertStringIncludes(t, "75 pts ce mois-ci");

    await bot.handleUpdate(cb(7001, "lb:name:1:month") as never);
    t = String((calls.filter((c) => c.method === "editMessageText").at(-1)!.payload as { text: string }).text);
    assert(/ U — /.test(t)); // the Telegram name the bot saw (no @username on this test account)
    assertStringIncludes(JSON.stringify(calls.filter((c) => c.method === "editMessageText").at(-1)), "Redevenir anonyme");

    await bot.handleUpdate(cb(7001, "lb:referrers") as never);
    await bot.handleUpdate(cb(7001, "lb:all") as never);
    await bot.handleUpdate(cb(7001, "lb:name:0:all") as never);
    t = String((calls.filter((c) => c.method === "editMessageText").at(-1)!.payload as { text: string }).text);
    assert(!/ U — /.test(t));

    // deep link from the public post
    calls.length = 0;
    await bot.handleUpdate(text(7003, "/start leaderboard") as never);
    assertStringIncludes(JSON.stringify(calls.filter((c) => c.method === "sendMessage")), "CLASSEMENT");
  } finally {
    await kv.close();
  }
});

Deno.test("UG07 PRIZE — Monthly #1 gets +7 days Regular once; none if disabled, no points, or only admins", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockTelegramApi();
    const month = torontoMonthCycle();
    const when = nextMonthMiddle();

    assertEquals(await awardMonthlyPrize(api, when), null); // nobody has points yet

    await addPoints({ key: "p:a", userId: 8001, points: 80, reason: "payment", month, at: "2026-10-02T00:00:00Z" });
    await addPoints({ key: "p:b", userId: 8002, points: 90, reason: "payment", month, at: "2026-10-02T00:00:00Z" });
    await addPoints({ key: "p:c", userId: ADMIN, points: 999, reason: "payment", month, at: "2026-10-02T00:00:00Z" });

    // not due while still inside the month
    assertEquals(await awardMonthlyPrize(api, new Date()), null);

    const prize = await awardMonthlyPrize(api, when);
    assertEquals(prize?.winnerId, 8002);
    assertEquals(prize?.days, 7);
    const ents = (await getUserEntitlements(8002)).filter((e) => e.source === "contribution");
    assertEquals(ents.length, 1);
    assertEquals(ents[0].contributionScope, "regular");
    const d = (new Date(ents[0].expiresAt).getTime() - Date.now()) / 86_400_000;
    assert(d > 6.99 && d <= 7.01);
    assertStringIncludes(api.sentMessages.at(-1)!.text, "Félicitations");
    assertEquals((await getPrize(month))?.winnerId, 8002);

    // once per month, even if called again
    assertEquals(await awardMonthlyPrize(api, when), null);
    assertEquals((await getUserEntitlements(8002)).filter((e) => e.source === "contribution")[0].expiresAt, ents[0].expiresAt);
  } finally {
    await kv.close();
  }
});

Deno.test("UG07 PRIZE — The admin switch disables it", async () => {
  const kv = await setupTestEnvironment();
  try {
    await updateSystemSettings({ leaderboardPrizesEnabled: false });
    await addPoints({ key: "p:z", userId: 8101, points: 50, reason: "payment", month: torontoMonthCycle(), at: "2026-10-02T00:00:00Z" });
    assertEquals(await awardMonthlyPrize(undefined, nextMonthMiddle()), null);
    assertEquals((await getUserEntitlements(8101)).length, 0);
    assertEquals(await getPrize(torontoMonthCycle()), null);
  } finally {
    await kv.close();
  }
});

Deno.test("UG07 RECALC — The whole ledger can be rebuilt from payments, contributions and referrals, idempotently", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockMigrationApi();
    await pay(9001, "regular", "ch_r1");
    await pay(9002, "retro_plus", "ch_r2");
    await TelegramStarsProvider.handleRefund(9002, "ch_r2");
    await contribute(api, 9003, 2, { type: "reward", scopes: ["regular"], days: 4 });
    const code = await getOrCreateReferralCode(9004);
    await attributeReferral({ payload: `ref_${code}`, refereeId: 9005, isNewToBot: true });

    const before = await snapshot();
    assertEquals(before[9001], 75);
    assertEquals(before[9002], 0);
    assertEquals(before[9003], 30);
    assertEquals(before[9004], 25);

    // wipe all points, then rebuild
    const kvh = await getKv();
    for (const prefix of ["points_ledger", "points_total"]) {
      for await (const e of kvh.list({ prefix: [prefix] })) await kvh.delete(e.key);
    }
    assertEquals((await snapshot())[9001] ?? 0, 0);
    await recalculatePoints();
    const rebuilt = await snapshot();
    for (const id of [9001, 9002, 9003, 9004]) assertEquals(rebuilt[id] ?? 0, before[id] ?? 0);
    await recalculatePoints(); // again: no change
    assertEquals(await snapshot(), rebuilt);

    async function snapshot() {
      const out: Record<number, number> = {};
      for (const id of [9001, 9002, 9003, 9004, 9005]) out[id] = (await getTotals(id)).total;
      return out;
    }
  } finally {
    await kv.close();
  }
});

Deno.test("UG07 POST — Optional leaderboard post: off when unconfigured, published once, edited when it changes, anonymous", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockTelegramApi();
    assertEquals((await syncLeaderboardPost(api)).outcome, "not_configured");

    setConfigForTesting({ ...MOCK_CONFIG, TELEGRAM_LEADERBOARD_CHAT_ID: -100555 });
    await upsertMember({ id: 9100, username: "carol", first_name: "Carol" });
    await pay(9100, "regular", "ch_post");
    assertEquals((await syncLeaderboardPost(api)).outcome, "published");
    assertEquals(api.sentMessages.length, 1);
    const post = api.sentMessages[0].text;
    assertStringIncludes(post, "CLASSEMENT");
    assertStringIncludes(post, "Anonyme-");
    assert(!post.includes("carol") && !post.includes("Carol"));
    assertStringIncludes(JSON.stringify(api.sentMessages[0].options), "start=leaderboard");

    assertEquals((await syncLeaderboardPost(api)).outcome, "unchanged");
    await pay(9101, "regular", "ch_post2");
    await pay(9101, "regular", "ch_post3");
    assertEquals((await syncLeaderboardPost(api)).outcome, "updated");
    assertEquals(api.sentMessages.length, 1);
    assertEquals(api.editedMessages.length, 1);
  } finally {
    await kv.close();
  }
});

Deno.test("UG07 ADMIN — Leaderboard settings: admin only; toggle prize, recalc, sync", async () => {
  const kv = await setupTestEnvironment();
  try {
    const { bot, calls } = makeBot();
    await bot.handleUpdate(cb(5555, "admin:lb") as never);
    assertEquals(calls.filter((c) => c.method === "editMessageText").length, 0);

    await bot.handleUpdate(cb(ADMIN, "admin:settings") as never);
    assertStringIncludes(JSON.stringify(calls.filter((c) => c.method === "editMessageText").at(-1)), "Classement");
    await bot.handleUpdate(cb(ADMIN, "admin:lb") as never);
    const screen = String((calls.filter((c) => c.method === "editMessageText").at(-1)!.payload as { text: string }).text);
    assertStringIncludes(screen, "Prix mensuel automatique");
    assertStringIncludes(screen, "activé");

    await bot.handleUpdate(cb(ADMIN, "admin:lb_prize") as never);
    assertStringIncludes(String((calls.filter((c) => c.method === "editMessageText").at(-1)!.payload as { text: string }).text), "désactivé");
    await bot.handleUpdate(cb(ADMIN, "admin:lb_recalc") as never);
    assertStringIncludes(String((calls.filter((c) => c.method === "editMessageText").at(-1)!.payload as { text: string }).text), "Recalcul terminé");
    await bot.handleUpdate(cb(ADMIN, "admin:lb_sync") as never);
    assertStringIncludes(String((calls.filter((c) => c.method === "editMessageText").at(-1)!.payload as { text: string }).text), "non configuré");
  } finally {
    await kv.close();
  }
});
