/**
 * LA CONFRÉRIE — Referral Program (UG-06)
 *
 *  - Every user has a personal link t.me/<bot>?start=ref_<code>.
 *  - A person is attributed to a referrer only on their FIRST contact with the bot
 *    (permanent, never self, never changed afterwards).
 *  - When an admin rewards the referred person's contribution, the referrer gets
 *    50% of the days (rounded up, minimum 1) for the SAME forums.
 *  - For every full 100 Stars the referred person pays, the referrer gets 1 day
 *    (cumulative, so remainders carry over). Renewals count; plan Regular → Regular,
 *    Retro Plus → Regular + Retro.
 *  - No cap, no multi-level. Days are ordinary contribution-sourced entitlement days
 *    (same engine, never shortening anything), recorded once per source in a ledger.
 */

import { getConfig } from "../config.ts";
import { logAuditEvent } from "../db/audit.ts";
import { applyContributionDays } from "../db/entitlements.ts";
import { contributionRewardsEnabled } from "../membership/mode.ts";
import {
  countReferred,
  getBonus,
  getOrCreateReferralCode,
  getReferralCodeOwner,
  getReferralOf,
  listBonuses,
  ReferralBonus,
  reserveBonus,
  saveAttribution,
  saveBonus,
} from "../db/referrals.ts";
import { CollectionCategory, CONTRIBUTION_SPACES, Payment } from "../types.ts";
import { formatTorontoDate } from "../util/time.ts";

export interface ReferralApiLike {
  sendMessage(chatId: number | string, text: string, other?: Record<string, unknown>): Promise<unknown>;
}

export async function referralLink(userId: number): Promise<string> {
  return `https://t.me/${getConfig().BOT_USERNAME}?start=ref_${await getOrCreateReferralCode(userId)}`;
}

/** Called from /start. Returns true only if a NEW attribution was recorded. */
export async function attributeReferral(params: {
  payload: string; // "ref_<code>"
  refereeId: number;
  isNewToBot: boolean;
}): Promise<boolean> {
  if (!params.payload.startsWith("ref_") || !params.isNewToBot) return false;
  const code = params.payload.slice(4).toLowerCase();
  const referrerId = await getReferralCodeOwner(code);
  if (!referrerId || referrerId === params.refereeId) return false;
  const saved = await saveAttribution({
    referrerId,
    refereeId: params.refereeId,
    code,
    at: new Date().toISOString(),
  });
  if (saved) await logAuditEvent("referral_attributed", { referrerId, code }, 0, params.refereeId);
  return saved;
}

/** 50% of the reward, rounded up, never less than one day. */
export function referralBonusDays(rewardDays: number): number {
  return Math.max(1, Math.ceil(rewardDays / 2));
}

const scopeText = (scopes: CollectionCategory[]) =>
  scopes.length === 2 ? "Regular + Retro" : scopes[0] === "retro" ? "Retro" : "Regular";

/** Apply a reserved (pending) bonus to the referrer. Idempotent per ledger key. */
export async function applyPendingBonus(
  key: string,
  api?: ReferralApiLike
): Promise<{ applied: boolean; bonus?: ReferralBonus; expiresAt?: Partial<Record<CollectionCategory, string>> }> {
  const bonus = await getBonus(key);
  if (!bonus || bonus.status !== "pending") return { applied: false, bonus: bonus ?? undefined };

  const expiresAt: Partial<Record<CollectionCategory, string>> = {};
  for (const scope of bonus.scopes) {
    const res = await applyContributionDays({
      userId: bonus.referrerId,
      scope,
      days: bonus.days,
      contributionId: `referral:${bonus.key}`, // distinct id space: never collides with a submission reward
      spaces: CONTRIBUTION_SPACES[scope],
    });
    expiresAt[scope] = res.entitlement.expiresAt;
  }
  const done: ReferralBonus = { ...bonus, status: "applied", appliedAt: new Date().toISOString() };
  await saveBonus(done);
  await logAuditEvent(
    "referral_bonus_granted",
    { key: bonus.key, days: bonus.days, scopes: bonus.scopes },
    0,
    bonus.referrerId
  );

  if (api) {
    const when = Object.values(expiresAt).sort().at(-1);
    await api
      .sendMessage(
        bonus.referrerId,
        `🤝 *Parrainage* — une personne que vous avez parrainée ${bonus.source === "payment" ? "a payé un abonnement" : "a été récompensée pour une contribution"}.\n\n` +
          `Vous recevez *${bonus.days} jour${bonus.days > 1 ? "s" : ""}* d'accès (${scopeText(bonus.scopes)}).` +
          (when ? `\nVotre accès gagné va jusqu'au ${formatTorontoDate(when, { year: "numeric", month: "long", day: "numeric" })}.` : ""),
        { parse_mode: "Markdown" }
      )
      .catch(() => {});
  }
  return { applied: true, bonus: done, expiresAt };
}

/** A rewarded contribution → 50% (rounded up) for the referrer, same forums. */
export async function awardContributionBonus(
  api: ReferralApiLike | undefined,
  contribution: { id: string; userId: number },
  reward: { scopes: CollectionCategory[]; days: number }
): Promise<void> {
  const attribution = await getReferralOf(contribution.userId);
  if (!attribution || !(await contributionRewardsEnabled())) return;

  await reserveBonus({
    key: `contribution:${contribution.id}`,
    referrerId: attribution.referrerId,
    refereeId: contribution.userId,
    source: "contribution",
    sourceRef: contribution.id,
    scopes: [...new Set(reward.scopes)],
    days: referralBonusDays(reward.days),
    status: "pending",
    createdAt: new Date().toISOString(),
  });
  await applyPendingBonus(`contribution:${contribution.id}`, api);
}

/** A Stars payment by a referred person → 1 day per full 100 Stars spent (cumulative). */
export async function awardPaymentBonus(
  payment: Payment,
  api?: ReferralApiLike
): Promise<{ referrerId: number; days: number } | null> {
  const attribution = await getReferralOf(payment.userId);
  if (!attribution || payment.status !== "completed" || !(await contributionRewardsEnabled())) return null;

  const scopes: CollectionCategory[] = payment.planId === "retro_plus" ? ["regular", "retro"] : ["regular"];
  const key = `payment:${payment.chargeId}`;
  const { days } = await reserveBonus(
    {
      key,
      referrerId: attribution.referrerId,
      refereeId: payment.userId,
      source: "payment",
      sourceRef: payment.chargeId,
      scopes,
      days: 0,
      status: "pending",
      createdAt: new Date().toISOString(),
    },
    payment.amount
  );
  const res = await applyPendingBonus(key, api);
  return days > 0 || res.applied ? { referrerId: attribution.referrerId, days } : null;
}

/** Hourly safety net: finish any bonus that was reserved but not applied (crash/outage). */
export async function recoverPendingBonuses(api?: ReferralApiLike): Promise<number> {
  let n = 0;
  for (const b of await listBonuses()) {
    if (b.status === "pending") {
      try {
        if ((await applyPendingBonus(b.key, api)).applied) n++;
      } catch (err) {
        console.error(`[Referrals] Recovery failed for ${b.key}:`, err);
      }
    }
  }
  return n;
}

export async function referralStats(referrerId: number): Promise<{ referred: number; daysEarned: number }> {
  const bonuses = (await listBonuses()).filter((b) => b.referrerId === referrerId && b.status === "applied");
  return { referred: await countReferred(referrerId), daysEarned: bonuses.reduce((n, b) => n + b.days, 0) };
}

