/**
 * LA CONFRÉRIE — Tier-aware Revenue Reporting (UG-04)
 *
 * One consolidated treasury; revenue is merely *attributed* to a tier.
 *  - Every payment is counted exactly once (idempotent charge IDs), so an
 *    upgrade — a new Retro Plus charge — never re-counts the earlier Regular
 *    charge or moves its revenue.
 *  - Refunded/failed payments are excluded.
 *  - Complimentary memberships create no payment and so are never revenue.
 */

import { listAllEntitlements } from "../db/entitlements.ts";
import { listAllPayments } from "../db/payments.ts";
import { MembershipPlanId, TierRevenueBreakdown } from "../types.ts";

const PLANS: MembershipPlanId[] = ["regular", "retro_plus"];

export async function computeTierRevenue(period?: string): Promise<TierRevenueBreakdown> {
  const currentPeriod = period ?? new Date().toISOString().slice(0, 7);
  const out = Object.fromEntries(
    PLANS.map((p) => [p, { periodStars: 0, lifetimeStars: 0, periodPayments: 0, activeSubscribers: 0 }])
  ) as TierRevenueBreakdown;

  for (const pay of await listAllPayments()) {
    if (pay.status !== "completed") continue;
    const plan: MembershipPlanId = pay.planId ?? "regular"; // legacy payments are Regular
    out[plan].lifetimeStars += pay.amount;
    if (pay.createdAt.startsWith(currentPeriod)) {
      out[plan].periodStars += pay.amount;
      out[plan].periodPayments++;
    }
  }

  // Active subscribers by HIGHEST tier so an overlapping upgrade is not double counted.
  const nowMs = Date.now();
  const highest = new Map<number, MembershipPlanId>();
  for (const e of await listAllEntitlements()) {
    if (e.source !== "telegram_stars" || e.status !== "active") continue;
    if (new Date(e.expiresAt).getTime() <= nowMs) continue;
    const plan: MembershipPlanId = e.plan ?? "regular";
    const prev = highest.get(e.userId);
    if (!prev || (plan === "retro_plus" && prev === "regular")) highest.set(e.userId, plan);
  }
  for (const plan of highest.values()) out[plan].activeSubscribers++;

  return out;
}

export function formatTierRevenueLines(t: TierRevenueBreakdown): string {
  return (
    `• Regular: *${t.regular.periodStars.toLocaleString()} ⭐* this period · ${t.regular.activeSubscribers} active\n` +
    `• Retro Plus: *${t.retro_plus.periodStars.toLocaleString()} ⭐* this period · ${t.retro_plus.activeSubscribers} active\n`
  );
}
