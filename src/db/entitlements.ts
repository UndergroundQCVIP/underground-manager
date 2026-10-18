/**
 * Underground Manager — Entitlement Repository
 */

import { getKv } from "./kv.ts";
import {
  Entitlement,
  EntitlementStatus,
  MembershipSummary,
  SpaceId,
} from "../types.ts";

export async function createEntitlement(
  data: Omit<Entitlement, "id" | "createdAt" | "updatedAt">
): Promise<Entitlement> {
  const kv = await getKv();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const entitlement: Entitlement = {
    ...data,
    id,
    createdAt: now,
    updatedAt: now,
  };

  const atomic = kv.atomic();
  atomic.set(["entitlements", id], entitlement);
  atomic.set(["entitlements_by_user", data.userId, id], entitlement);

  if (entitlement.status === "active") {
    atomic.set(["active_entitlements_by_user", data.userId, id], entitlement);
  }

  const res = await atomic.commit();
  if (!res.ok) {
    throw new Error(`Failed to commit entitlement ${id} for user ${data.userId}`);
  }

  return entitlement;
}

export async function getEntitlement(id: string): Promise<Entitlement | null> {
  const kv = await getKv();
  const res = await kv.get<Entitlement>(["entitlements", id]);
  return res.value ?? null;
}

export async function getUserEntitlements(userId: number): Promise<Entitlement[]> {
  const kv = await getKv();
  const iter = kv.list<Entitlement>({
    prefix: ["entitlements_by_user", userId],
  });
  const results: Entitlement[] = [];
  for await (const entry of iter) {
    if (entry.value) {
      results.push(entry.value);
    }
  }
  // Sort descending by startsAt
  return results.sort(
    (a, b) => new Date(b.startsAt).getTime() - new Date(a.startsAt).getTime()
  );
}

export async function getActiveUserEntitlements(userId: number): Promise<Entitlement[]> {
  const all = await getUserEntitlements(userId);
  const nowMs = Date.now();

  const active: Entitlement[] = [];
  for (const ent of all) {
    const expiresMs = new Date(ent.expiresAt).getTime();
    if (ent.status === "active" && expiresMs > nowMs) {
      active.push(ent);
    } else if (ent.status === "active" && expiresMs <= nowMs) {
      // Lazy transition expired entitlement
      await updateEntitlementStatus(ent.id, "expired");
    }
  }

  return active;
}

export async function hasAccessToSpace(userId: number, spaceId: SpaceId): Promise<boolean> {
  const active = await getActiveUserEntitlements(userId);
  return active.some((ent) => ent.spaces.includes(spaceId));
}

export async function getMembershipSummary(userId: number): Promise<MembershipSummary> {
  const activeEntitlements = await getActiveUserEntitlements(userId);
  const hasPaid = activeEntitlements.some((e) => e.source === "telegram_stars");
  const hasComplimentary = activeEntitlements.some((e) => e.source === "complimentary");

  const accessibleSpaceSet = new Set<SpaceId>();
  let latestExpiryMs = 0;

  for (const ent of activeEntitlements) {
    for (const space of ent.spaces) {
      accessibleSpaceSet.add(space);
    }
    const expMs = new Date(ent.expiresAt).getTime();
    if (expMs > latestExpiryMs) {
      latestExpiryMs = expMs;
    }
  }

  const isMember = activeEntitlements.length > 0;
  let primaryType: "Paid" | "Complimentary" | "None" = "None";
  if (hasPaid) {
    primaryType = "Paid";
  } else if (hasComplimentary) {
    primaryType = "Complimentary";
  }

  return {
    userId,
    isMember,
    hasPaid,
    hasComplimentary,
    primaryType,
    activeEntitlements,
    accessibleSpaces: Array.from(accessibleSpaceSet),
    effectiveExpiry: latestExpiryMs > 0 ? new Date(latestExpiryMs).toISOString() : undefined,
    isRecurring: hasPaid,
    canRejoin: isMember,
  };
}

export async function updateEntitlementStatus(
  id: string,
  status: EntitlementStatus
): Promise<void> {
  const kv = await getKv();
  const current = await getEntitlement(id);
  if (!current) return;

  const now = new Date().toISOString();
  const updated: Entitlement = {
    ...current,
    status,
    updatedAt: now,
  };

  const atomic = kv.atomic();
  atomic.set(["entitlements", id], updated);
  atomic.set(["entitlements_by_user", current.userId, id], updated);

  if (status === "active") {
    atomic.set(["active_entitlements_by_user", current.userId, id], updated);
  } else {
    atomic.delete(["active_entitlements_by_user", current.userId, id]);
  }

  await atomic.commit();
}

export async function extendEntitlement(
  id: string,
  additionalSeconds: number
): Promise<Entitlement | null> {
  const kv = await getKv();
  const current = await getEntitlement(id);
  if (!current) return null;

  const currentExpiryMs = new Date(current.expiresAt).getTime();
  const baseMs = Math.max(currentExpiryMs, Date.now());
  const newExpiryIso = new Date(baseMs + additionalSeconds * 1000).toISOString();
  const now = new Date().toISOString();

  const updated: Entitlement = {
    ...current,
    expiresAt: newExpiryIso,
    status: "active",
    updatedAt: now,
  };

  const atomic = kv.atomic();
  atomic.set(["entitlements", id], updated);
  atomic.set(["entitlements_by_user", current.userId, id], updated);
  atomic.set(["active_entitlements_by_user", current.userId, id], updated);

  const res = await atomic.commit();
  if (!res.ok) {
    throw new Error(`Failed to extend entitlement ${id}`);
  }

  return updated;
}

export async function revokeEntitlement(
  id: string,
  reason?: string
): Promise<Entitlement | null> {
  const kv = await getKv();
  const current = await getEntitlement(id);
  if (!current) return null;

  const now = new Date().toISOString();
  const updated: Entitlement = {
    ...current,
    status: "revoked",
    updatedAt: now,
    metadata: {
      ...current.metadata,
      notes: reason ? `Revoked: ${reason}` : "Revoked by administrator",
    },
  };

  const atomic = kv.atomic();
  atomic.set(["entitlements", id], updated);
  atomic.set(["entitlements_by_user", current.userId, id], updated);
  atomic.delete(["active_entitlements_by_user", current.userId, id]);

  const res = await atomic.commit();
  if (!res.ok) {
    throw new Error(`Failed to revoke entitlement ${id}`);
  }

  return updated;
}

export async function markReminderSent(id: string): Promise<void> {
  const kv = await getKv();
  const current = await getEntitlement(id);
  if (!current) return;

  const updated: Entitlement = {
    ...current,
    metadata: {
      ...current.metadata,
      reminderSent: true,
    },
    updatedAt: new Date().toISOString(),
  };

  await kv.set(["entitlements", id], updated);
  await kv.set(["entitlements_by_user", current.userId, id], updated);
}

export async function listAllEntitlements(): Promise<Entitlement[]> {
  const kv = await getKv();
  const iter = kv.list<Entitlement>({ prefix: ["entitlements"] });
  const entitlements: Entitlement[] = [];
  for await (const entry of iter) {
    if (entry.value) {
      entitlements.push(entry.value);
    }
  }
  return entitlements;
}

export async function countActivePaidSubscribers(): Promise<number> {
  const all = await listAllEntitlements();
  const nowMs = Date.now();
  const paidUsers = new Set<number>();

  for (const e of all) {
    if (
      e.source === "telegram_stars" &&
      e.status === "active" &&
      new Date(e.expiresAt).getTime() > nowMs
    ) {
      paidUsers.add(e.userId);
    }
  }

  return paidUsers.size;
}

