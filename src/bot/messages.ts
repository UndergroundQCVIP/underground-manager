/**
 * LA CONFRÉRIE — Message Templates & Strings
 * Organized cleanly to facilitate future localization (e.g. French/English).
 * Every club-facing name comes from CLUB_DISPLAY_NAME (see config.ts).
 */

import { getClubName, getConfig } from "../config.ts";
import { MembershipPlanId, MembershipSummary, SpaceId } from "../types.ts";
import { getSpaceTitle } from "../access/spaces.ts";
import { getPlan } from "../plans/plans.ts";

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function planLine(planId: MembershipPlanId): string {
  const plan = getPlan(planId);
  const price = plan.enabled ? `${plan.priceStars} Stars / 30 days` : "Coming soon";
  return `*${plan.label}* — ${price}`;
}

export const messages = {
  welcome: (firstName: string, isMember: boolean, plan: MembershipPlanId | "none" = "none") => {
    const club = getClubName();
    if (isMember) {
      const planName = plan === "retro_plus" ? "Retro Plus" : plan === "regular" ? "Regular" : "";
      return (
        `👋 *Welcome back, ${escapeMarkdown(firstName)}!*\n\n` +
        `You have an active *${club}*${planName ? ` *${planName}*` : ""} membership.\n` +
        `Manage your subscription or access your private spaces below.`
      );
    }
    return (
      `👋 *Welcome to ${club}, ${escapeMarkdown(firstName)}.*\n\n` +
      `${club} is an exclusive private community featuring curated creator archives, private collections, and member discussions.\n\n` +
      `🌟 ${planLine("regular")}\n` +
      `🎞️ ${planLine("retro_plus")}\n` +
      `Recurring subscriptions billed via official Telegram Stars.\n\n` +
      `Select an option below to join or manage your account:`
    );
  },

  plansOverview: (summary?: MembershipSummary) => {
    const club = getClubName();
    const retro = getPlan("retro_plus");
    let text =
      `💎 *${club} — MEMBERSHIP PLANS*\n\n` +
      `*Regular* — ${getPlan("regular").priceStars} Stars / 30 days\n` +
      `• TOKEBEC VIP COLLECTIONS (Regular vault)\n` +
      `• Private Wanted List\n` +
      `• ${club} General Chat\n` +
      `• Creator nominations & voting\n\n` +
      `*Retro Plus* — ${retro.enabled ? `${retro.priceStars} Stars / 30 days` : "Coming soon"}\n` +
      `• Everything in Regular\n` +
      `• RETRO | ${club} (Retro vault)\n\n` +
      `Both plans have identical voting rights. Retro Plus only adds the Retro collection.\n` +
      `🔄 Recurring 30-day Telegram Stars subscriptions — cancel anytime in Telegram Settings > Stars.`;
    if (summary?.plan === "regular" && retro.enabled) {
      text += `\n\n⬆️ You can upgrade to Retro Plus below.`;
    }
    return text;
  },

  nonMemberInfo: () => messages.plansOverview(),

  membershipStatus: (summary: MembershipSummary) => {
    if (!summary.isMember) {
      return (
        `📋 *MY MEMBERSHIP*\n\n` +
        `*Status:* ⚪ Inactive / No Subscription\n` +
        `*Regular:* ${getPlan("regular").priceStars} Stars every 30 days\n` +
        `*Retro Plus:* ${getPlan("retro_plus").enabled ? `${getPlan("retro_plus").priceStars} Stars every 30 days` : "Coming soon"}\n\n` +
        `You do not currently have an active membership. Tap below to see the plans.`
      );
    }

    const typeStr = summary.hasPaid ? "🌟 Paid (Telegram Stars)" : "🎁 Complimentary";
    const planStr = summary.plan === "retro_plus" ? "🎞️ Retro Plus" : "Regular";

    const expiryStr = summary.effectiveExpiry
      ? new Date(summary.effectiveExpiry).toLocaleDateString("en-US", {
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "Indefinite";

    const spacesList = summary.accessibleSpaces
      .map((s) => `  ✓ ${getSpaceTitle(s)}`)
      .join("\n");

    const renewalStr = summary.isRecurring
      ? "Automatic renewal every 30 days via Telegram Stars"
      : "Non-renewing (Complimentary grant)";

    // Per-entitlement paid-through dates make plan changes transparent.
    const lines = summary.activeEntitlements
      .filter((e) => e.source === "telegram_stars")
      .map((e) => `  • ${getPlan(e.plan ?? "regular").label}: paid through ${fmtDate(e.expiresAt)}`)
      .join("\n");

    return (
      `📋 *MY MEMBERSHIP*\n\n` +
      `*Plan:* ${planStr}\n` +
      `*Type:* ${typeStr}\n` +
      `*Status:* 🟢 Active\n` +
      `*Valid Until:* ${expiryStr}\n` +
      `*Renewal:* ${renewalStr}\n` +
      (lines ? `${lines}\n` : "") +
      `\n*Accessible Spaces:*\n${spacesList}\n\n` +
      `_Manage recurring Telegram subscriptions anytime in Telegram Settings > Stars._`
    );
  },

  accessChannels: (accessibleSpaces: SpaceId[]) => {
    if (accessibleSpaces.length === 0) {
      return (
        `🔒 *ACCESS PRIVATE CHANNELS*\n\n` +
        `You do not have access to any private spaces.\n` +
        `Please purchase a subscription to unlock ${getClubName()} spaces.`
      );
    }

    return (
      `🔓 *ACCESS PRIVATE CHANNELS*\n\n` +
      `Tap each button below to request to join your authorized spaces.\n` +
      `Our system will automatically approve your request instantly.`
    );
  },

  paySupport: () => {
    const config = getConfig();
    return (
      `💬 *${getClubName()} SUPPORT & BILLING*\n\n` +
      `Need help with your subscription or payment?\n\n` +
      `• *Telegram Stars:* Managed directly by Telegram. You can view, manage, or cancel active subscriptions in Telegram Settings > Stars.\n` +
      `• *Bot Support:* Contact ${config.SUPPORT_USERNAME} with your Telegram ID for billing inquiries.\n` +
      `• *Refunds:* Eligible refunds are processed according to Telegram Stars policies.`
    );
  },

  paymentSuccess: (expiresAt: string, planId: MembershipPlanId = "regular") => {
    const club = getClubName();
    const retroLine = planId === "retro_plus" ? `• RETRO | ${club}\n` : "";
    return (
      `🎉 *PAYMENT CONFIRMED!*\n\n` +
      `Thank you! Your ${club} *${getPlan(planId).label}* subscription is now *active* until *${fmtDate(expiresAt)}*.\n\n` +
      `You now have access to:\n` +
      `• TOKEBEC VIP COLLECTIONS\n` +
      retroLine +
      `• ${club} General Chat\n` +
      `• Wanted List\n\n` +
      `Tap *Access My Channels* below to enter your spaces!`
    );
  },

  adminMenu: () => {
    return (
      `🛠️ *${getClubName()} | ADMIN*\n\n` +
      `Select an administrative module:`
    );
  },

  unauthorized: () => {
    return `⛔ *Access Denied:* You are not authorized to access administration.`;
  },
};

export function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}
