/**
 * LA CONFRÉRIE — Active member roster for administrators (UG-05)
 * Who currently holds access, through what, and how many days remain.
 */

import { listAllEntitlements, isEntitlementActive } from "../db/entitlements.ts";
import { getMember } from "../db/members.ts";
import { Entitlement } from "../types.ts";

export interface RosterEntry {
  userId: number;
  label: string; // @username or first name
  lines: { text: string; expiresAt: string; daysLeft: number }[];
  soonestExpiry: string;
  latestExpiry: string;
}

export function daysLeft(expiresAt: string, nowMs = Date.now()): number {
  return Math.max(0, Math.ceil((new Date(expiresAt).getTime() - nowMs) / 86_400_000));
}

export function describeEntitlement(e: Entitlement): string {
  if (e.source === "telegram_stars") return e.plan === "retro_plus" ? "Étoiles · Retro Plus" : "Étoiles · Regular";
  if (e.source === "contribution") return `Contribution · ${e.contributionScope === "retro" ? "Retro" : "Regular"}`;
  return "Gracieux";
}

/** Everyone with at least one currently valid entitlement, soonest-expiring first. */
export async function buildRoster(nowMs = Date.now()): Promise<RosterEntry[]> {
  const byUser = new Map<number, Entitlement[]>();
  for (const e of await listAllEntitlements()) {
    if (!isEntitlementActive(e, nowMs)) continue;
    byUser.set(e.userId, [...(byUser.get(e.userId) ?? []), e]);
  }
  const out: RosterEntry[] = [];
  for (const [userId, ents] of byUser) {
    const m = await getMember(userId);
    const label = m?.username ? `@${m.username}` : m?.firstName ?? "inconnu";
    const lines = ents
      .map((e) => ({ text: describeEntitlement(e), expiresAt: e.expiresAt, daysLeft: daysLeft(e.expiresAt, nowMs) }))
      .sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
    out.push({
      userId,
      label,
      lines,
      soonestExpiry: lines[0].expiresAt,
      latestExpiry: lines[lines.length - 1].expiresAt,
    });
  }
  return out.sort((a, b) => a.soonestExpiry.localeCompare(b.soonestExpiry));
}
