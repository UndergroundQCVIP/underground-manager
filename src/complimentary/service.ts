/**
 * LA CONFRÉRIE — Complimentary Membership Service
 */

import { getClubName } from "../config.ts";
import {
  COMPLIMENTARY_REASONS,
  COMPLIMENTARY_SPACES,
  ComplimentaryAccessLevel,
  ComplimentaryReason,
  Entitlement,
} from "../types.ts";
import {
  createEntitlement,
  extendEntitlement,
  getActiveUserEntitlements,
  markReminderSent,
  revokeEntitlement,
} from "../db/entitlements.ts";
import { logAuditEvent } from "../db/audit.ts";

export interface GrantComplimentaryParams {
  adminId: number;
  userId: number;
  durationDays: number;
  reason: ComplimentaryReason | string;
  level: ComplimentaryAccessLevel;
  notes?: string;
}

export interface GrantComplimentaryResult {
  success: boolean;
  entitlement?: Entitlement;
  error?: string;
}

export async function grantComplimentaryAccess(
  params: GrantComplimentaryParams
): Promise<GrantComplimentaryResult> {
  if (params.durationDays <= 0) {
    return { success: false, error: "Duration must be greater than zero days." };
  }

  const spaces = COMPLIMENTARY_SPACES[params.level];
  if (!spaces || spaces.length === 0) {
    return { success: false, error: `Invalid access level: ${params.level}` };
  }

  const durationMs = params.durationDays * 86400 * 1000;
  const nowMs = Date.now();

  // Check existing entitlements to ensure we do not shorten existing valid access
  const active = await getActiveUserEntitlements(params.userId);
  let baseMs = nowMs;
  const existingComplimentary = active.find((e) => e.source === "complimentary");
  if (existingComplimentary) {
    const existingExpiryMs = new Date(existingComplimentary.expiresAt).getTime();
    if (existingExpiryMs > nowMs) {
      baseMs = existingExpiryMs;
    }
  }

  const expiresIso = new Date(baseMs + durationMs).toISOString();

  const entitlement = await createEntitlement({
    userId: params.userId,
    source: "complimentary",
    spaces,
    startsAt: new Date(nowMs).toISOString(),
    expiresAt: expiresIso,
    status: "active",
    metadata: {
      grantedBy: params.adminId,
      reason: params.reason,
      notes: params.notes,
      reminderSent: false,
    },
  });

  await logAuditEvent(
    "entitlement_granted",
    {
      entitlementId: entitlement.id,
      durationDays: params.durationDays,
      reason: params.reason,
      level: params.level,
      spaces,
      expiresAt: entitlement.expiresAt,
      source: "complimentary",
    },
    params.adminId,
    params.userId
  );

  return { success: true, entitlement };
}

export async function extendComplimentaryAccess(
  adminId: number,
  entitlementId: string,
  additionalDays: number
): Promise<{ success: boolean; entitlement?: Entitlement; error?: string }> {
  if (additionalDays <= 0) {
    return { success: false, error: "Additional days must be greater than zero." };
  }

  const seconds = additionalDays * 86400;
  const updated = await extendEntitlement(entitlementId, seconds);
  if (!updated) {
    return { success: false, error: "Entitlement not found." };
  }

  await logAuditEvent(
    "entitlement_extended",
    {
      entitlementId,
      additionalDays,
      newExpiresAt: updated.expiresAt,
      source: "complimentary",
    },
    adminId,
    updated.userId
  );

  return { success: true, entitlement: updated };
}

export async function revokeComplimentaryAccess(
  adminId: number,
  entitlementId: string,
  reason?: string
): Promise<{ success: boolean; entitlement?: Entitlement; error?: string }> {
  const updated = await revokeEntitlement(entitlementId, reason);
  if (!updated) {
    return { success: false, error: "Entitlement not found." };
  }

  await logAuditEvent(
    "entitlement_revoked",
    { entitlementId, reason: reason ?? "Revoked by admin", source: "complimentary" },
    adminId,
    updated.userId
  );

  return { success: true, entitlement: updated };
}

export interface MessageSenderLike {
  sendMessage(
    chatId: number | string,
    text: string,
    options?: Record<string, unknown>
  ): Promise<unknown>;
}

export async function processComplimentaryReminders(
  sender: MessageSenderLike
): Promise<{ remindedCount: number; errors: string[] }> {
  // Find all active complimentary entitlements
  const nowMs = Date.now();
  const threeDaysMs = 3 * 86400 * 1000;
  const thresholdMs = nowMs + threeDaysMs;

  const { listAllEntitlements } = await import("../db/entitlements.ts");
  const all = await listAllEntitlements();

  let remindedCount = 0;
  const errors: string[] = [];

  for (const ent of all) {
    if (
      ent.source === "complimentary" &&
      ent.status === "active" &&
      !ent.metadata?.reminderSent
    ) {
      const expMs = new Date(ent.expiresAt).getTime();
      // If expiring within 3 days and not already expired
      if (expMs > nowMs && expMs <= thresholdMs) {
        try {
          const daysLeft = Math.max(1, Math.round((expMs - nowMs) / (86400 * 1000)));
          const text =
            `⏳ *${getClubName()} — Membership Expiry Notice*\n\n` +
            `Your complimentary access expires in approximately *${daysLeft} day${
              daysLeft === 1 ? "" : "s"
            }*.\n\n` +
            `To maintain uninterrupted access to TOKEBEC VIP COLLECTIONS and the ${getClubName()} community, you can subscribe using Telegram Stars at any time.\n\n` +
            `Tap below to subscribe or check your membership.`;

          await sender.sendMessage(ent.userId, text, {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "🌟 Subscribe with Telegram Stars",
                    callback_data: "member:subscribe",
                  },
                ],
                [
                  {
                    text: "📋 My Membership",
                    callback_data: "member:status",
                  },
                ],
              ],
            },
          });

          await markReminderSent(ent.id);
          await logAuditEvent(
            "complimentary_reminder_sent",
            { entitlementId: ent.id, expiresAt: ent.expiresAt },
            0,
            ent.userId
          );

          remindedCount++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`Failed to send reminder to user ${ent.userId}: ${msg}`);
        }
      }
    }
  }

  return { remindedCount, errors };
}
