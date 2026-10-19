/**
 * LA CONFRÉRIE — UG-06 Pre-Publish Test Suite: REFERRALS
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { setupTestEnvironment } from "./test_helpers.ts";
import { MockMigrationApi, pay, seedCreator } from "./ug04_helpers.ts";
import { cb, makeBot, text } from "./ug05_harness.ts";
import { MOCK_CONFIG } from "./test_helpers.ts";
import {
  addContributionItem,
  approveContribution,
  finishContribution,
  startContribution,
  rejectContribution,
} from "../src/contributions/service.ts";
import { getOrCreateReferralCode, getReferralOf, getReferralCodeOwner } from "../src/db/referrals.ts";
import { attributeReferral, awardPaymentBonus, referralBonusDays, referralLink, referralStats, recoverPendingBonuses } from "../src/referrals/service.ts";
import { getUserEntitlements, hasAccessToSpace, getMembershipSummary } from "../src/db/entitlements.ts";
import { getPaymentByChargeId } from "../src/db/payments.ts";
import { updateSystemSettings } from "../src/db/settings.ts";
import { getKv } from "../src/db/kv.ts";

const ADMIN = 111111;
const REFERRER = 9001;
const REFEREE = 9002;
const DAY = 86_400_000;

const contribEnts = async (u: number) => (await getUserEntitlements(u)).filter((e) => e.source === "contribution");
const daysLeft = (iso: string) => (new Date(iso).getTime() - Date.now()) / DAY;

async function submitAndReward(api: MockMigrationApi, user: number, scopes: ("regular" | "retro")[], days: number, ids = [1]) {
  const c = await seedCreator({ name: `C${Math.random().toString(36).slice(2, 7)}`, topicId: Math.floor(Math.random() * 1e6) });
  assert((await startContribution(user, c.id)).ok);
  for (const id of ids) await addContributionItem(user, { messageId: id, kind: "photo" });
  const f = await finishContribution(api, user);
  assert(f.ok, f.error);
  const r = await approveContribution(api, f.contribution!.id, ADMIN, { type: "reward", scopes, days });
  assert(r.ok, r.error);
  return f.contribution!;
}

Deno.test("UG06 CODE — Every user gets one stable, unique personal link", async () => {
  const kv = await setupTestEnvironment();
  try {
    const a = await getOrCreateReferralCode(REFERRER);
    assertEquals(await getOrCreateReferralCode(REFERRER), a); // stable
    const b = await getOrCreateReferralCode(REFEREE);
    assert(a !== b);
    assertEquals(await getReferralCodeOwner(a), REFERRER);
    assertEquals(await referralLink(REFERRER), `https://t.me/${MOCK_CONFIG.BOT_USERNAME}?start=ref_${a}`);
    assert(/^[a-z0-9]{8}$/.test(a));
    // concurrent first requests still produce exactly one code
    const [x, y, z] = await Promise.all([1, 2, 3].map(() => getOrCreateReferralCode(9100)));
    assertEquals(new Set([x, y, z]).size, 1);
  } finally {
    await kv.close();
  }
});

Deno.test("UG06 ATTRIBUTION — First contact only, never self, never replaced, unknown codes ignored", async () => {
  const kv = await setupTestEnvironment();
  try {
    const code = await getOrCreateReferralCode(REFERRER);
    assertEquals(await attributeReferral({ payload: `ref_${code}`, refereeId: REFEREE, isNewToBot: true }), true);
    assertEquals((await getReferralOf(REFEREE))?.referrerId, REFERRER);

    // can't be re-attributed to someone else
    const other = await getOrCreateReferralCode(9003);
    assertEquals(await attributeReferral({ payload: `ref_${other}`, refereeId: REFEREE, isNewToBot: true }), false);
    assertEquals((await getReferralOf(REFEREE))?.referrerId, REFERRER);

    assertEquals(await attributeReferral({ payload: `ref_${code}`, refereeId: REFERRER, isNewToBot: true }), false); // self
    assertEquals(await attributeReferral({ payload: `ref_${code}`, refereeId: 9004, isNewToBot: false }), false); // already knew the bot
    assertEquals(await attributeReferral({ payload: "ref_zzzzzzzz", refereeId: 9005, isNewToBot: true }), false); // unknown
    assertEquals(await attributeReferral({ payload: "creator_x", refereeId: 9006, isNewToBot: true }), false);
    assertEquals(await getReferralOf(9004), null);
  } finally {
    await kv.close();
  }
});

Deno.test("UG06 ATTRIBUTION — Through the real bot: only a brand-new user opening the link is attributed", async () => {
  const kv = await setupTestEnvironment();
  try {
    const code = await getOrCreateReferralCode(REFERRER);
    const { bot } = makeBot();
    await bot.handleUpdate(text(9010, `/start ref_${code}`) as never); // new → attributed
    assertEquals((await getReferralOf(9010))?.referrerId, REFERRER);

    await bot.handleUpdate(text(9011, "/start") as never); // already known after this
    await bot.handleUpdate(text(9011, `/start ref_${code}`) as never);
    assertEquals(await getReferralOf(9011), null);

    await bot.handleUpdate(text(REFERRER, `/start ref_${code}`) as never); // self
    assertEquals(await getReferralOf(REFERRER), null);
  } finally {
    await kv.close();
  }
});

Deno.test("UG06 CONTRIBUTION — referrer gets 50% rounded UP, minimum 1 day, same forums", async () => {
  const kv = await setupTestEnvironment();
  try {
    assertEquals([referralBonusDays(30), referralBonusDays(15), referralBonusDays(7), referralBonusDays(1), referralBonusDays(3)], [15, 8, 4, 1, 2]);

    const api = new MockMigrationApi();
    await attributeReferral({ payload: `ref_${await getOrCreateReferralCode(REFERRER)}`, refereeId: REFEREE, isNewToBot: true });

    // 15 days Retro only → 8 days Retro only (not Regular)
    api.sentMessages.length = 0;
    await submitAndReward(api, REFEREE, ["retro"], 15);
    const ents = await contribEnts(REFERRER);
    assertEquals(ents.length, 1);
    assertEquals(ents[0].contributionScope, "retro");
    assert(Math.abs(daysLeft(ents[0].expiresAt) - 8) < 0.01);
    assertEquals(await hasAccessToSpace(REFERRER, "retro_collections"), true);
    assertEquals(await hasAccessToSpace(REFERRER, "vip_collections"), false);
    // referrer is told, contributor still gets their own full reward
    assert(api.sentMessages.some((m) => m.chatId === REFERRER && m.text.includes("8 jours")));
    assert(api.sentMessages.some((m) => m.chatId === REFEREE && m.text.includes("Récompense : 15 jours")));
    assertEquals((await getMembershipSummary(REFERRER)).canParticipate, true);

    // 7 days on BOTH forums → +4 on each; days accumulate on top of the earlier Retro bonus
    await submitAndReward(api, REFEREE, ["regular", "retro"], 7, [2]);
    const all = await contribEnts(REFERRER);
    const retro = all.find((e) => e.contributionScope === "retro")!;
    const regular = all.find((e) => e.contributionScope === "regular")!;
    assert(Math.abs(daysLeft(retro.expiresAt) - 12) < 0.01); // 8 + 4
    assert(Math.abs(daysLeft(regular.expiresAt) - 4) < 0.01);

    // 1-day reward → 1 day (rounded up from 0.5)
    await submitAndReward(api, REFEREE, ["regular"], 1, [3]);
    assert(Math.abs(daysLeft((await contribEnts(REFERRER)).find((e) => e.contributionScope === "regular")!.expiresAt) - 5) < 0.01);

    const stats = await referralStats(REFERRER);
    assertEquals(stats, { referred: 1, daysEarned: 8 + 4 + 1 });
  } finally {
    await kv.close();
  }
});

Deno.test("UG06 CONTRIBUTION — No bonus for no-reward approvals, rejections or partial publications; never twice", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockMigrationApi();
    await attributeReferral({ payload: `ref_${await getOrCreateReferralCode(REFERRER)}`, refereeId: REFEREE, isNewToBot: true });
    const c = await seedCreator({ name: "Aria", topicId: 5 });
    const mk = async (ids: number[]) => {
      assert((await startContribution(REFEREE, c.id)).ok);
      for (const id of ids) await addContributionItem(REFEREE, { messageId: id, kind: "photo" });
      return (await finishContribution(api, REFEREE)).contribution!;
    };

    const a = await mk([1]);
    await approveContribution(api, a.id, ADMIN, { type: "no_reward" });
    const b = await mk([2]);
    await rejectContribution(api, b.id, ADMIN, "non");
    assertEquals((await contribEnts(REFERRER)).length, 0);

    // partial publication: nothing until the admin resolves it
    const p = await mk([3, 4]);
    api.missingMessageIds.add(4);
    await approveContribution(api, p.id, ADMIN, { type: "reward", scopes: ["regular"], days: 10 });
    assertEquals((await contribEnts(REFERRER)).length, 0);
    const { resolvePartialPublication } = await import("../src/contributions/service.ts");
    await resolvePartialPublication(api, p.id, ADMIN);
    const once = (await contribEnts(REFERRER))[0].expiresAt;
    assert(Math.abs(daysLeft(once) - 5) < 0.01);

    // repeated clicks / retries never add it twice
    await resolvePartialPublication(api, p.id, ADMIN);
    await approveContribution(api, p.id, ADMIN, { type: "reward", scopes: ["regular"], days: 10 });
    assertEquals((await contribEnts(REFERRER))[0].expiresAt, once);
  } finally {
    await kv.close();
  }
});

Deno.test("UG06 CONTRIBUTION — Contributors without a referrer, and referees of nobody, produce no bonus", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockMigrationApi();
    await submitAndReward(api, 9200, ["regular"], 30);
    const { listBonuses } = await import("../src/db/referrals.ts");
    assertEquals((await listBonuses()).length, 0);
    assertEquals((await contribEnts(9200)).length, 1);
  } finally {
    await kv.close();
  }
});

Deno.test("UG06 STARS — 1 day per full 100 Stars spent, cumulative; renewals count; plan decides the forums", async () => {
  const kv = await setupTestEnvironment();
  try {
    await attributeReferral({ payload: `ref_${await getOrCreateReferralCode(REFERRER)}`, refereeId: REFEREE, isNewToBot: true });

    // 750 Stars → 7 days (Regular)
    await pay(REFEREE, "regular", "ch_a");
    let ents = await contribEnts(REFERRER);
    assertEquals(ents.length, 1);
    assertEquals(ents[0].contributionScope, "regular");
    assert(Math.abs(daysLeft(ents[0].expiresAt) - 7) < 0.01);

    // renewal: cumulative 1500 → 15 days total, i.e. +8 (the 50 Stars remainder carried over)
    await pay(REFEREE, "regular", "ch_b");
    ents = await contribEnts(REFERRER);
    assert(Math.abs(daysLeft(ents[0].expiresAt) - 15) < 0.01);

    // duplicate webhook for the same charge → nothing more
    const dup = await pay(REFEREE, "regular", "ch_b");
    assertEquals(dup.isDuplicate, true);
    assert(Math.abs(daysLeft((await contribEnts(REFERRER))[0].expiresAt) - 15) < 0.01);

    // Retro Plus (1500 Stars) → +15 days on BOTH forums
    await pay(REFEREE, "retro_plus", "ch_c");
    const all = await contribEnts(REFERRER);
    assertEquals(all.length, 2);
    assert(Math.abs(daysLeft(all.find((e) => e.contributionScope === "regular")!.expiresAt) - 30) < 0.01);
    assert(Math.abs(daysLeft(all.find((e) => e.contributionScope === "retro")!.expiresAt) - 15) < 0.01);

    assertEquals((await referralStats(REFERRER)).daysEarned, 7 + 8 + 15);
    // The payer's own subscription is untouched and the referrer's days are not revenue
    assertEquals((await getPaymentByChargeId("ch_c"))?.amount, 1500);
  } finally {
    await kv.close();
  }
});

Deno.test("UG06 STARS — Payments by people nobody referred, or below 100 Stars, behave correctly", async () => {
  const kv = await setupTestEnvironment();
  try {
    await pay(9300, "regular", "ch_x");
    assertEquals((await contribEnts(REFERRER)).length, 0);

    // sub-100 payments accumulate until a full 100 is reached
    await attributeReferral({ payload: `ref_${await getOrCreateReferralCode(REFERRER)}`, refereeId: 9301, isNewToBot: true });
    const mk = (n: number, amount: number) => ({
      id: `p${n}`, createdAt: new Date().toISOString(), userId: 9301, provider: "telegram_stars" as const,
      chargeId: `small_${n}`, providerChargeId: "p", amount, currency: "XTR", invoicePayload: "{}",
      subscriptionPeriodSeconds: 1, isRecurring: false, status: "completed" as const,
    });
    assertEquals((await awardPaymentBonus(mk(1, 60)))?.days ?? 0, 0);
    assertEquals((await contribEnts(REFERRER)).length, 0);
    assertEquals((await awardPaymentBonus(mk(2, 60)))?.days, 1); // 120 Stars total → 1 day
    assertEquals((await contribEnts(REFERRER)).length, 1);
    await awardPaymentBonus(mk(2, 60)); // the same charge again must not add anything
    assert(Math.abs(daysLeft((await contribEnts(REFERRER))[0].expiresAt) - 1) < 0.01);
  } finally {
    await kv.close();
  }
});

Deno.test("UG06 SAFETY — A bonus reserved but not applied is finished by the hourly recovery, once", async () => {
  const kv = await setupTestEnvironment();
  try {
    const { reserveBonus } = await import("../src/db/referrals.ts");
    await reserveBonus({
      key: "contribution:crashed", referrerId: REFERRER, refereeId: REFEREE, source: "contribution",
      sourceRef: "crashed", scopes: ["regular"], days: 5, status: "pending", createdAt: new Date().toISOString(),
    });
    assertEquals((await contribEnts(REFERRER)).length, 0);
    assertEquals(await recoverPendingBonuses(), 1);
    assertEquals(await recoverPendingBonuses(), 0);
    assert(Math.abs(daysLeft((await contribEnts(REFERRER))[0].expiresAt) - 5) < 0.01);
  } finally {
    await kv.close();
  }
});

Deno.test("UG06 MODE — Referral bonuses follow the contribution-reward switch (off in Stars-only unless enabled)", async () => {
  const kv = await setupTestEnvironment();
  try {
    await attributeReferral({ payload: `ref_${await getOrCreateReferralCode(REFERRER)}`, refereeId: REFEREE, isNewToBot: true });
    await updateSystemSettings({ membershipMode: "stars_only" });
    await pay(REFEREE, "regular", "ch_s");
    assertEquals((await contribEnts(REFERRER)).length, 0);
    await updateSystemSettings({ contributionRewardsInStarsMode: true });
    await pay(REFEREE, "regular", "ch_s2");
    assertEquals((await contribEnts(REFERRER)).length, 1);
  } finally {
    await kv.close();
  }
});

Deno.test("UG06 UI — Referral menu shows the personal link, stats and a share button; admin sees the referrer's bonus before confirming", async () => {
  const kv = await setupTestEnvironment();
  try {
    const { bot, calls } = makeBot();
    const link = await referralLink(REFERRER);
    await bot.handleUpdate(cb(REFERRER, "ref:menu") as never);
    const shown = JSON.stringify(calls.filter((c) => c.method === "editMessageText").at(-1));
    assertStringIncludes(shown, link);
    assertStringIncludes(shown, "Personnes parrainées");
    assertStringIncludes(shown, "t.me/share/url");
    assertStringIncludes(shown, "50 %");

    // main menu has the button
    await bot.handleUpdate(text(REFERRER, "/start") as never);
    assertStringIncludes(JSON.stringify(calls.filter((c) => c.method === "sendMessage")), "ref:menu");

    // admin reward screen mentions the referrer's bonus
    await attributeReferral({ payload: `ref_${await getOrCreateReferralCode(REFERRER)}`, refereeId: REFEREE, isNewToBot: true });
    const api = new MockMigrationApi();
    const c = await seedCreator({ name: "Aria", topicId: 7 });
    await startContribution(REFEREE, c.id);
    await addContributionItem(REFEREE, { messageId: 1, kind: "photo" });
    const sub = (await finishContribution(api, REFEREE)).contribution!;
    await bot.handleUpdate(cb(ADMIN, `cadm:sc:${sub.id}:rg`) as never);
    await bot.handleUpdate(cb(ADMIN, `cadm:du:${sub.id}:15`) as never);
    const screen = JSON.stringify(calls.filter((c) => c.method === "editMessageText").at(-1));
    assertStringIncludes(screen, "Parrain");
    assertStringIncludes(screen, "+8 jours");
    assert(await getKv() !== null);
  } finally {
    await kv.close();
  }
});
