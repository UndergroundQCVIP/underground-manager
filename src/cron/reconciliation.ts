/**
 * LA CONFRÉRIE — Scheduled Reconciliation & Expiry Processing
 */

import { Bot } from "grammy";
import { reconcileAllMembers } from "../access/sync.ts";
import { processComplimentaryReminders } from "../complimentary/service.ts";
import { syncPublicDirectory } from "../directory/sync.ts";
import { syncWantedListChannel } from "../wanted/service.ts";
import { getActiveBallot } from "../db/voting.ts";
import { closeAndFinalizeBallot } from "../voting/service.ts";
import { getConfig } from "../config.ts";

export async function runHourlyReconciliation(bot: Bot): Promise<{
  reconciled: { checkedUsers: number; removedCount: number; errors: string[] };
  reminders: { remindedCount: number; errors: string[] };
  ballotClosed?: boolean;
}> {
  console.log(`[Cron] Starting hourly membership reconciliation at ${new Date().toISOString()}`);

  // 1. Reconcile space access and remove expired non-admins
  const reconciled = await reconcileAllMembers(bot.api);
  console.log(
    `[Cron] Reconciliation complete: checked ${reconciled.checkedUsers}, removed ${reconciled.removedCount}, errors ${reconciled.errors.length}`
  );

  // 2. Check and send 3-day expiration reminders for complimentary memberships
  const reminders = await processComplimentaryReminders(bot.api);
  console.log(
    `[Cron] Complimentary reminders sent: ${reminders.remindedCount}, errors ${reminders.errors.length}`
  );

  // 3. Check for expired acquisition voting ballot
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
  }

  // 4. Reconcile 21-day Telegram Stars holding period
  try {
    const { reconcileStarHoldingStatuses } = await import("../treasury/stars_tracking.ts");
    const holdingRes = await reconcileStarHoldingStatuses();
    if (holdingRes.transitionedCount > 0) {
      console.log(`[Cron] Transitioned ${holdingRes.transitionedCount} Star transactions to withdrawable.`);
    }
  } catch (err) {
    console.error("[Cron Error] Failed reconciling Star holding statuses:", err);
  }

  return { reconciled, reminders, ballotClosed };
}

export async function runDailySynchronization(bot: Bot): Promise<{
  directory: { updated: boolean; publishedCount: number };
  wanted: { success: boolean };
}> {
  console.log(`[Cron] Running daily Directory & Wanted List synchronization at ${new Date().toISOString()}`);

  // 1. Synchronize Public Creator Directory
  const dirResult = await syncPublicDirectory(bot.api);
  console.log(`[Cron] Public Directory sync: updated=${dirResult.updated}, chunks=${dirResult.publishedCount}`);

  // 2. Synchronize Private Wanted List Channel
  const wantedResult = await syncWantedListChannel(bot.api);
  console.log(`[Cron] Wanted List sync: success=${wantedResult.success}`);

  return {
    directory: { updated: dirResult.updated, publishedCount: dirResult.publishedCount },
    wanted: { success: wantedResult.success },
  };
}

export function registerCronJobs(bot: Bot): void {
  const config = getConfig();

  try {
    if (typeof Deno.cron === "function") {
      // Hourly Access Reconciliation & Expiry Checking
      Deno.cron("Underground Hourly Reconciliation", "0 * * * *", async () => {
        try {
          await runHourlyReconciliation(bot);
        } catch (err) {
          console.error("[Cron Fatal] Error running scheduled reconciliation:", err);
        }
      });
      console.log("[Cron] Hourly reconciliation job successfully registered with Deno.cron.");

      // Daily Public Directory & Wanted List Synchronization (Default 3:00 AM)
      Deno.cron("Underground Daily Directory Sync", config.DIRECTORY_UPDATE_CRON, async () => {
        try {
          await runDailySynchronization(bot);
        } catch (err) {
          console.error("[Cron Fatal] Error running daily synchronization:", err);
        }
      });
      console.log(`[Cron] Daily synchronization job registered for schedule '${config.DIRECTORY_UPDATE_CRON}'.`);

      // UG-04: continue approved, running Regular → Retro migrations in small, rate-limited steps.
      Deno.cron("LaConfrerie Migration Worker", "*/5 * * * *", async () => {
        try {
          const { runAllCopyingMigrations } = await import("../migration/service.ts");
          await runAllCopyingMigrations(bot.api);
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
