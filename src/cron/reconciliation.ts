/**
 * LA CONFRÉRIE — Scheduled Reconciliation & Expiry Processing
 *
 * One hourly Deno.cron drives everything. Deno.cron schedules are UTC, so the
 * "daily" jobs are decided here against America/Toronto wall-clock time
 * (DST-safe) and recorded per local day: a run that fails or is missed (downtime)
 * is retried/caught up by the next hourly tick instead of being skipped.
 */

import { Bot } from "grammy";
import { reconcileAllMembers } from "../access/sync.ts";
import { processComplimentaryReminders } from "../complimentary/service.ts";
import { processContributionReminders } from "../contributions/rewards.ts";
import { syncNavigationMessages } from "../navigation/service.ts";
import { recoverPendingBonuses } from "../referrals/service.ts";
import { awardMonthlyPrize, recalculatePoints } from "../points/service.ts";
import { syncLeaderboardPost } from "../points/post.ts";
import { getChatId } from "../access/spaces.ts";
import { syncPublicDirectory } from "../directory/sync.ts";
import { syncWantedListChannel } from "../wanted/service.ts";
import { getActiveBallot } from "../db/voting.ts";
import { closeAndFinalizeBallot, retryUnannouncedBallots } from "../voting/service.ts";
import { getConfig, getDailySyncHour } from "../config.ts";
import { expireStaleEntitlements } from "../db/entitlements.ts";
import { TelegramStarsProvider } from "../payments/stars.ts";
import { getKv } from "../db/kv.ts";
import { notifyAdmins } from "../ops/alerts.ts";
import { withJobLease } from "../ops/locks.ts";
import { torontoDateKey, torontoParts } from "../util/time.ts";
import { checkBotPermissions } from "../access/sync.ts";
import { SPACE_IDS } from "../types.ts";

export async function runHourlyReconciliation(bot: Bot): Promise<{
  reconciled: { checkedUsers: number; removedCount: number; errors: string[] };
  reminders: { remindedCount: number; errors: string[] };
  ballotClosed?: boolean;
  recoveredPayments?: number;
  expiredEntitlements?: number;
  daily?: { ran: boolean };
}> {
  console.log(`[Cron] Starting hourly membership reconciliation at ${new Date().toISOString()}`);

  // 0. Finish any payment that was recorded but not yet credited (crash/outage).
  let recoveredPayments = 0;
  try {
    const rec = await TelegramStarsProvider.recoverUnfulfilledPayments();
    recoveredPayments = rec.recovered;
    if (rec.failed > 0) {
      await notifyAdmins(
        bot.api,
        "payment_recovery_failed",
        `${rec.failed} paiement(s) sont enregistrés mais n'ont pas pu être crédités aux abonnements. Consultez les journaux; une nouvelle tentative a lieu toutes les heures.`
      );
    }
  } catch (err) {
    console.error("[Cron Error] Payment recovery failed:", err);
  }

  // 1. Persist expiry for entitlements whose time has passed (reads never write).
  let expiredEntitlements = 0;
  try {
    expiredEntitlements = await expireStaleEntitlements();
  } catch (err) {
    console.error("[Cron Error] Failed persisting expired entitlements:", err);
  }

  // 2. Reconcile space access and remove expired non-admins
  const reconciled = await reconcileAllMembers(bot.api);
  console.log(
    `[Cron] Reconciliation complete: checked ${reconciled.checkedUsers}, removed ${reconciled.removedCount}, errors ${reconciled.errors.length}`
  );
  if (reconciled.errors.length > 0) {
    await notifyAdmins(
      bot.api,
      "reconcile_errors",
      `Le rapprochement des accès a produit ${reconciled.errors.length} erreur(s); les retraits échoués sont retentés toutes les heures.\n` +
        reconciled.errors.slice(0, 5).join("\n")
    );
  }

  // 3. Check and send 3-day expiration reminders for complimentary memberships
  const reminders = await processComplimentaryReminders(bot.api);
  console.log(
    `[Cron] Complimentary reminders sent: ${reminders.remindedCount}, errors ${reminders.errors.length}`
  );

  // 3-pre. UG-07: monthly leaderboard prize (once the month is over; idempotent)
  try {
    const prize = await awardMonthlyPrize(bot.api);
    if (prize) console.log(`[Cron] Monthly leaderboard prize ${prize.month} → ${prize.winnerId}`);
  } catch (err) {
    console.error("[Cron Error] Monthly prize failed:", err);
  }

  // 3a. UG-06: finish any referral bonus that was reserved but not applied
  try {
    const recovered = await recoverPendingBonuses(bot.api);
    if (recovered > 0) console.log(`[Cron] Recovered ${recovered} referral bonus(es).`);
  } catch (err) {
    console.error("[Cron Error] Referral recovery failed:", err);
  }

  // 3b. UG-05: same 3-day heads-up for contribution-earned access (no promise of an extension)
  try {
    const earned = await processContributionReminders(bot.api);
    reminders.remindedCount += earned.remindedCount;
    reminders.errors.push(...earned.errors);
    console.log(`[Cron] Contribution reminders sent: ${earned.remindedCount}, errors ${earned.errors.length}`);
  } catch (err) {
    console.error("[Cron Error] Contribution reminders failed:", err);
  }

  // 4. Check for expired acquisition voting ballot
  let ballotClosed = false;
  try {
    const activeBallot = await getActiveBallot();
    if (activeBallot && new Date(activeBallot.closesAt).getTime() <= Date.now()) {
      console.log(`[Cron] Active ballot ${activeBallot.id} has expired. Closing ballot...`);
      await closeAndFinalizeBallot(activeBallot.id, bot.api);
      ballotClosed = true;
    }
  } catch (err) {
    console.error("[Cron Error] Failed to auto-finalize expired ballot:", err);
    await notifyAdmins(bot.api, "ballot_close_failed", `Échec de la fermeture du scrutin expiré : ${String(err)}`);
  }
  try {
    await retryUnannouncedBallots(bot.api);
  } catch (err) {
    console.error("[Cron Error] Failed retrying ballot announcements:", err);
  }

  // 5. Reconcile 21-day Telegram Stars holding period
  try {
    const { reconcileStarHoldingStatuses } = await import("../treasury/stars_tracking.ts");
    const holdingRes = await reconcileStarHoldingStatuses();
    if (holdingRes.transitionedCount > 0) {
      console.log(`[Cron] Transitioned ${holdingRes.transitionedCount} Star transactions to withdrawable.`);
    }
  } catch (err) {
    console.error("[Cron Error] Failed reconciling Star holding statuses:", err);
  }

  // 6. Daily jobs (Toronto 03:00 by default), with catch-up
  let daily: { ran: boolean } | undefined;
  try {
    daily = await runDailyIfDue(bot);
  } catch (err) {
    console.error("[Cron Error] Daily synchronization failed:", err);
    await notifyAdmins(bot.api, "daily_sync_failed", `Échec de la synchronisation quotidienne : ${String(err)}`);
  }

  return { reconciled, reminders, ballotClosed, recoveredPayments, expiredEntitlements, daily };
}

/** True once the Toronto-local hour has reached the configured daily hour and today's run has not completed. */
export async function isDailySyncDue(now: Date = new Date()): Promise<boolean> {
  if (torontoParts(now).hour < getDailySyncHour()) return false;
  const kv = await getKv();
  const done = await kv.get(["daily_sync_done", torontoDateKey(now)]);
  return done.value === null;
}

export async function runDailyIfDue(bot: Bot, now: Date = new Date()): Promise<{ ran: boolean }> {
  if (!(await isDailySyncDue(now))) return { ran: false };

  const lease = await withJobLease("daily_sync", 15 * 60 * 1000, async () => {
    const result = await runDailySynchronization(bot);
    const ok = !result.directory.error && result.wanted.success;
    if (ok) {
      const kv = await getKv();
      await kv.set(["daily_sync_done", torontoDateKey(now)], new Date().toISOString(), {
        expireIn: 3 * 24 * 60 * 60 * 1000,
      });
    }
    return ok;
  });
  return { ran: lease.ran };
}

export async function runDailySynchronization(bot: Bot): Promise<{
  directory: { updated: boolean; publishedCount: number; error?: string };
  wanted: { success: boolean };
}> {
  console.log(`[Cron] Running daily Directory & Wanted List synchronization at ${new Date().toISOString()}`);

  // 1. Synchronize Public Creator Directory (only touches Telegram if content changed)
  const dirResult = await syncPublicDirectory(bot.api);
  console.log(`[Cron] Public Directory sync: updated=${dirResult.updated}, chunks=${dirResult.publishedCount}`);

  // 2. Synchronize Private Wanted List Channel
  const wantedResult = await syncWantedListChannel(bot.api);
  console.log(`[Cron] Wanted List sync: success=${wantedResult.success}`);

  // 2b. UG-05: keep the bot-managed public information messages current (hash-compared: cheap
  //     when nothing changed, and the directory navigation buttons are re-applied if lost).
  try {
    const nav = await syncNavigationMessages(bot.api);
    console.log(`[Cron] Navigation sync: welcome=${nav.welcome.outcome}, lobby=${nav.lobby.outcome}, directory=${nav.directory.outcome}`);
  } catch (err) {
    console.error("[Cron Error] Navigation sync failed:", err);
  }

  // 2c. UG-07: rebuild points from the source records (safety net, idempotent) and refresh the public post
  try {
    await recalculatePoints();
    const lb = await syncLeaderboardPost(bot.api);
    console.log(`[Cron] Leaderboard post: ${lb.outcome}`);
  } catch (err) {
    console.error("[Cron Error] Leaderboard sync failed:", err);
  }

  // 3. Pull Telegram's own Stars ledger (refunds, withdrawals, missed payments)
  try {
    const { reconcileStarTransactionsFromApi } = await import("../treasury/stars_tracking.ts");
    const stars = await reconcileStarTransactionsFromApi(bot.api);
    console.log(
      `[Cron] Stars ledger: new=${stars.newTransactionsRecorded}, refunds=${stars.refundsApplied}, withdrawals=${stars.withdrawalsObserved}`
    );
    if (stars.errors.length > 0) {
      await notifyAdmins(bot.api, "stars_reconcile_error", `Échec de la synchronisation du registre des Étoiles : ${stars.errors.join("; ")}`);
    }
  } catch (err) {
    console.error("[Cron Error] Stars ledger reconciliation failed:", err);
  }

  // 4. Verify the bot still holds the permissions it needs in every space
  try {
    for (const spaceId of SPACE_IDS) {
      if (!getChatId(spaceId)) continue; // optional space (e.g. Retro) not configured
      const check = await checkBotPermissions(bot.api, spaceId);
      if (!check.ok) {
        await notifyAdmins(
          bot.api,
          `permissions_${spaceId}`,
          `Problème de permissions du bot dans ${spaceId} : ${check.missingPermissions.join(", ")}`
        );
      }
    }
  } catch (err) {
    console.error("[Cron Error] Permission check failed:", err);
  }

  return {
    directory: {
      updated: dirResult.updated,
      publishedCount: dirResult.publishedCount,
      error: dirResult.error,
    },
    wanted: { success: wantedResult.success },
  };
}

export function registerCronJobs(bot: Bot): void {
  try {
    if (typeof Deno.cron === "function") {
      // Single hourly tick (UTC): access reconciliation, expiry, payment recovery,
      // ballot closing, and the Toronto-local daily jobs.
      Deno.cron("Underground Hourly Reconciliation", "0 * * * *", async () => {
        try {
          const lease = await withJobLease("hourly", 20 * 60 * 1000, () => runHourlyReconciliation(bot));
          if (!lease.ran) console.log("[Cron] Hourly job skipped: another run holds the lease.");
        } catch (err) {
          console.error("[Cron Fatal] Error running scheduled reconciliation:", err);
          await notifyAdmins(bot.api, "hourly_fatal", `Le rapprochement horaire a planté : ${String(err)}`).catch(() => {});
        }
      });
      console.log(
        `[Cron] Hourly job registered; daily sync runs at ${getDailySyncHour(getConfig())}:00 America/Toronto.`
      );

      // UG-04: continue approved, running Regular → Retro migrations in small, rate-limited steps.
      Deno.cron("LaConfrerie Migration Worker", "*/5 * * * *", async () => {
        try {
          const { runAllCopyingMigrations } = await import("../migration/service.ts");
          await runAllCopyingMigrations(bot.api);
          // UG-06: continue large submissions and legacy imports that stopped on a time budget or rate limit
          const { continueAllPublishing } = await import("../contributions/service.ts");
          await continueAllPublishing(bot.api);
          const { continueAllImports } = await import("../imports/service.ts");
          await continueAllImports(bot.api);
        } catch (err) {
          console.error("[Cron Fatal] Error running migration worker:", err);
        }
      });
      console.log("[Cron] Migration worker registered (every 5 minutes; only runs jobs an administrator started).");
    } else {
      console.warn("[Cron] Deno.cron is not available in this runtime environment.");
    }
  } catch (err) {
    console.error("[Cron] Failed to register cron jobs:", err);
  }
}
