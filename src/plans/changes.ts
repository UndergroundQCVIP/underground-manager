/**
 * LA CONFRÉRIE — Plan Upgrade / Downgrade Workflow (UG-04)
 *
 * Telegram Stars subscriptions have no seamless proration, so this is a
 * transparent cancel-and-resubscribe flow:
 *
 *  Regular → Retro Plus: the user confirms, pays the full Retro Plus price via
 *    a new Stars subscription, and ONLY after that payment is verified do we
 *    (if the user authorized it) cancel the Regular subscription's next
 *    renewal. Already-paid Regular access runs to its paid-through date.
 *
 *  Retro Plus → Regular: on the user's confirmation we cancel Retro Plus
 *    renewal. Retro access remains until the paid-through date, then expires.
 *
 * Nothing is ever cancelled without an explicit user confirmation.
 */

import { getActivePaidEntitlements } from "../db/entitlements.ts";
import { getUserPayments } from "../db/payments.ts";
import { getPlanChangeIntent, savePlanChangeIntent } from "../db/plan_changes.ts";
import { logAuditEvent } from "../db/audit.ts";
import { MembershipPlanId, Payment } from "../types.ts";
import { getPlan } from "./plans.ts";

export interface StarSubscriptionApiLike {
  editUserStarSubscription(
    userId: number,
    telegramPaymentChargeId: string,
    isCanceled: boolean
  ): Promise<boolean>;
}

const INTENT_TTL_MS = 24 * 3600 * 1000;

export interface PlanChangeQuote {
  ok: boolean;
  error?: string;
  fromPlan?: MembershipPlanId;
  toPlan?: MembershipPlanId;
  newPriceStars?: number;
  /** Paid-through date of the plan being left (access is preserved until then). */
  currentPaidThrough?: string;
  /** Retro access begins on payment verification (upgrade). */
  effectiveImmediately?: boolean;
}

/** Facts shown to the user before they confirm an upgrade. */
export async function quoteUpgrade(userId: number): Promise<PlanChangeQuote> {
  const retro = getPlan("retro_plus");
  if (!retro.enabled) {
    return { ok: false, error: "La facturation Retro Plus n'est pas encore disponible." };
  }
  const retroActive = await getActivePaidEntitlements(userId, "retro_plus");
  if (retroActive.length > 0) {
    return { ok: false, error: "Vous avez déjà un abonnement Retro Plus actif." };
  }
  const regular = (await getActivePaidEntitlements(userId, "regular"))[0];
  return {
    ok: true,
    fromPlan: "regular",
    toPlan: "retro_plus",
    newPriceStars: retro.priceStars,
    currentPaidThrough: regular?.expiresAt,
    effectiveImmediately: true,
  };
}

/** Record the user's confirmed intent (before they pay). Does not cancel anything. */
export async function confirmUpgradeIntent(
  userId: number,
  authorizeCancelRenewal: boolean
): Promise<PlanChangeQuote> {
  const quote = await quoteUpgrade(userId);
  if (!quote.ok) return quote;
  const now = Date.now();
  await savePlanChangeIntent({
    userId,
    fromPlan: "regular",
    toPlan: "retro_plus",
    authorizedCancelRenewal: authorizeCancelRenewal,
    status: "pending",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + INTENT_TTL_MS).toISOString(),
  });
  await logAuditEvent(
    "plan_change_requested",
    { from: "regular", to: "retro_plus", authorizeCancelRenewal },
    userId,
    userId
  );
  return quote;
}

/** Charge IDs of a plan's subscription, newest first (Telegram needs one of them). */
async function chargeIdsForPlan(userId: number, plan: MembershipPlanId): Promise<string[]> {
  const payments: Payment[] = await getUserPayments(userId);
  return payments
    .filter((p) => (p.planId ?? "regular") === plan && p.status === "completed")
    .map((p) => p.chargeId);
}

export async function cancelPlanRenewal(
  api: StarSubscriptionApiLike,
  userId: number,
  plan: MembershipPlanId
): Promise<{ cancelled: boolean; error?: string }> {
  const chargeIds = await chargeIdsForPlan(userId, plan);
  if (chargeIds.length === 0) {
    return { cancelled: false, error: "Aucun paiement en Étoiles trouvé pour ce forfait (rien à annuler)." };
  }
  let lastError = "";
  for (const chargeId of chargeIds) {
    try {
      await api.editUserStarSubscription(userId, chargeId, true);
      await logAuditEvent("plan_renewal_cancelled", { plan, chargeId }, userId, userId);
      return { cancelled: true };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  await logAuditEvent("plan_renewal_cancel_failed", { plan, error: lastError }, 0, userId);
  return { cancelled: false, error: lastError };
}

export interface PlanChangeApplied {
  upgraded: boolean;
  cancelOutcome: "cancelled" | "failed" | "not_needed";
  error?: string;
}

/**
 * Called after a Retro Plus payment has been VERIFIED and credited.
 * Cancels the Regular renewal only if the user authorized it beforehand.
 */
export async function applyPlanChangeAfterPayment(
  api: StarSubscriptionApiLike,
  userId: number,
  paidPlan: MembershipPlanId
): Promise<PlanChangeApplied | null> {
  if (paidPlan !== "retro_plus") return null;
  const intent = await getPlanChangeIntent(userId);
  if (!intent || intent.status !== "pending" || intent.toPlan !== "retro_plus") return null;

  if (new Date(intent.expiresAt).getTime() < Date.now()) {
    await savePlanChangeIntent({ ...intent, status: "expired" });
    return null;
  }

  let cancelOutcome: PlanChangeApplied["cancelOutcome"] = "not_needed";
  let error: string | undefined;
  if (intent.authorizedCancelRenewal) {
    const res = await cancelPlanRenewal(api, userId, "regular");
    cancelOutcome = res.cancelled ? "cancelled" : "failed";
    error = res.error;
    // No Regular payment on record means there is no renewal to cancel.
    if (!res.cancelled && res.error?.startsWith("Aucun paiement en Étoiles")) {
      cancelOutcome = "not_needed";
      error = undefined;
    }
  }

  await savePlanChangeIntent({
    ...intent,
    status: "applied",
    appliedAt: new Date().toISOString(),
    cancelOutcome,
    cancelError: error,
  });
  return { upgraded: true, cancelOutcome, error };
}

export interface DowngradeQuote {
  ok: boolean;
  error?: string;
  retroPaidThrough?: string;
  regularPaidThrough?: string;
}

export async function quoteDowngrade(userId: number): Promise<DowngradeQuote> {
  const retro = (await getActivePaidEntitlements(userId, "retro_plus"))[0];
  if (!retro) return { ok: false, error: "Vous n'avez pas d'abonnement Retro Plus actif." };
  const regular = (await getActivePaidEntitlements(userId, "regular"))[0];
  return { ok: true, retroPaidThrough: retro.expiresAt, regularPaidThrough: regular?.expiresAt };
}

/** User-confirmed downgrade: stop Retro Plus renewal; access stays until paid-through date. */
export async function confirmDowngrade(
  api: StarSubscriptionApiLike,
  userId: number
): Promise<DowngradeQuote & { cancelled?: boolean }> {
  const quote = await quoteDowngrade(userId);
  if (!quote.ok) return quote;
  await logAuditEvent(
    "plan_change_requested",
    { from: "retro_plus", to: "regular", authorizeCancelRenewal: true },
    userId,
    userId
  );
  const res = await cancelPlanRenewal(api, userId, "retro_plus");
  return { ...quote, ok: res.cancelled, cancelled: res.cancelled, error: res.error };
}
