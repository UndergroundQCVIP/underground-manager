/**
 * Underground Manager — Administrator alerts
 *
 * Operational problems (failed removals, payment anomalies, cron failures, bot
 * permission loss) are DM'd to the configured administrators. Alerts are
 * de-duplicated per key for a cool-down window so a persistent fault does not
 * message the admins every hour.
 */

import { getConfig } from "../config.ts";
import { getKv } from "../db/kv.ts";
import { logAuditEvent } from "../db/audit.ts";

export interface AlertSender {
  sendMessage(chatId: number | string, text: string, options?: Record<string, unknown>): Promise<unknown>;
}

const DEFAULT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

export async function notifyAdmins(
  api: AlertSender,
  key: string,
  message: string,
  cooldownMs = DEFAULT_COOLDOWN_MS
): Promise<boolean> {
  const kv = await getKv();
  const stamp = ["alert_cooldown", key];
  const last = await kv.get<number>(stamp);
  if (last.value && Date.now() - last.value < cooldownMs) return false;

  await kv.set(stamp, Date.now(), { expireIn: cooldownMs });

  const text = `🚨 Underground Manager alert\n\n${message}`.slice(0, 3900);
  let delivered = false;
  for (const adminId of getConfig().ADMIN_USER_IDS) {
    try {
      await api.sendMessage(adminId, text); // plain text: never parse arbitrary error strings
      delivered = true;
    } catch (err) {
      console.error(`[Alert] Could not DM admin ${adminId}:`, err);
    }
  }
  await logAuditEvent("alert_sent", { key, delivered, message: message.slice(0, 500) }, 0).catch(() => {});
  return delivered;
}
