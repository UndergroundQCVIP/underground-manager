/**
 * Underground Manager — Message Templates & Strings
 * Organized cleanly to facilitate future localization (e.g. French/English).
 */

import { getConfig } from "../config.ts";
import { formatTorontoDate } from "../util/time.ts";
import { MembershipSummary, SpaceId } from "../types.ts";
import { getSpaceTitle } from "../access/spaces.ts";

export const messages = {
  welcome: (firstName: string, isMember: boolean) => {
    const config = getConfig();
    if (isMember) {
      return (
        `👋 *Welcome back, ${escapeMarkdown(firstName)}!*\n\n` +
        `You have an active *Underground VIP* membership.\n` +
        `Manage your subscription or access your private spaces below.`
      );
    }
    return (
      `👋 *Welcome to Underground Manager, ${escapeMarkdown(firstName)}.*\n\n` +
      `Underground is an exclusive private community featuring curated creator archives, private collections, and VIP discussions.\n\n` +
      `🌟 *VIP Membership:* ${config.STARS_PRICE_AMOUNT} Telegram Stars / 30 days\n` +
      `Recurring subscription billed via official Telegram Stars.\n\n` +
      `Select an option below to join or manage your account:`
    );
  },

  nonMemberInfo: () => {
    const config = getConfig();
    return (
      `💎 *UNDERGROUND VIP MEMBERSHIP*\n\n` +
      `Your subscription grants exclusive access to:\n` +
      `• *TOKEBEC VIP COLLECTIONS* — Curated creator library\n` +
      `• *Underground General Chat* — Private member conversations\n` +
      `• *Wanted List* — Creator requests and nominations\n\n` +
      `💳 *Price:* ${config.STARS_PRICE_AMOUNT} Stars / 30 days\n` +
      `🔄 *Type:* Recurring subscription, cancel anytime via Telegram Settings\n\n` +
      `Tap below to subscribe instantly:`
    );
  },

  membershipStatus: (summary: MembershipSummary) => {
    const config = getConfig();
    if (!summary.isMember) {
      return (
        `📋 *MY MEMBERSHIP*\n\n` +
        `*Status:* ⚪ Inactive / No Subscription\n` +
        `*Price:* ${config.STARS_PRICE_AMOUNT} Stars every 30 days\n\n` +
        `You do not currently have an active membership. Tap below to subscribe.`
      );
    }

    const typeStr = summary.hasPaid
      ? "🌟 Paid (Telegram Stars)"
      : "🎁 Complimentary";

    const expiryStr = summary.effectiveExpiry
      ? formatTorontoDate(summary.effectiveExpiry, {
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

    return (
      `📋 *MY MEMBERSHIP*\n\n` +
      `*Type:* ${typeStr}\n` +
      `*Status:* 🟢 Active\n` +
      `*Valid Until:* ${expiryStr}\n` +
      `*Renewal:* ${renewalStr}\n\n` +
      `*Accessible Spaces:*\n${spacesList}\n\n` +
      `_Manage recurring Telegram subscriptions anytime in Telegram Settings > Stars._`
    );
  },

  accessChannels: (accessibleSpaces: SpaceId[]) => {
    if (accessibleSpaces.length === 0) {
      return (
        `🔒 *ACCESS PRIVATE CHANNELS*\n\n` +
        `You do not have access to any private spaces.\n` +
        `Please purchase a subscription to unlock Underground spaces.`
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
      `💬 *UNDERGROUND SUPPORT & BILLING*\n\n` +
      `Need help with your subscription or payment?\n\n` +
      `• *Telegram Stars:* Managed directly by Telegram. You can view, manage, or cancel active subscriptions in Telegram Settings > Stars.\n` +
      `• *Bot Support:* Contact ${config.SUPPORT_USERNAME} with your Telegram ID for billing inquiries.\n` +
      `• *Refunds:* Eligible refunds are processed according to Telegram Stars policies.`
    );
  },

  paymentSuccess: (expiresAt: string) => {
    const dateStr = formatTorontoDate(expiresAt, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });

    return (
      `🎉 *PAYMENT CONFIRMED!*\n\n` +
      `Thank you! Your Underground VIP subscription is now *active* until *${dateStr}*.\n\n` +
      `You now have full access to:\n` +
      `• TOKEBEC VIP COLLECTIONS\n` +
      `• Underground General Chat\n` +
      `• Wanted List\n\n` +
      `Tap *Access My Channels* below to enter your spaces!`
    );
  },

  adminMenu: () => {
    return (
      `🛠️ *UNDERGROUND MANAGER — ADMINISTRATION*\n\n` +
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
