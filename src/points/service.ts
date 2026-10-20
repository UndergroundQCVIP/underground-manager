/**
 * LA CONFRÉRIE — Points & Leaderboard (UG-07)
 *
 * Points come only from real, verified events (never from admin-granted complimentary
 * access): Stars payments, admin-published contributions, and new people who join through
 * a member's referral link. Every event is recorded once (idempotent key), refunds reverse
 * their points, and the whole ledger can be rebuilt from existing records.
 *
 *   payment:        1 point per 10 Stars paid (renewals included)
 *   contribution:   5 points per published item, +20 when the admin granted a reward
 *   referral:       25 points per new person who first opens the bot with your link
 *
 * Monthly #1 automatically receives bonus access days (admin can switch this off).
 */

import { getClubName, getConfig, isAdministrator } from "../config.ts";
import { logAuditEvent } from "../db/audit.ts";
import { applyContributionDays } from "../db/entitlements.ts";
import { getKv } from "../db/kv.ts";
import { getMember } from "../db/members.ts";
import { listAllPayments } from "../db/payments.ts";
import {
  addPoints,
  getPointsEntry,
  getPrize,
  getProfile,
  getTotals,
  listAllTotals,
  PointsEntry,
  PointsReason,
  reservePrize,
} from "../db/points.ts";
import { listContributions } from "../db/contributions.ts";
import { getSystemSettings } from "../db/settings.ts";
import { ReferralAttribution } from "../db/referrals.ts";
import { Contribution, CONTRIBUTION_SPACES, Payment } from "../types.ts";
import { escapeMd } from "../util/markdown.ts";
import { torontoMonthCycle } from "../util/time.ts";

export const POINTS = {
  starsPerPoint: 10,
  perPublishedItem: 5,
  rewardBonus: 20,
  referralJoin: 25,
} as const;
export const PRIZE_DAYS = 7; // monthly #1 → Regular access

const monthOf = (iso: string) => torontoMonthCycle(new Date(iso));

async function record(userId: number, key: string, points: number, reason: PointsReason, at: string, ref?: string) {
  if (points === 0) return false;
  const fresh = await addPoints({ key, userId, points, reason, month: monthOf(at), at, ref });
  if (fresh) await logAuditEvent("points_awarded", { key, points, reason }, 0, userId);
  return fresh;
}

// ----------------------------------------------------------------------------- awarding

export async function awardPaymentPoints(payment: Payment): Promise<number> {
  if (payment.status !== "completed") return 0;
  const pts = Math.floor(payment.amount / POINTS.starsPerPoint);
  await record(payment.userId, `payment:${payment.chargeId}`, pts, "payment", payment.createdAt, payment.chargeId);
  return pts;
}

/** A refunded payment takes back exactly the points it earned (in the month it was earned). */
export async function reversePaymentPoints(chargeId: string): Promise<void> {
  const original = await getPointsEntry(`payment:${chargeId}`);
  if (!original) return;
  await addPoints({
    key: `refund:${chargeId}`,
    userId: original.userId,
    points: -original.points,
    reason: "refund",
    month: original.month, // keep the monthly ranking consistent
    at: new Date().toISOString(),
    ref: chargeId,
  });
}

export async function awardContributionPoints(c: Contribution, rewardGranted: boolean): Promise<number> {
  const count = c.publishedMessageIds?.length ?? c.items.length;
  const at = c.reviewedAt ?? c.submittedAt ?? c.createdAt;
  let total = 0;
  if (await record(c.userId, `contrib:${c.id}:items`, count * POINTS.perPublishedItem, "contribution_items", at, c.id)) {
    total += count * POINTS.perPublishedItem;
  }
  if (rewardGranted && (await record(c.userId, `contrib:${c.id}:reward`, POINTS.rewardBonus, "contribution_reward", at, c.id))) {
    total += POINTS.rewardBonus;
  }
  return total;
}

export async function awardReferralJoinPoints(attribution: Pick<ReferralAttribution, "referrerId" | "refereeId" | "at">): Promise<void> {
  await record(attribution.referrerId, `referral:${attribution.refereeId}`, POINTS.referralJoin, "referral_join", attribution.at, String(attribution.refereeId));
}

/**
 * Rebuild the ledger from existing records. Idempotent: running it any number of times
 * (or after the live hooks already counted something) changes nothing.
 */
export async function recalculatePoints(): Promise<{ payments: number; contributions: number; referrals: number }> {
  let payments = 0;
  let contributions = 0;
  let referrals = 0;

  for (const p of await listAllPayments()) {
    if (p.status === "completed") {
      if (await getPointsEntry(`payment:${p.chargeId}`) === null && (await awardPaymentPoints(p)) > 0) payments++;
    } else if (p.status === "refunded") {
      // a refund that arrived through a path without a live hook
      await awardPaymentPoints({ ...p, status: "completed" });
      await reversePaymentPoints(p.chargeId);
    }
  }
  for (const c of await listContributions("approved")) {
    if ((await getPointsEntry(`contrib:${c.id}:items`)) === null) contributions++;
    await awardContributionPoints(c, c.rewardStatus === "granted");
  }
  const kv = await getKv();
  for await (const e of kv.list<ReferralAttribution>({ prefix: ["referral_of"] })) {
    if (!e.value) continue;
    if ((await getPointsEntry(`referral:${e.value.refereeId}`)) === null) referrals++;
    await awardReferralJoinPoints(e.value);
  }
  return { payments, contributions, referrals };
}

// ----------------------------------------------------------------------------- queries

export interface Row {
  userId: number;
  value: number;
  label: string;
}

/** Anonymous by default: a stable alias unless the member opted in to show their name. */
export async function displayName(userId: number): Promise<string> {
  const profile = await getProfile(userId);
  if (profile.showName) {
    const m = await getMember(userId);
    if (m?.username) return `@${m.username}`;
    if (m?.firstName) return m.firstName;
  }
  return `Anonyme-${(userId * 2654435761 % 1679616).toString(36).toUpperCase().padStart(4, "0").slice(-4)}`;
}

export type Tab = "month" | "all" | "referrers";

async function referredCounts(month?: string): Promise<Map<number, { n: number; first: string }>> {
  const kv = await getKv();
  const out = new Map<number, { n: number; first: string }>();
  for await (const e of kv.list<ReferralAttribution>({ prefix: ["referral_of"] })) {
    const a = e.value;
    if (!a || (month && monthOf(a.at) !== month)) continue;
    const cur = out.get(a.referrerId) ?? { n: 0, first: a.at };
    out.set(a.referrerId, { n: cur.n + 1, first: a.at < cur.first ? a.at : cur.first });
  }
  return out;
}

async function ranked(tab: Tab, month: string): Promise<{ userId: number; value: number }[]> {
  let rows: { userId: number; value: number; tie: string }[];
  if (tab === "referrers") {
    rows = [...(await referredCounts()).entries()].map(([userId, v]) => ({ userId, value: v.n, tie: v.first }));
  } else {
    rows = (await listAllTotals()).map(({ userId, totals }) => ({
      userId,
      value: tab === "all" ? totals.total : totals.months[month] ?? 0,
      tie: totals.lastAt ?? "",
    }));
  }
  return rows
    .filter((r) => r.value > 0 && !isAdministrator(r.userId))
    .sort((a, b) => b.value - a.value || a.tie.localeCompare(b.tie) || a.userId - b.userId)
    .map(({ userId, value }) => ({ userId, value }));
}

export async function topList(tab: Tab, limit = 10, month = torontoMonthCycle()): Promise<Row[]> {
  const rows = (await ranked(tab, month)).slice(0, limit);
  return await Promise.all(rows.map(async (r) => ({ ...r, label: await displayName(r.userId) })));
}

export async function myStanding(userId: number, month = torontoMonthCycle()) {
  const t = await getTotals(userId);
  const rankOf = async (tab: Tab) => {
    const i = (await ranked(tab, month)).findIndex((r) => r.userId === userId);
    return i === -1 ? null : i + 1;
  };
  const referred = (await referredCounts()).get(userId)?.n ?? 0;
  return {
    all: t.total,
    month: t.months[month] ?? 0,
    rankAll: await rankOf("all"),
    rankMonth: await rankOf("month"),
    referred,
    rankReferrers: await rankOf("referrers"),
  };
}

const MEDALS = ["🥇", "🥈", "🥉"];
export function formatRows(rows: Row[], unit: string): string {
  if (rows.length === 0) return "_Personne n'a encore de points ici._";
  return rows
    .map((r, i) => `${MEDALS[i] ?? `${i + 1}.`} ${escapeMd(r.label)} — *${r.value}* ${unit}`)
    .join("\n");
}

// ----------------------------------------------------------------------------- monthly prize

const prevMonthKey = (now: Date): string => {
  const [y, m] = torontoMonthCycle(now).split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
};

export interface PrizeApiLike {
  sendMessage(chatId: number | string, text: string, other?: Record<string, unknown>): Promise<unknown>;
}

/**
 * Once the month is over, the #1 of that month receives bonus Regular access days.
 * Reserved once per month (ledger) and applied through the idempotent earned-access engine.
 */
export async function awardMonthlyPrize(api: PrizeApiLike | undefined, now = new Date()) {
  if (!(await getSystemSettings()).leaderboardPrizesEnabled) return null;
  const month = prevMonthKey(now);
  if (await getPrize(month)) return null;

  const [winner] = await ranked("month", month);
  if (!winner) return null;

  const reserved = await reservePrize({ month, winnerId: winner.userId, points: winner.value, days: PRIZE_DAYS, at: new Date().toISOString() });
  if (!reserved) return null;

  const res = await applyContributionDays({
    userId: winner.userId,
    scope: "regular",
    days: PRIZE_DAYS,
    contributionId: `prize:${month}`,
    spaces: CONTRIBUTION_SPACES.regular,
  });
  await logAuditEvent("points_prize_granted", { month, points: winner.value, days: PRIZE_DAYS }, 0, winner.userId);
  await api
    ?.sendMessage(
      winner.userId,
      `🏆 *Félicitations !* Vous êtes premier du classement de ${month} avec *${winner.value} points*.\nVous recevez *${PRIZE_DAYS} jours* d'accès bonus (Regular), jusqu'au ${res.entitlement.expiresAt.slice(0, 10)}.`,
      { parse_mode: "Markdown" }
    )
    .catch(() => {});
  return { month, winnerId: winner.userId, points: winner.value, days: PRIZE_DAYS };
}

// ----------------------------------------------------------------------------- public post

export async function buildLeaderboardPost(): Promise<{ text: string; reply_markup: { inline_keyboard: { text: string; url: string }[][] } }> {
  const month = torontoMonthCycle();
  const [monthly, all, refs] = await Promise.all([topList("month", 10), topList("all", 5), topList("referrers", 5)]);
  const last = await getPrize(prevMonthKey(new Date()));
  const lastLine = last ? `\n🏆 *Gagnant de ${last.month} :* ${escapeMd(await displayName(last.winnerId))} (${last.points} pts, +${last.days} jours)\n` : "";
  return {
    text:
      `🏆 *${getClubName()} — CLASSEMENT*\n\n` +
      `*Ce mois-ci (${month})*\n${formatRows(monthly, "pts")}\n\n` +
      `*Total*\n${formatRows(all, "pts")}\n\n` +
      `*Ceux qui partagent le plus*\n${formatRows(refs, "parrainé(s)")}\n` +
      lastLine +
      `\n_1 pt par 10 Étoiles · 5 pts par contenu publié (+20 si récompensé) · 25 pts par personne parrainée._`,
    reply_markup: {
      inline_keyboard: [[{ text: "🏆 Voir mon classement", url: `https://t.me/${getConfig().BOT_USERNAME}?start=leaderboard` }]],
    },
  };
}

