/**
 * LA CONFRÉRIE — Plan Change Intent Repository (UG-04)
 * Stores the user's explicit authorization for a plan change so that
 * renewal cancellation can only ever happen after they confirmed it.
 */

import { getKv } from "./kv.ts";
import { MembershipPlanId } from "../types.ts";

export interface PlanChangeIntent {
  userId: number;
  fromPlan: MembershipPlanId;
  toPlan: MembershipPlanId;
  /** User explicitly authorized cancelling the previous plan's future renewal. */
  authorizedCancelRenewal: boolean;
  status: "pending" | "applied" | "expired";
  createdAt: string;
  expiresAt: string;
  appliedAt?: string;
  cancelOutcome?: "cancelled" | "failed" | "not_needed";
  cancelError?: string;
}

const key = (userId: number) => ["plan_change_intent", userId];

export async function savePlanChangeIntent(intent: PlanChangeIntent): Promise<void> {
  const kv = await getKv();
  await kv.set(key(intent.userId), intent);
}

export async function getPlanChangeIntent(userId: number): Promise<PlanChangeIntent | null> {
  const kv = await getKv();
  const res = await kv.get<PlanChangeIntent>(key(userId));
  return res.value ?? null;
}
