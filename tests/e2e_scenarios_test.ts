/**
 * Underground Manager — End-to-end scenarios A–G
 *
 * These drive the REAL bot (all middleware + composers) with synthetic Telegram
 * updates against an in-memory Deno KV and a fake Bot API transport. They prove
 * the application logic end to end; they do NOT prove live Telegram behaviour
 * (real Stars charges, real chat membership, forum media browsing) — see the
 * "Manual verification" section of docs/AUDIT_REPORT.md.
 *
 * "Time passing" is simulated by rewriting stored expiry timestamps into the past
 * (the same field Telegram's subscription_expiration_date populates).
 */

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { MOCK_CONFIG, setupTestEnvironment } from "./test_helpers.ts";
import {
  callback,
  chatJoinRequest,
  createFakeTelegram,
  FakeTelegram,
  forumMessage,
  preCheckout,
  privateMessage,
  successfulPayment,
  groupMessage,
} from "./bot_harness.ts";
import { TelegramStarsProvider } from "../src/payments/stars.ts";
import {
  getActiveUserEntitlements,
  getMembershipSummary,
  getUserEntitlements,
  mutateEntitlement,
} from "../src/db/entitlements.ts";
import { getUserPayments } from "../src/db/payments.ts";
import { getSyncState } from "../src/db/sync.ts";
import { runDailyIfDue, runHourlyReconciliation } from "../src/cron/reconciliation.ts";
import { grantComplimentaryAccess, processComplimentaryReminders } from "../src/complimentary/service.ts";
import { listCreators } from "../src/db/creators.ts";
import { getDirectorySyncState } from "../src/db/directory.ts";
import { getActiveBallot, getBallot, listPastBallots } from "../src/db/voting.ts";
import { listWantedCandidates, getWantedCandidate, updateWantedStatus } from "../src/db/wanted.ts";
import { getTreasuryOverview } from "../src/treasury/service.ts";
import { prepareMonthlyBallot } from "../src/voting/service.ts";
import { getAllJournalBalances, listStarTransactions } from "../src/db/treasury.ts";
import { reconcileStarHoldingStatuses } from "../src/treasury/stars_tracking.ts";
import { generateMonthlyTreasuryReport } from "../src/treasury/reports.ts";
import { listExpenses } from "../src/db/expenses.ts";
// The Regular plan covers the original three spaces (Retro is covered in the UG-04 suites).
import { REGULAR_SPACE_IDS as SPACE_IDS } from "../src/types.ts";

const ADMIN = MOCK_CONFIG.ADMIN_USER_IDS[0];
const VIP = MOCK_CONFIG.VIP_COLLECTIONS_CHAT_ID;
const WANTED = MOCK_CONFIG.WANTED_LIST_CHAT_ID;
const GENERAL = MOCK_CONFIG.GENERAL_CHAT_ID;
const ALL_CHATS = [VIP, WANTED, GENERAL];
const DAY = 86_400_000;

async function withApp(fn: (tg: FakeTelegram) => Promise<void>) {
  const kv = await setupTestEnvironment();
  try {
    const tg = await createFakeTelegram();
    await fn(tg);
  } finally {
    await kv.close();
  }
}

/** Runs the bot's own "subscribe" flow and returns the invoice payload the bot issued. */
async function startSubscription(tg: FakeTelegram, userId: number): Promise<string> {
  await tg.send(callback(userId, "member:pay_stars"));
  const invoice = tg.callsOf("createInvoiceLink").at(-1)!;
  assertEquals(invoice.payload.currency, "XTR");
  assertEquals(invoice.payload.subscription_period, 2592000);
  return String(invoice.payload.payload);
}

async function pay(
  tg: FakeTelegram,
  userId: number,
  chargeId: string,
  payload: string,
  expiresInMs = 30 * DAY,
  first = false
) {
  await tg.send(
    successfulPayment(userId, {
      chargeId,
      payload,
      expiresUnix: Math.floor((Date.now() + expiresInMs) / 1000),
      first,
    })
  );
}

/** Simulates the paid/complimentary period running out. */
async function letEntitlementsLapse(userId: number) {
  for (const e of await getUserEntitlements(userId)) {
    await mutateEntitlement(e.id, (cur) => ({ ...cur, expiresAt: new Date(Date.now() - 60_000).toISOString() }));
  }
}

async function requestAllSpaces(tg: FakeTelegram, userId: number) {
  for (const chat of ALL_CHATS) await tg.send(chatJoinRequest(chat, userId));
}

// ---------------------------------------------------------------------------
// Scenario A — Paid member
// ---------------------------------------------------------------------------
Deno.test("E2E A — Paid member: pay, admitted to all spaces, renew, access stays continuous", async () => {
  await withApp(async (tg) => {
    const userId = 7001;

    await tg.send(privateMessage(userId, "/start"));
    assert(tg.callsOf("sendMessage").length > 0, "bot answers /start");

    const payload = await startSubscription(tg, userId);

    // Telegram asks for approval of the first charge
    await tg.send(preCheckout(userId, payload));
    assertEquals(tg.callsOf("answerPreCheckoutQuery").at(-1)!.payload.ok, true);

    // Money moves; Telegram confirms with its own expiry timestamp
    const firstExpiry = Math.floor((Date.now() + 30 * DAY) / 1000);
    await tg.send(successfulPayment(userId, { chargeId: "chg_A_1", payload, expiresUnix: firstExpiry, first: true }));

    let summary = await getMembershipSummary(userId);
    assertEquals(summary.hasPaid, true);
    assertEquals(summary.accessibleSpaces.length, 3);
    assertEquals(summary.effectiveExpiry, new Date(firstExpiry * 1000).toISOString());

    // Private-space admission through approval-gated join requests
    await requestAllSpaces(tg, userId);
    assertEquals(tg.callsOf("approveChatJoinRequest").length, 3);
    assertEquals(tg.callsOf("declineChatJoinRequest").length, 0);
    for (const s of SPACE_IDS) assertEquals((await getSyncState(userId, s))?.status, "admitted");

    // Renewal arrives with the next real Telegram expiry (no pre_checkout for renewals)
    const secondExpiry = Math.floor((Date.now() + 60 * DAY) / 1000);
    await tg.send(successfulPayment(userId, { chargeId: "chg_A_2", payload, expiresUnix: secondExpiry }));

    summary = await getMembershipSummary(userId);
    // The Telegram timestamp is authoritative (not "old expiry + 30 days")
    assertEquals(summary.effectiveExpiry, new Date(secondExpiry * 1000).toISOString());
    assertEquals((await getUserPayments(userId)).length, 2);
    assertEquals((await getActiveUserEntitlements(userId)).length, 1, "renewal extends, never stacks");

    // Hourly reconciliation must not touch a paying member
    await runHourlyReconciliation(tg.bot);
    assertEquals(tg.callsOf("banChatMember").length, 0);
  });
});

Deno.test("E2E A — Replayed webhook and re-delivered charge never double-credit", async () => {
  await withApp(async (tg) => {
    const userId = 7002;
    const payload = await startSubscription(tg, userId);
    const expiry = Math.floor((Date.now() + 30 * DAY) / 1000);
    const update = successfulPayment(userId, { chargeId: "chg_A_dup", payload, expiresUnix: expiry });

    // Same update_id delivered twice (Telegram retry / replay attack)
    await tg.send({ update_id: 424242, ...update });
    await tg.send({ update_id: 424242, ...update });
    // Same charge under a NEW update_id (e.g. re-sent service message)
    await tg.send(update);

    assertEquals((await getUserPayments(userId)).length, 1);
    const ents = await getUserEntitlements(userId);
    assertEquals(ents.length, 1);
    assertEquals(ents[0].expiresAt, new Date(expiry * 1000).toISOString());
  });
});

// ---------------------------------------------------------------------------
// Scenario B — Expired member
// ---------------------------------------------------------------------------
Deno.test("E2E B — Expired member is removed from every space; renewal restores access", async () => {
  await withApp(async (tg) => {
    const userId = 7003;
    const payload = await startSubscription(tg, userId);
    await pay(tg, userId, "chg_B_1", payload);
    await requestAllSpaces(tg, userId);

    // Cancelled / failed renewal: paid period ends
    await letEntitlementsLapse(userId);
    assertEquals((await getMembershipSummary(userId)).isMember, false);

    await runHourlyReconciliation(tg.bot);
    const banned = tg.callsOf("banChatMember").map((c) => c.payload.chat_id).sort();
    assertEquals(banned, [...ALL_CHATS].sort());
    assertEquals(tg.callsOf("unbanChatMember").length, 3, "ban+unban so the member can rejoin later");
    for (const s of SPACE_IDS) assertEquals((await getSyncState(userId, s))?.status, "removed");

    // A lapsed member requesting to rejoin is declined
    tg.reset();
    await tg.send(chatJoinRequest(VIP, userId));
    assertEquals(tg.callsOf("declineChatJoinRequest").length, 1);

    // Resubscribes: access is restored without admin involvement
    const payload2 = await startSubscription(tg, userId);
    await pay(tg, userId, "chg_B_2", payload2);
    tg.reset();
    await requestAllSpaces(tg, userId);
    assertEquals(tg.callsOf("approveChatJoinRequest").length, 3);
  });
});

Deno.test("E2E B — Entitlement still valid is never removed, even if renewal lands during reconciliation", async () => {
  await withApp(async (tg) => {
    const userId = 7004;
    const payload = await startSubscription(tg, userId);
    await pay(tg, userId, "chg_B_race_1", payload);
    await requestAllSpaces(tg, userId);
    await letEntitlementsLapse(userId);

    // The member renews right as the hourly job runs: reconciliation first sees the
    // lapsed state, then (inside the Telegram round-trip) the renewal commits.
    const originalGetChatMember = tg.bot.api.config.use.bind(tg.bot.api.config);
    void originalGetChatMember;
    let renewed = false;
    tg.bot.api.config.use(async (prev, method, payload2, signal) => {
      if (method === "getChatMember" && !renewed) {
        renewed = true;
        await pay(tg, userId, "chg_B_race_2", payload);
      }
      return prev(method, payload2, signal);
    });

    await runHourlyReconciliation(tg.bot);
    assertEquals(tg.callsOf("banChatMember").length, 0, "a renewed member must not be banned");
    assertEquals((await getMembershipSummary(userId)).hasPaid, true);
  });
});

Deno.test("E2E B — Refund withdraws the access it paid for", async () => {
  await withApp(async (tg) => {
    const userId = 7005;
    const payload = await startSubscription(tg, userId);
    await pay(tg, userId, "chg_B_refund", payload);
    assertEquals((await getMembershipSummary(userId)).hasPaid, true);

    await tg.send({ ...(await import("./bot_harness.ts")).refundedPayment(userId, "chg_B_refund", payload) });
    assertEquals((await getMembershipSummary(userId)).hasPaid, false);
    const payments = await getUserPayments(userId);
    assertEquals(payments[0].status, "refunded");

    await runHourlyReconciliation(tg.bot);
  });
});

// ---------------------------------------------------------------------------
// Scenario C — Complimentary member
// ---------------------------------------------------------------------------
Deno.test("E2E C — Complimentary 30 days: grant, admit, reminder, expiry, removal", async () => {
  await withApp(async (tg) => {
    const userId = 7101;

    // Administrator grants through the bot UI (callback chain end)
    await tg.send(callback(ADMIN, `admin:grant_cfm:${userId}:30:content_contribution:full`));
    let summary = await getMembershipSummary(userId);
    assertEquals(summary.hasComplimentary, true);
    assertEquals(summary.hasPaid, false);
    const days = Math.round((new Date(summary.effectiveExpiry!).getTime() - Date.now()) / DAY);
    assertEquals(days, 30);

    await requestAllSpaces(tg, userId);
    assertEquals(tg.callsOf("approveChatJoinRequest").length, 3);

    // 3-day reminder
    const [ent] = await getUserEntitlements(userId);
    await mutateEntitlement(ent.id, (c) => ({ ...c, expiresAt: new Date(Date.now() + 2 * DAY).toISOString() }));
    tg.reset();
    const rem = await processComplimentaryReminders(tg.bot.api);
    assertEquals(rem.remindedCount, 1);
    assertEquals(tg.callsOf("sendMessage")[0].payload.chat_id, userId);
    // not sent twice
    assertEquals((await processComplimentaryReminders(tg.bot.api)).remindedCount, 0);

    // Expiry -> automatic removal
    await letEntitlementsLapse(userId);
    await runHourlyReconciliation(tg.bot);
    assertEquals(tg.callsOf("banChatMember").length, 3);
  });
});

Deno.test("E2E C — Complimentary→paid conversion has no gap; expiring comp never removes a paying member", async () => {
  await withApp(async (tg) => {
    const userId = 7102;
    await grantComplimentaryAccess({ adminId: ADMIN, userId, durationDays: 30, reason: "promotion", level: "full" });
    await requestAllSpaces(tg, userId);

    const payload = await startSubscription(tg, userId);
    await pay(tg, userId, "chg_C_conv", payload);

    // The complimentary entitlement lapses first; the paid one carries on
    const comp = (await getUserEntitlements(userId)).find((e) => e.source === "complimentary")!;
    await mutateEntitlement(comp.id, (c) => ({ ...c, expiresAt: new Date(Date.now() - 1000).toISOString() }));

    await runHourlyReconciliation(tg.bot);
    assertEquals(tg.callsOf("banChatMember").length, 0);
    const summary = await getMembershipSummary(userId);
    assertEquals(summary.hasPaid, true);
    assertEquals(summary.accessibleSpaces.length, 3);
  });
});

Deno.test("E2E C — Narrow complimentary level only keeps its own spaces when paid time ends", async () => {
  await withApp(async (tg) => {
    const userId = 7103;
    await grantComplimentaryAccess({ adminId: ADMIN, userId, durationDays: 30, reason: "partnership", level: "vip_only" });
    const payload = await startSubscription(tg, userId);
    await pay(tg, userId, "chg_C_narrow", payload);
    await requestAllSpaces(tg, userId);

    const paid = (await getUserEntitlements(userId)).find((e) => e.source === "telegram_stars")!;
    await mutateEntitlement(paid.id, (c) => ({ ...c, expiresAt: new Date(Date.now() - 1000).toISOString() }));
    await runHourlyReconciliation(tg.bot);

    const banned = tg.callsOf("banChatMember").map((c) => c.payload.chat_id).sort();
    assertEquals(banned, [GENERAL, WANTED].sort(), "removed only from spaces with no remaining entitlement");
  });
});

// ---------------------------------------------------------------------------
// Scenario D — Creator content
// ---------------------------------------------------------------------------
Deno.test("E2E D — Creator topic, multiple uploads, one daily directory update", async () => {
  await withApp(async (tg) => {
    // Admin creates a topic; a member's topic is ignored
    await tg.send(forumMessage(VIP, ADMIN, 501, "topic_created", { name: "Anna_Lee" }));
    await tg.send(forumMessage(VIP, 555, 502, "topic_created", { name: "Intruder" }));
    let creators = await listCreators();
    assertEquals(creators.map((c) => c.name), ["Anna_Lee"]);
    assertEquals(creators[0].hasContent, false);

    // Non-content activity and non-admin uploads change nothing
    await tg.send(forumMessage(VIP, ADMIN, 501, "text"));
    await tg.send(forumMessage(VIP, 555, 501, "photo"));
    assertEquals((await listCreators())[0].hasContent, false);

    // Admin uploads several photos/videos (an album arrives as separate messages)
    const t1 = Math.floor(Date.now() / 1000) - 600;
    await tg.send(forumMessage(VIP, ADMIN, 501, "photo", { date: t1 }));
    await tg.send(forumMessage(VIP, ADMIN, 501, "photo", { date: t1 + 1 }));
    await tg.send(forumMessage(VIP, ADMIN, 501, "video", { date: t1 + 2 }));
    // A late/out-of-order delivery must not rewind the last-update date
    await tg.send(forumMessage(VIP, ADMIN, 501, "photo", { date: t1 - 5000 }));
    creators = await listCreators();
    assertEquals(creators[0].hasContent, true);
    assertEquals(creators[0].lastContentUpdatedAt, new Date((t1 + 2) * 1000).toISOString());

    // Daily synchronization (Toronto 03:00 default; the hourly tick decides when)
    const noonUtc = new Date();
    noonUtc.setUTCHours(15, 0, 0, 0); // 10–11 AM Toronto: after the 03:00 mark
    tg.reset();
    const first = await runDailyIfDue(tg.bot, noonUtc);
    assertEquals(first.ran, true);
    const posted = tg.callsOf("sendMessage").filter((c) => c.payload.chat_id === MOCK_CONFIG.PUBLIC_DIRECTORY_CHAT_ID);
    assertEquals(posted.length, 2, "one post per collection");
    assert(String(posted[0].payload.text).includes("Anna\\_Lee"), "name is markdown-escaped");
    assert(String(posted[0].payload.text).includes("(4)"), "all four media messages are counted");
    assert(String(posted[1].payload.text).includes("*qui ne sont plus en activité*"));

    // Same day again, and an hourly tick with nothing new: no Telegram traffic at all
    tg.reset();
    assertEquals((await runDailyIfDue(tg.bot, noonUtc)).ran, false);
    assertEquals(tg.calls.filter((c) => c.payload.chat_id === MOCK_CONFIG.PUBLIC_DIRECTORY_CHAT_ID).length, 0);
    assertEquals((await getDirectorySyncState()).isDirty, false);

    // Another upload changes the count: edit only the existing Regular post.
    await tg.send(forumMessage(VIP, ADMIN, 501, "photo", { date: Math.floor((Date.now() + 2 * DAY) / 1000) }));
    const nextDay = new Date(noonUtc.getTime() + DAY);
    tg.reset();
    assertEquals((await runDailyIfDue(tg.bot, nextDay)).ran, true);
    const dirCalls = tg.calls.filter((c) => c.payload.chat_id === MOCK_CONFIG.PUBLIC_DIRECTORY_CHAT_ID);
    assertEquals(dirCalls.map((c) => c.method), ["editMessageText"]);
  });
});

// ---------------------------------------------------------------------------
// Scenario E — Community voting
// ---------------------------------------------------------------------------
async function makePaidMember(tg: FakeTelegram, userId: number) {
  const payload = await startSubscription(tg, userId);
  await pay(tg, userId, `chg_member_${userId}`, payload);
}

Deno.test("E2E E — Nominate, support, ballot, vote, winner awaits administrator approval", async () => {
  await withApp(async (tg) => {
    const [m1, m2, m3, m4] = [7201, 7202, 7203, 7204];
    const comp = 7205;
    for (const m of [m1, m2, m3, m4]) await makePaidMember(tg, m);
    await grantComplimentaryAccess({ adminId: ADMIN, userId: comp, durationDays: 30, reason: "promotion", level: "full" });

    // Members use the bot (this is the path that the old global admin gate blocked)
    tg.reset();
    await tg.send(privateMessage(m1, "/suggest Aria Moon"));
    assert(String(tg.callsOf("sendMessage").at(-1)!.payload.text).includes("Suggestion soumise"));
    await tg.send(privateMessage(m2, "/suggest  aria   moon")); // duplicate with other casing/spaces
    await tg.send(privateMessage(m3, "/suggest Bella Rose"));
    await tg.send(privateMessage(m4, "/suggest Chloe Sky"));
    // one selection per cycle
    await tg.send(privateMessage(m1, "/suggest Someone Else"));
    assert(String(tg.callsOf("sendMessage").at(-1)!.payload.text).includes("déjà utilisé"));
    // complimentary members are excluded
    await tg.send(privateMessage(comp, "/suggest Dina Vale"));
    assert(String(tg.callsOf("sendMessage").at(-1)!.payload.text).includes("payants"));

    let candidates = await listWantedCandidates();
    assertEquals(candidates.length, 3, "Aria nominated twice -> one candidate");
    const aria = candidates.find((c) => c.name === "Aria Moon")!;
    assertEquals(aria.supportCount, 2);

    // Administrator approves the shortlist (only Aria + Bella go on the ballot)
    for (const c of candidates) await updateWantedStatus(c.id, "eligible_for_voting");
    await tg.send(callback(ADMIN, "admin:launch_ballot"));
    const ballot = (await getActiveBallot())!;
    assertNotEquals(ballot, null);
    const closesInDays = Math.round((new Date(ballot.closesAt).getTime() - Date.now()) / DAY);
    assertEquals(closesInDays, 5);

    // A second ballot cannot be opened over a running one
    tg.reset();
    await tg.send(callback(ADMIN, "admin:launch_ballot"));
    assert(String(tg.callsOf("answerCallbackQuery").at(-1)!.payload.text).includes("déjà ouvert"));

    const ariaId = aria.id;
    const bella = candidates.find((c) => c.name === "Bella Rose")!;
    // 3 votes Aria, 1 vote Bella
    for (const m of [m1, m2, m3]) await tg.send(callback(m, `vote:exec:${ballot.id}:${ariaId}`));
    await tg.send(callback(m4, `vote:exec:${ballot.id}:${bella.id}`));

    // Votes are final; complimentary members cannot vote
    tg.reset();
    await tg.send(callback(m4, `vote:exec:${ballot.id}:${ariaId}`));
    assert(String(tg.callsOf("answerCallbackQuery").at(-1)!.payload.text).includes("déjà voté"));
    await tg.send(callback(comp, `vote:exec:${ballot.id}:${ariaId}`));
    assert(String(tg.callsOf("answerCallbackQuery").at(-1)!.payload.text).includes("payants"));

    // The voting screen never discloses running results
    tg.reset();
    await tg.send(callback(m1, "vote:open"));
    const screens = tg.calls.filter((c) => c.method === "editMessageText").map((c) => String(c.payload.text)).join("\n");
    assert(!/\d+ votes?/.test(screens), "no running tallies shown");

    // The audit trail records that members voted, not what they voted for
    const { listAuditEvents } = await import("../src/db/audit.ts");
    const voteEvents = (await listAuditEvents(200)).filter((e) => e.type === "vote_cast");
    assertEquals(voteEvents.length, 4);
    for (const e of voteEvents) assertEquals("candidateId" in e.details, false);

    // Voting window passes; the hourly job closes it (also covers a restart: a fresh bot
    // instance over the same database sees the same ballot)
    const b = (await getBallot(ballot.id))!;
    const { updateBallot } = await import("../src/db/voting.ts");
    await updateBallot({ ...b, closesAt: new Date(Date.now() - 1000).toISOString() });
    const restarted = await createFakeTelegram();
    await runHourlyReconciliation(restarted.bot);

    const closed = (await getBallot(ballot.id))!;
    assertEquals(closed.status, "closed");
    assertEquals(closed.winnerCandidateId, ariaId);
    assertEquals((await getWantedCandidate(ariaId))!.status, "selected");
    assertEquals((await getWantedCandidate(bella.id))!.status, "eligible_for_voting", "losers return to the pool");
    assert(restarted.callsOf("sendMessage").some((c) => String(c.payload.text).includes("Gagnant")));
    // Awaiting administrator approval: nothing purchased or committed automatically
    assertEquals((await listExpenses()).length, 0);
    assertEquals((await getActiveBallot()), null);
  });
});

Deno.test("E2E E — Tie opens exactly one runoff, even if two workers close simultaneously", async () => {
  await withApp(async (tg) => {
    const [m1, m2] = [7211, 7212];
    for (const m of [m1, m2]) await makePaidMember(tg, m);
    await tg.send(privateMessage(m1, "/suggest Tie One"));
    await tg.send(privateMessage(m2, "/suggest Tie Two"));
    for (const c of await listWantedCandidates()) await updateWantedStatus(c.id, "eligible_for_voting");
    const ballot = await prepareMonthlyBallot({ adminId: ADMIN });
    const [a, b] = ballot.candidates;
    await tg.send(callback(m1, `vote:exec:${ballot.id}:${a.candidateId}`));
    await tg.send(callback(m2, `vote:exec:${ballot.id}:${b.candidateId}`));

    const { closeAndFinalizeBallot } = await import("../src/voting/service.ts");
    await Promise.all([
      closeAndFinalizeBallot(ballot.id, tg.bot.api),
      closeAndFinalizeBallot(ballot.id, tg.bot.api),
      closeAndFinalizeBallot(ballot.id, tg.bot.api),
    ]);

    const all = await listPastBallots(20);
    const runoffs = all.filter((x) => x.isRunoff);
    assertEquals(runoffs.length, 1);
    assertEquals(runoffs[0].status, "active");
    assertEquals((await getActiveBallot())!.id, runoffs[0].id);
    const announcements = tg.callsOf("sendMessage").filter((c) => String(c.payload.text).includes("SECOND TOUR"));
    assertEquals(announcements.length, 1, "tie announced once");
  });
});

// ---------------------------------------------------------------------------
// Scenario F — Financial lifecycle
// ---------------------------------------------------------------------------
Deno.test("E2E F — Stars → pending → withdrawal → settlement → expense → acquisition budget → report", async () => {
  await withApp(async (tg) => {
    // Payment creates pending Stars, not cash
    const payload = await startSubscription(tg, 7301);
    await pay(tg, 7301, "chg_F_1", payload);
    let o = await getTreasuryOverview();
    assertEquals(o.totalStarsReceived, 750);
    assertEquals(o.pendingStars, 750);
    assertEquals(o.settledNetCashCadMinor, 0);
    assertEquals(o.availableAcquisitionBudgetCadMinor, 0);

    // Hold elapses (simulated) -> withdrawable estimate, still not cash
    const [tx] = await listStarTransactions();
    const kv = await (await import("../src/db/kv.ts")).getKv();
    await kv.set(["star_transactions", tx.id], { ...tx, holdingPeriodEndsAt: new Date(Date.now() - 1000).toISOString() });
    await reconcileStarHoldingStatuses();
    o = await getTreasuryOverview();
    assertEquals(o.potentiallyWithdrawableStars, 750);
    assertEquals(o.settledNetCashCadMinor, 0);

    // Admin records the withdrawal; TON not yet converted -> still no cash
    await tg.send(privateMessage(ADMIN, "/record_withdrawal 750 2.5"));
    assertEquals((await getTreasuryOverview()).settledNetCashCadMinor, 0);

    // Real settlement (with Fragment reference); a double submission is refused
    tg.reset();
    await tg.send(privateMessage(ADMIN, "/record_withdrawal 750 2.5 100.00 FRAG-1"));
    await tg.send(privateMessage(ADMIN, "/record_withdrawal 750 2.5 100.00 FRAG-1"));
    assert(String(tg.callsOf("sendMessage").at(-1)!.payload.text).includes("already recorded"));
    o = await getTreasuryOverview();
    assertEquals(o.settledNetCashCadMinor, 10000);
    assertEquals(o.allocatedAcquisitionsCadMinor, 6000);
    assertEquals(o.allocatedOperationsCadMinor, 2500);
    assertEquals(o.allocatedReserveCadMinor, 1500);
    assertEquals(o.withdrawnStars, 750);

    // Changing the percentages affects only FUTURE settlements
    const { saveTreasuryAllocations } = await import("../src/db/treasury.ts");
    await saveTreasuryAllocations({ acquisitionPct: 50, operationsPct: 30, reservePct: 20, effectiveDate: new Date().toISOString() });
    assertEquals((await getTreasuryOverview()).allocatedAcquisitionsCadMinor, 6000);
    await saveTreasuryAllocations({ acquisitionPct: 60, operationsPct: 25, reservePct: 15, effectiveDate: new Date().toISOString() });

    // Expense entry through the bot: decimal-exact, double-tap safe
    await tg.send(privateMessage(ADMIN, "/record_expense 10.05 USD platform_operations club_funds Hosting"));
    const confirm = tg.callsOf("sendMessage").at(-1)!;
    const draftBtn = JSON.stringify(confirm.payload.reply_markup);
    const draftId = /admin:exp_cfm:([a-f0-9-]+)/.exec(draftBtn)![1];
    await Promise.all([
      tg.send(callback(ADMIN, `admin:exp_cfm:${draftId}`)),
      tg.send(callback(ADMIN, `admin:exp_cfm:${draftId}`)),
    ]);
    const expenses = await listExpenses();
    assertEquals(expenses.length, 1, "double-tap on Confirm records one expense");
    assertEquals(expenses[0].originalAmountMinor, 1005);
    assertEquals(expenses[0].originalCurrency, "USD");
    assertEquals(expenses[0].cadAmountMinor, Math.round(1005 * 1.36));
    assertEquals(expenses[0].fxRateSource === undefined, false, "FX provenance stored");

    // Acquisition: price, approve (reserves budget), confirm paid (exactly once)
    const { createWantedCandidate } = await import("../src/db/wanted.ts");
    const cand = await createWantedCandidate({ name: "Winner", normalizedName: "winner", status: "selected", suggestedBy: 1, supportCount: 3 });
    await tg.send(privateMessage(ADMIN, `/price ${cand.id} 20.00 CAD`));
    await tg.send(callback(ADMIN, `admin:acq_approve:${cand.id}`));
    await tg.send(callback(ADMIN, `admin:acq_approve:${cand.id}`)); // double-tap
    o = await getTreasuryOverview();
    assertEquals(o.committedAcquisitionsCadMinor, 2000, "one commitment only");
    assertEquals(o.availableAcquisitionBudgetCadMinor, 6000 - 2000);

    await Promise.all([
      tg.send(callback(ADMIN, `admin:acq_paid:${cand.id}:club_funds`)),
      tg.send(callback(ADMIN, `admin:acq_paid:${cand.id}:club_funds`)),
    ]);
    o = await getTreasuryOverview();
    assertEquals(o.committedAcquisitionsCadMinor, 0);
    assertEquals(o.paidAcquisitionsCadMinor, 2000, "paid once, not twice");
    assertEquals(o.availableAcquisitionBudgetCadMinor, 4000);
    assertEquals((await getWantedCandidate(cand.id))!.status, "acquired");

    // Ledger and overview agree to the cent
    const j = await getAllJournalBalances();
    assertEquals(j.acquisition_fund, o.allocatedAcquisitionsCadMinor - o.paidAcquisitionsCadMinor);
    assertEquals(j.settled_cash, o.cashOnHandCadMinor);

    // Monthly report reproduces the same numbers and reports in-period flows
    const report = await generateMonthlyTreasuryReport();
    assertEquals(report.overview.availableAcquisitionBudgetCadMinor, 4000);
    assertEquals(report.periodActivity!.settledCashCadMinor, 10000);
    assertEquals(report.periodActivity!.starsReceived, 750);
  });
});

// ---------------------------------------------------------------------------
// Scenario G — Failure recovery
// ---------------------------------------------------------------------------
Deno.test("E2E G — Crash between 'payment recorded' and 'access granted' self-heals exactly once", async () => {
  await withApp(async (tg) => {
    const userId = 7401;
    const payload = TelegramStarsProvider.buildInvoicePayload(userId);
    const { recordPayment } = await import("../src/db/payments.ts");

    // Process died / DB failed right after step 1 of 2
    const expiry = new Date(Date.now() + 30 * DAY).toISOString();
    await recordPayment({
      userId, provider: "telegram_stars", chargeId: "chg_G_1", providerChargeId: "p",
      amount: 750, currency: "XTR", invoicePayload: payload, subscriptionPeriodSeconds: 2592000,
      subscriptionExpirationDate: expiry, isRecurring: true, status: "completed",
    });
    assertEquals((await getMembershipSummary(userId)).isMember, false);

    // Hourly job completes it
    const res = await runHourlyReconciliation(tg.bot);
    assertEquals(res.recoveredPayments, 1);
    const ents = await getUserEntitlements(userId);
    assertEquals(ents.length, 1);
    assertEquals(ents[0].expiresAt, expiry);

    // Telegram's retry of the original update afterwards is a harmless duplicate
    await tg.send(successfulPayment(userId, { chargeId: "chg_G_1", payload, expiresUnix: Math.floor(Date.parse(expiry) / 1000) }));
    assertEquals((await getUserEntitlements(userId)).length, 1);
    assertEquals((await getUserPayments(userId)).length, 1);
    // and a second recovery pass finds nothing left
    assertEquals((await runHourlyReconciliation(tg.bot)).recoveredPayments, 0);
  });
});

Deno.test("E2E G — Telegram API failure while removing an expired member is retried until it succeeds", async () => {
  await withApp(async (tg) => {
    const userId = 7402;
    const payload = await startSubscription(tg, userId);
    await pay(tg, userId, "chg_G_2", payload);
    await requestAllSpaces(tg, userId);
    await letEntitlementsLapse(userId);

    tg.failing.set("banChatMember", "Bad Gateway");
    await runHourlyReconciliation(tg.bot);
    assertEquals((await getSyncState(userId, "vip_collections"))?.status, "error");
    assert(tg.callsOf("sendMessage").some((c) => ADMIN === c.payload.chat_id), "admins are alerted");

    // Telegram recovers; the very next hourly run finishes the job
    tg.failing.clear();
    tg.reset();
    await runHourlyReconciliation(tg.bot);
    assertEquals(tg.callsOf("banChatMember").length, 3);
    for (const s of SPACE_IDS) assertEquals((await getSyncState(userId, s))?.status, "removed");
  });
});

Deno.test("E2E G — An expired member who is already gone from Telegram is simply marked removed", async () => {
  await withApp(async (tg) => {
    const userId = 7403;
    const payload = await startSubscription(tg, userId);
    await pay(tg, userId, "chg_G_3", payload);
    await requestAllSpaces(tg, userId);
    await letEntitlementsLapse(userId);
    for (const chat of ALL_CHATS) tg.memberStatus.set(`${chat}:${userId}`, "left");
    await runHourlyReconciliation(tg.bot);
    assertEquals(tg.callsOf("banChatMember").length, 0);
    assertEquals((await getSyncState(userId, "general_chat"))?.status, "removed");
  });
});

Deno.test("E2E G — Non-admins cannot reach privileged actions, and group chatter gets no replies", async () => {
  await withApp(async (tg) => {
    const intruder = 9999;
    await tg.send(callback(intruder, `admin:grant_cfm:${intruder}:30:promotion:full`));
    assertEquals((await getMembershipSummary(intruder)).isMember, false);
    await tg.send(privateMessage(intruder, "/record_withdrawal 1000 5 500.00 X"));
    await tg.send(callback(intruder, "admin:treasury_menu"));
    assertEquals((await getTreasuryOverview()).settledNetCashCadMinor, 0);

    // Ordinary group messages must not trigger "Access Denied" spam
    tg.reset();
    await tg.send(groupMessage(GENERAL, intruder, "hello everyone"));
    await tg.send(groupMessage(GENERAL, intruder, "/admin"));
    assertEquals(tg.callsOf("sendMessage").length, 0);
  });
});
