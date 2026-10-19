/**
 * LA CONFRÉRIE — Membership Acquisition Mode (UG-05)
 *
 * An administrator setting decides which ways of getting access are offered.
 * It only changes what is OFFERED. It never touches existing entitlements,
 * payments, recurring Telegram subscriptions, or financial history.
 */

import { getSystemSettings, updateSystemSettings } from "../db/settings.ts";
import { MembershipMode } from "../types.ts";

export const MODE_LABELS: Record<MembershipMode, string> = {
  contribution_only: "Contributions seulement",
  contributions_and_stars: "Contributions + Étoiles",
  stars_only: "Étoiles seulement",
};

export async function getMembershipMode(): Promise<MembershipMode> {
  return (await getSystemSettings()).membershipMode;
}

export async function setMembershipMode(mode: MembershipMode): Promise<void> {
  await updateSystemSettings({ membershipMode: mode });
}

/** Are NEW Telegram Stars checkouts offered? (Existing subscriptions are unaffected.) */
export async function starsCheckoutEnabled(): Promise<boolean> {
  return (await getMembershipMode()) !== "contribution_only";
}

/** Are contribution rewards (earned days) available to grant? */
export async function contributionRewardsEnabled(): Promise<boolean> {
  const s = await getSystemSettings();
  return s.membershipMode !== "stars_only" || s.contributionRewardsInStarsMode;
}
