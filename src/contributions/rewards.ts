/**
 * LA CONFRÉRIE — Contribution Rewards (UG-05)
 *
 * Rewards are contribution-sourced ENTITLEMENTS in the existing entitlement
 * engine (no second membership system). Per scope:
 *    new_expiration = max(now, existing_contribution_expiration) + days
 * One submission yields at most one finalized reward (ledger keyed by the
 * contribution id), and re-running a reward is a no-op.
 */

import { getClubName, getConfig, isAdministrator } from "../config.ts";
import { logAuditEvent } from "../db/audit.ts";
import {
  applyContributionDays,
  listAllEntitlements,
  isEntitlementActive,
  markReminderSent,
} from "../db/entitlements.ts";
import { getKv } from "../db/kv.ts";
import { RewardScope, CONTRIBUTION_SPACES, ContributionReward } from "../types.ts";
import { formatTorontoDate } from "../util/time.ts";

export const MAX_REWARD_DAYS = 3650;

export function validateRewardParams(
  scopes: RewardScope[],
  days: number
): string | null {
  if (!Array.isArray(scopes) || scopes.length === 0) return "Choisissez le ou les forums accessibles.";
  if (scopes.some((s) => s !== "regular" && s !== "retro" && s !== "amateur")) return "Forum invalide.";
  if (!Number.isInteger(days) || days < 1 || days > MAX_REWARD_DAYS) {
    return `La durée doit être un nombre entier de jours entre 1 et ${MAX_REWARD_DAYS}.`;
  }
  return null;
}

export async function getContributionReward(contributionId: string): Promise<ContributionReward | null> {
  const kv = await getKv();
  return (await kv.get<ContributionReward>(["contribution_rewards", contributionId])).value ?? null;
}

export async function listContributionRewards(limit = 20): Promise<ContributionReward[]> {
  const kv = await getKv();
  const out: ContributionReward[] = [];
  for await (const e of kv.list<ContributionReward>({ prefix: ["contribution_rewards"] })) {
    if (e.value) out.push(e.value);
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}

/**
 * Grant (or resume granting) the reward for one submission.
 * Safe to call repeatedly: the ledger entry is created once, and each scope's
 * days are applied at most once per contribution id.
 */
export async function grantContributionReward(params: {
  contributionId: string;
  userId: number;
  scopes: RewardScope[];
  days: number;
  adminId: number;
}): Promise<{ reward: ContributionReward; alreadyGranted: boolean }> {
  const invalid = validateRewardParams(params.scopes, params.days);
  if (invalid) throw new Error(invalid);

  if (params.scopes.includes("amateur") && (!isAdministrator(params.adminId) || !getConfig().TELEGRAM_AMATEUR_FORUM_CHAT_ID)) throw new Error("Amateur nécessite une autorisation administrative et un forum configuré.");
  const kv = await getKv();
  const key = ["contribution_rewards", params.contributionId];
  const nowIso = new Date().toISOString();

  const existing = await kv.get<ContributionReward>(key);
  if (existing.value?.status === "granted") {
    return { reward: existing.value, alreadyGranted: true };
  }

  let record: ContributionReward = existing.value ?? {
    contributionId: params.contributionId,
    userId: params.userId,
    scopes: Array.from(new Set(params.scopes)),
    days: params.days,
    grantedBy: params.adminId,
    status: "applying",
    expiresAt: {},
    createdAt: nowIso,
  };
  if (!existing.value) {
    // Claim the single reward slot for this submission.
    const claim = await kv.atomic().check(existing).set(key, record).commit();
    if (!claim.ok) {
      const again = await kv.get<ContributionReward>(key);
      if (again.value?.status === "granted") return { reward: again.value, alreadyGranted: true };
      record = again.value ?? record;
    }
  }

  // Apply per scope. A resumed "applying" record re-runs safely (idempotent per contribution id).
  const expiresAt: ContributionReward["expiresAt"] = { ...record.expiresAt };
  for (const scope of record.scopes) {
    const res = await applyContributionDays({
      userId: record.userId,
      scope,
      days: record.days,
      contributionId: params.contributionId,
      spaces: CONTRIBUTION_SPACES[scope],
      grantedBy: record.grantedBy,
    });
    expiresAt[scope] = res.entitlement.expiresAt;
  }

  const finalRecord: ContributionReward = {
    ...record,
    status: "granted",
    expiresAt,
    grantedAt: new Date().toISOString(),
  };
  await kv.set(key, finalRecord);
  await logAuditEvent(
    "contribution_reward_granted",
    {
      contributionId: params.contributionId,
      scopes: finalRecord.scopes,
      days: finalRecord.days,
      expiresAt,
    },
    params.adminId,
    record.userId
  );
  return { reward: finalRecord, alreadyGranted: false };
}

export function scopesLabel(scopes: RewardScope[]): string {
  const set = new Set(scopes);
  if (set.has("amateur")) return "Amateur + en activité + Retro + communautés";
  if (set.has("regular") && set.has("retro")) return "Regular + Retro";
  return set.has("retro") ? "Retro" : "Regular";
}

export function fmtDay(iso: string): string {
  return formatTorontoDate(iso, { year: "numeric", month: "long", day: "numeric" });
}

// ---------------------------------------------------------------------------
// Expiration reminder (about 3 days ahead), mirrors the complimentary reminder.
// ---------------------------------------------------------------------------

export interface ReminderApiLike {
  sendMessage(chatId: number | string, text: string, other?: Record<string, unknown>): Promise<unknown>;
}

export async function processContributionReminders(
  api: ReminderApiLike
): Promise<{ remindedCount: number; errors: string[] }> {
  const nowMs = Date.now();
  const thresholdMs = nowMs + 3 * 86_400_000;
  const all = await listAllEntitlements();

  // One reminder per member, covering the earliest expiring scope.
  const byUser = new Map<number, typeof all>();
  for (const e of all) {
    if (
      e.source === "contribution" &&
      isEntitlementActive(e, nowMs) &&
      !e.metadata?.reminderSent &&
      new Date(e.expiresAt).getTime() <= thresholdMs
    ) {
      byUser.set(e.userId, [...(byUser.get(e.userId) ?? []), e]);
    }
  }

  let remindedCount = 0;
  const errors: string[] = [];
  for (const [userId, ents] of byUser) {
    try {
      const lines = ents
        .map((e) => `• ${e.contributionScope === "amateur" ? "Amateur" : e.contributionScope === "retro" ? "Retro" : "Regular"} : ${fmtDay(e.expiresAt)}`)
        .join("\n");
      await api.sendMessage(
        userId,
        `⏳ *${getClubName()} — Votre accès gagné expire bientôt*\n\n${lines}\n\n` +
          `Vous pouvez soumettre une autre contribution pour examen, ou utiliser un autre moyen d'adhésion offert. ` +
          `Soumettre du contenu ne garantit pas une prolongation.`,
        {
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: [[{ text: "➕ Contribuer", callback_data: "contrib:start" }]] },
        }
      );
      for (const e of ents) await markReminderSent(e.id);
      remindedCount++;
    } catch (err) {
      errors.push(`Rappel impossible pour ${userId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { remindedCount, errors };
}
