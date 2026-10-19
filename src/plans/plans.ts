/**
 * LA CONFRÉRIE — Membership Plan Definitions (UG-04)
 *
 * Two recurring Telegram Stars plans. Access is still decided by the
 * provider-independent entitlement engine; a plan only determines which
 * spaces the resulting entitlement carries.
 */

import { getClubName, getConfig } from "../config.ts";
import {
  Entitlement,
  MembershipPlanId,
  PLAN_PAYLOAD_IDS,
  REGULAR_SPACE_IDS,
  RETRO_PLUS_SPACE_IDS,
  SpaceId,
} from "../types.ts";

export interface PlanDefinition {
  id: MembershipPlanId;
  rank: number; // Higher = more access
  label: string;
  payloadId: string;
  priceStars: number; // 0 = unconfigured
  enabled: boolean; // Purchasable right now
  spaces: SpaceId[];
}

export function getPlan(planId: MembershipPlanId): PlanDefinition {
  const config = getConfig();
  if (planId === "retro_plus") {
    const price = config.RETRO_PLUS_STARS_PRICE_AMOUNT;
    return {
      id: "retro_plus",
      rank: 2,
      label: "Retro Plus",
      payloadId: PLAN_PAYLOAD_IDS.retro_plus,
      priceStars: price,
      // Billing stays off until a price is configured AND the Retro forum exists.
      enabled: price > 0 && config.TELEGRAM_RETRO_FORUM_CHAT_ID !== 0,
      spaces: [...RETRO_PLUS_SPACE_IDS],
    };
  }
  return {
    id: "regular",
    rank: 1,
    label: "Regular",
    payloadId: PLAN_PAYLOAD_IDS.regular,
    priceStars: config.STARS_PRICE_AMOUNT,
    enabled: config.STARS_PRICE_AMOUNT > 0,
    spaces: [...REGULAR_SPACE_IDS],
  };
}

export const ALL_PLAN_IDS: readonly MembershipPlanId[] = ["regular", "retro_plus"];

export function planFromPayloadId(payloadPlanId: string | undefined): MembershipPlanId | null {
  if (payloadPlanId === PLAN_PAYLOAD_IDS.regular) return "regular";
  if (payloadPlanId === PLAN_PAYLOAD_IDS.retro_plus) return "retro_plus";
  return null;
}

/** Legacy entitlements/payments carry no plan and are Regular. */
export function entitlementPlan(ent: Pick<Entitlement, "plan">): MembershipPlanId {
  return ent.plan ?? "regular";
}

export function planDisplayName(planId: MembershipPlanId): string {
  return `${getClubName()} ${getPlan(planId).label}`;
}
