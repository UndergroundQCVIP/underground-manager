/**
 * Underground Manager — Scheduled Reconciliation & Expiry Processing
 */

import { Bot } from "grammy";
import { reconcileAllMembers } from "../access/sync.ts";
import { processComplimentaryReminders } from "../complimentary/service.ts";

export async function runHourlyReconciliation(bot: Bot): Promise<{
  reconciled: { checkedUsers: number; removedCount: number; errors: string[] };
  reminders: { remindedCount: number; errors: string[] };
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

  return { reconciled, reminders };
}

export function registerCronJobs(bot: Bot): void {
  try {
    if (typeof Deno.cron === "function") {
      Deno.cron("Underground Hourly Reconciliation", "0 * * * *", async () => {
        try {
          await runHourlyReconciliation(bot);
        } catch (err) {
          console.error("[Cron Fatal] Error running scheduled reconciliation:", err);
        }
      });
      console.log("[Cron] Hourly reconciliation job successfully registered with Deno.cron.");
    } else {
      console.warn("[Cron] Deno.cron is not available in this runtime environment.");
    }
  } catch (err) {
    console.error("[Cron] Failed to register cron job:", err);
  }
}
