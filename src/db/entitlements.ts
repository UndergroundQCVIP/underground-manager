/**
 * LA CONFRÉRIE — Entitlement Repository
 */

import { getKv } from "./kv.ts";
import {
  Entitlement,
  EntitlementStatus,
  CollectionCategory,
  MembershipPlanId,
  MembershipSummary,
  SpaceId,
} from "../types.ts";

/** Jittered pause between optimistic-concurrency retries. */
async function backoff(attempt: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, Math.random() * 8 * (attempt + 1)));
}

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

export function isEntitlementActive(ent: Entitlement, nowMs = Date.now()): boolean {
  return ent.status === "active" && new Date(ent.expiresAt).getTime() > nowMs;
}

/**
 * Entitlements that currently grant access. This is a pure read: validity is
 * always derived from `status` + `expiresAt`. (A previous version lazily wrote
 * "expired" back from this read path, which could clobber a concurrent
 * renewal; persisted expiry is now done by `expireStaleEntitlements`.)
 */
export async function getActiveUserEntitlements(userId: number): Promise<Entitlement[]> {
  const all = await getUserEntitlements(userId);
  const nowMs = Date.now();
  return all.filter((ent) => isEntitlementActive(ent, nowMs));
}

/** Active Stars-paid entitlements, optionally limited to one plan (legacy = regular). */
export async function getActivePaidEntitlements(
  userId: number,
  plan?: MembershipPlanId
): Promise<Entitlement[]> {
  const active = await getActiveUserEntitlements(userId);
  return active.filter(
    (e) => e.source === "telegram_stars" && (!plan || (e.plan ?? "regular") === plan)
  );
}

export async function hasAccessToSpace(userId: number, spaceId: SpaceId): Promise<boolean> {
  const active = await getActiveUserEntitlements(userId);
  return active.some((ent) => entitlementGrantsSpace(ent, spaceId));
}

/** Amateur requires an explicit manual admin grant, never a paid/contribution/full entitlement. */
export function entitlementGrantsSpace(ent: Entitlement, spaceId: SpaceId): boolean {
  return ent.spaces.includes(spaceId) && (spaceId !== "amateur_collections" ||
    (ent.source === "complimentary" && ent.metadata?.accessLevel === "amateur" &&
      Number.isSafeInteger(ent.metadata.grantedBy) && (ent.metadata.grantedBy ?? 0) > 0));
}

export async function getMembershipSummary(userId: number): Promise<MembershipSummary> {
  const activeEntitlements = await getActiveUserEntitlements(userId);
  const hasPaid = activeEntitlements.some((e) => e.source === "telegram_stars");
  const hasComplimentary = activeEntitlements.some((e) => e.source === "complimentary");
  const hasContribution = activeEntitlements.some(isContentEarnedEntitlement);

  const accessibleSpaceSet = new Set<SpaceId>();
  let latestExpiryMs = 0;

  for (const ent of activeEntitlements) {
    for (const space of ent.spaces) {
      if (entitlementGrantsSpace(ent, space)) accessibleSpaceSet.add(space);
    }
    const expMs = new Date(ent.expiresAt).getTime();
    if (expMs > latestExpiryMs) {
      latestExpiryMs = expMs;
    }
  }

  const isMember = activeEntitlements.length > 0;
  let primaryType: "Paid" | "Contribution" | "Complimentary" | "None" = "None";
  if (hasPaid) {
    primaryType = "Paid";
  } else if (hasContribution) {
    primaryType = "Contribution";
  } else if (hasComplimentary) {
    primaryType = "Complimentary";
  }

  const hasRetroAccess = accessibleSpaceSet.has("retro_collections");

  return {
    userId,
    isMember,
    plan: hasRetroAccess ? "retro_plus" : accessibleSpaceSet.has("vip_collections") ? "regular" : "none",
    hasRetroAccess,
    hasPaid,
    hasComplimentary,
    hasContribution,
    canParticipate: hasPaid || hasContribution,
    primaryType,
    activeEntitlements,
    accessibleSpaces: Array.from(accessibleSpaceSet),
    effectiveExpiry: latestExpiryMs > 0 ? new Date(latestExpiryMs).toISOString() : undefined,
    isRecurring: hasPaid,
    canRejoin: isMember,
  };
}

/** Includes older admin grants explicitly recorded as a content contribution reward. */
export function isContentEarnedEntitlement(e: Entitlement): boolean {
  return e.source === "contribution" ||
    (e.source === "complimentary" && e.metadata?.reason === "content_contribution");
}

/**
 * Optimistic-concurrency read-modify-write of one entitlement. `fn` receives the
 * latest stored value and returns the replacement (or null to leave it alone).
 * The commit is rejected if the entitlement changed in between, then retried.
 */
export async function mutateEntitlement(
  id: string,
  fn: (current: Entitlement) => Entitlement | null
): Promise<Entitlement | null> {
  const kv = await getKv();
  for (let attempt = 0; attempt < 20; attempt++) {
    const res = await kv.get<Entitlement>(["entitlements", id]);
    const current = res.value;
    if (!current) return null;

    const next = fn(current);
    if (!next) return current;

    const updated: Entitlement = { ...next, updatedAt: new Date().toISOString() };
    const atomic = kv.atomic();
    atomic.check(res);
    atomic.set(["entitlements", id], updated);
    atomic.set(["entitlements_by_user", updated.userId, id], updated);
    if (updated.status === "active") {
      atomic.set(["active_entitlements_by_user", updated.userId, id], updated);
    } else {
      atomic.delete(["active_entitlements_by_user", updated.userId, id]);
    }
    const commit = await atomic.commit();
    if (commit.ok) return updated;
    await backoff(attempt);
  }
  throw new Error(`Entitlement ${id} could not be updated (persistent write conflict)`);
}

export async function updateEntitlementStatus(
  id: string,
  status: EntitlementStatus
): Promise<void> {
  await mutateEntitlement(id, (cur) => (cur.status === status ? null : { ...cur, status }));
}

/**
 * Extends an entitlement by `additionalSeconds` from the later of its current
 * expiry and now. Revoked entitlements are never revived (returns null).
 */
export async function extendEntitlement(
  id: string,
  additionalSeconds: number
): Promise<Entitlement | null> {
  const current = await getEntitlement(id);
  if (!current || current.status === "revoked") return null;

  return await mutateEntitlement(id, (cur) => {
    if (cur.status === "revoked") return null;
    const baseMs = Math.max(new Date(cur.expiresAt).getTime(), Date.now());
    return {
      ...cur,
      expiresAt: new Date(baseMs + additionalSeconds * 1000).toISOString(),
      status: "active",
    };
  });
}

export async function revokeEntitlement(
  id: string,
  reason?: string
): Promise<Entitlement | null> {
  return await mutateEntitlement(id, (cur) => ({
    ...cur,
    status: "revoked",
    metadata: {
      ...cur.metadata,
      notes: reason ? `Revoked: ${reason}` : "Revoked by administrator",
    },
  }));
}

export async function markReminderSent(id: string): Promise<void> {
  await mutateEntitlement(id, (cur) =>
    cur.metadata?.reminderSent ? null : { ...cur, metadata: { ...cur.metadata, reminderSent: true } }
  );
}

/**
 * Persists "expired" for active entitlements whose time has passed. Safe against
 * concurrent renewals: the transition is re-validated against the latest value.
 */
export async function expireStaleEntitlements(): Promise<number> {
  const all = await listAllEntitlements();
  const nowMs = Date.now();
  let expired = 0;
  for (const ent of all) {
    if (ent.status === "active" && new Date(ent.expiresAt).getTime() <= nowMs) {
      const result = await mutateEntitlement(ent.id, (cur) =>
        cur.status === "active" && new Date(cur.expiresAt).getTime() <= Date.now()
          ? { ...cur, status: "expired" }
          : null
      );
      if (result?.status === "expired") expired++;
    }
  }
  return expired;
}

export interface ApplyPaidPeriodParams {
  userId: number;
  chargeId: string;
  /** Telegram's authoritative subscription_expiration_date, if supplied. */
  telegramExpiryIso?: string;
  periodSeconds: number;
  invoicePayload?: string;
  spaces: SpaceId[];
  /** UG-04: which plan this charge pays for (default regular). */
  plan?: MembershipPlanId;
}

export interface ApplyPaidPeriodResult {
  alreadyFulfilled: boolean;
  created: boolean;
  entitlement?: Entitlement;
  /** Set when the Telegram expiry looked implausible and was ignored. */
  expiryAnomaly?: string;
}

/**
 * Atomically credits one verified paid charge to the user's paid entitlement
 * (create or extend) and marks the charge as fulfilled in the same commit, so a
 * charge can never be credited twice and a crash can never leave it half-applied.
 */
export async function applyPaidPeriod(
  params: ApplyPaidPeriodParams
): Promise<ApplyPaidPeriodResult> {
  const kv = await getKv();
  const fulfilledKey = ["payment_fulfilled", params.chargeId];
  const pendingKey = ["payments_pending_fulfillment", params.chargeId];

  for (let attempt = 0; attempt < 20; attempt++) {
    const fulfilled = await kv.get<{ entitlementId?: string }>(fulfilledKey);
    if (fulfilled.value) {
      const ent = fulfilled.value.entitlementId
        ? await getEntitlement(fulfilled.value.entitlementId)
        : null;
      return { alreadyFulfilled: true, created: false, entitlement: ent ?? undefined };
    }

    const nowMs = Date.now();

    // One paid entitlement per member, tracked by a pointer whose version is part of
    // the commit: two concurrent first charges cannot both create one.
    const plan = params.plan ?? "regular";
    // Regular keeps the original (UG-01..03) pointer key; Retro Plus has its own.
    const pointerKey = plan === "retro_plus"
      ? ["paid_entitlement_ptr", params.userId, "retro_plus"]
      : ["paid_entitlement_ptr", params.userId];
    const pointer = await kv.get<string>(pointerKey);
    let existingId = pointer.value ?? null;
    if (!existingId) {
      // Entitlements that predate the pointer: adopt the active paid one, if any.
      const legacy = (await getUserEntitlements(params.userId)).find(
        (e) =>
          e.source === "telegram_stars" &&
          (e.plan ?? "regular") === plan &&
          isEntitlementActive(e, nowMs)
      );
      existingId = legacy?.id ?? null;
    }
    const existingRes = existingId ? await kv.get<Entitlement>(["entitlements", existingId]) : null;
    const existing =
      existingRes?.value && isEntitlementActive(existingRes.value, nowMs) ? existingRes.value : null;
    const existingExpiryMs = existing ? new Date(existing.expiresAt).getTime() : 0;

    // Resolve the new expiry: Telegram's own timestamp wins when plausible.
    let anomaly: string | undefined;
    let telegramMs: number | undefined;
    if (params.telegramExpiryIso) {
      const ms = new Date(params.telegramExpiryIso).getTime();
      const maxPlausible = nowMs + params.periodSeconds * 2000 + 86400_000;
      if (Number.isNaN(ms) || ms > maxPlausible) {
        anomaly = `implausible subscription_expiration_date ${params.telegramExpiryIso}`;
      } else {
        telegramMs = ms;
      }
    }

    let newExpiryMs: number;
    if (telegramMs !== undefined) {
      newExpiryMs = Math.max(telegramMs, existingExpiryMs);
    } else {
      newExpiryMs = Math.max(nowMs, existingExpiryMs) + params.periodSeconds * 1000;
    }

    const atomic = kv.atomic();
    atomic.check({ key: fulfilledKey, versionstamp: null });
    atomic.check(pointer);

    let entitlement: Entitlement | undefined;
    let created = false;
    const nowIso = new Date(nowMs).toISOString();

    if (existing && existingRes) {
      atomic.check(existingRes);
      if (pointer.value !== existing.id) atomic.set(pointerKey, existing.id);
      entitlement = {
        ...existing,
        expiresAt: new Date(newExpiryMs).toISOString(),
        status: "active",
        updatedAt: nowIso,
        metadata: { ...existing.metadata, chargeId: params.chargeId },
      };
    } else if (newExpiryMs > nowMs) {
      created = true;
      entitlement = {
        id: crypto.randomUUID(),
        userId: params.userId,
        source: "telegram_stars",
        spaces: [...params.spaces],
        plan,
        startsAt: nowIso,
        expiresAt: new Date(newExpiryMs).toISOString(),
        status: "active",
        metadata: { chargeId: params.chargeId, invoicePayload: params.invoicePayload },
        createdAt: nowIso,
        updatedAt: nowIso,
      };
    }
    // else: Telegram says this paid period already lapsed (late delivery) — record
    // the charge as fulfilled but grant nothing.

    if (entitlement) {
      if (created) atomic.set(pointerKey, entitlement.id);
      atomic.set(["entitlements", entitlement.id], entitlement);
      atomic.set(["entitlements_by_user", entitlement.userId, entitlement.id], entitlement);
      atomic.set(["active_entitlements_by_user", entitlement.userId, entitlement.id], entitlement);
    }
    atomic.set(fulfilledKey, { entitlementId: entitlement?.id, at: nowIso });
    atomic.delete(pendingKey);

    const commit = await atomic.commit();
    if (commit.ok) {
      return { alreadyFulfilled: false, created, entitlement, expiryAnomaly: anomaly };
    }
    await backoff(attempt);
  }
  throw new Error(`Payment ${params.chargeId} could not be fulfilled (persistent write conflict)`);
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

export async function countActiveComplimentaryMembers(): Promise<number> {
  const all = await listAllEntitlements();
  const nowMs = Date.now();
  const compUsers = new Set<number>();

  for (const e of all) {
    if (
      e.source === "complimentary" &&
      e.status === "active" &&
      new Date(e.expiresAt).getTime() > nowMs
    ) {
      compUsers.add(e.userId);
    }
  }

  return compUsers.size;
}



// ==============================================================================
// UG-05: contribution-earned entitlements
// ==============================================================================

export interface ApplyContributionDaysParams {
  userId: number;
  scope: CollectionCategory;
  days: number;
  /** The submission this reward belongs to. Applying it twice is a no-op. */
  contributionId: string;
  spaces: SpaceId[];
}

export interface ApplyContributionDaysResult {
  entitlement: Entitlement;
  applied: boolean; // false = this submission's days were already included
  created: boolean;
}

/**
 * Credits reward days to the member's contribution entitlement for ONE scope:
 *   new_expiration = max(now, existing_expiration) + days
 * It never shortens anything, never touches Stars/complimentary entitlements,
 * and is idempotent per contribution (the id is recorded on the entitlement
 * in the same atomic commit that adds the days).
 */
export async function applyContributionDays(
  params: ApplyContributionDaysParams
): Promise<ApplyContributionDaysResult> {
  const kv = await getKv();
  const pointerKey = ["contrib_ent_ptr", params.userId, params.scope];

  for (let attempt = 0; attempt < 20; attempt++) {
    const pointer = await kv.get<string>(pointerKey);
    const existingRes = pointer.value
      ? await kv.get<Entitlement>(["entitlements", pointer.value])
      : null;
    // A revoked entitlement is never revived; a lapsed one is simply extended from now.
    const existing =
      existingRes?.value && existingRes.value.status !== "revoked" ? existingRes.value : null;

    if (existing?.metadata?.rewardIds?.includes(params.contributionId)) {
      return { entitlement: existing, applied: false, created: false };
    }

    const nowMs = Date.now();
    const baseMs = Math.max(nowMs, existing ? new Date(existing.expiresAt).getTime() : 0);
    const expiresAt = new Date(baseMs + params.days * 86_400_000).toISOString();
    const nowIso = new Date(nowMs).toISOString();

    const atomic = kv.atomic();
    atomic.check(pointer);

    let entitlement: Entitlement;
    let created = false;
    if (existing && existingRes) {
      atomic.check(existingRes);
      entitlement = {
        ...existing,
        spaces: Array.from(new Set([...existing.spaces, ...params.spaces])),
        expiresAt,
        status: "active",
        updatedAt: nowIso,
        metadata: {
          ...existing.metadata,
          rewardIds: [...(existing.metadata?.rewardIds ?? []), params.contributionId],
          lastRewardId: params.contributionId,
          reminderSent: false, // a new expiry deserves a fresh 3-day reminder
        },
      };
    } else {
      created = true;
      entitlement = {
        id: crypto.randomUUID(),
        userId: params.userId,
        source: "contribution",
        contributionScope: params.scope,
        spaces: [...params.spaces],
        startsAt: nowIso,
        expiresAt,
        status: "active",
        metadata: { rewardIds: [params.contributionId], lastRewardId: params.contributionId },
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      atomic.set(pointerKey, entitlement.id);
    }

    atomic.set(["entitlements", entitlement.id], entitlement);
    atomic.set(["entitlements_by_user", entitlement.userId, entitlement.id], entitlement);
    atomic.set(["active_entitlements_by_user", entitlement.userId, entitlement.id], entitlement);

    const commit = await atomic.commit();
    if (commit.ok) return { entitlement, applied: true, created };
    await backoff(attempt);
  }
  throw new Error(`Contribution reward for ${params.userId} could not be applied (write conflict)`);
}

/** Distinct eligible members: paid or content-earned, including legacy content reward grants. */
export async function countEligibleParticipants(): Promise<number> {
  const all = await listAllEntitlements();
  const nowMs = Date.now();
  const users = new Set<number>();
  for (const e of all) {
    if ((e.source === "telegram_stars" || isContentEarnedEntitlement(e)) && isEntitlementActive(e, nowMs)) {
      users.add(e.userId);
    }
  }
  return users.size;
}
