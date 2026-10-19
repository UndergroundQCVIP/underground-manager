/**
 * LA CONFRÉRIE — Member Self-Service, Plans & Spaces Handlers
 */

import { Composer, Context, InlineKeyboard } from "grammy";
import { getClubName, getConfig } from "../../config.ts";
import { getActivePaidEntitlements, getMembershipSummary } from "../../db/entitlements.ts";
import { TelegramStarsProvider } from "../../payments/stars.ts";
import { getOrCreateJoinLink } from "../../access/links.ts";
import { getChatId } from "../../access/spaces.ts";
import { messages } from "../messages.ts";
import { plansKeyboard, spacesKeyboard } from "../keyboards.ts";
import { MembershipPlanId, SpaceId } from "../../types.ts";
import { getPlan } from "../../plans/plans.ts";
import { confirmDowngrade, confirmUpgradeIntent, quoteDowngrade, quoteUpgrade } from "../../plans/changes.ts";

export const membershipComposer = new Composer();

function fmtDate(iso?: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

async function showPlans(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;
  const summary = await getMembershipSummary(userId);
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(messages.plansOverview(summary), {
    parse_mode: "Markdown",
    reply_markup: plansKeyboard(summary.plan),
  });
}

// Plans overview (legacy "member:join" kept so old inline buttons keep working)
membershipComposer.callbackQuery(["member:join", "member:plans"], showPlans);

/** Create a recurring 30-day Stars invoice link for a plan and present it. */
async function sendPlanInvoice(ctx: Context, planId: MembershipPlanId): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  const config = getConfig();
  const club = getClubName();
  const plan = getPlan(planId);

  if (!plan.enabled) {
    await ctx.reply(`⏳ ${plan.label} billing is not available yet.`);
    return;
  }

  const payload = TelegramStarsProvider.buildInvoicePayload(userId, planId);

  try {
    const description =
      planId === "retro_plus"
        ? `Recurring 30-day Retro Plus access: everything in Regular plus RETRO | ${club}.`
        : `Recurring 30-day access to TOKEBEC VIP COLLECTIONS, ${club} General Chat, and the Wanted List.`;
    const link = await ctx.api.createInvoiceLink(
      `${club} ${plan.label}`,
      description,
      payload,
      "", // provider_token is empty string for Telegram Stars
      config.CURRENCY,
      [{ label: `${club} ${plan.label} (30 Days)`, amount: plan.priceStars }],
      { subscription_period: config.STARS_SUBSCRIPTION_PERIOD_SECONDS }
    );

    const kb = new InlineKeyboard()
      .url(`🌟 Subscribe (${plan.priceStars} Stars / 30 Days)`, link)
      .row()
      .text("⬅️ Main Menu", "member:home");

    await ctx.reply(
      `💎 *${club.toUpperCase()} ${plan.label.toUpperCase()}*\n\n` +
      `Click the button below to subscribe using Telegram Stars.\n` +
      `• *Price:* ${plan.priceStars} Stars\n` +
      `• *Duration:* 30 Days (auto-renewing)\n` +
      `• *Cancel:* Anytime in Telegram Settings > Stars`,
      { parse_mode: "Markdown", reply_markup: kb }
    );
  } catch (err) {
    console.error("Failed to create Stars subscription link:", err);
    await ctx.reply(
      "⚠️ Could not generate subscription link at this moment. Please try again later or contact support."
    );
  }
}

// Legacy callback: the original single-plan button maps to Regular
membershipComposer.callbackQuery("member:pay_stars", async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Generating Telegram Stars subscription..." });
  await sendPlanInvoice(ctx, "regular");
});

membershipComposer.callbackQuery("member:pay:regular", async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Generating Telegram Stars subscription..." });
  await sendPlanInvoice(ctx, "regular");
});

membershipComposer.callbackQuery("member:pay:retro_plus", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  // A current Regular subscriber must go through the confirmed upgrade flow
  // so overlapping recurring charges are explained and consented to.
  const regular = await getActivePaidEntitlements(userId, "regular");
  if (regular.length > 0) {
    await showUpgradeQuote(ctx);
    return;
  }
  await ctx.answerCallbackQuery({ text: "Generating Telegram Stars subscription..." });
  await sendPlanInvoice(ctx, "retro_plus");
});

// ---- Upgrade: Regular → Retro Plus --------------------------------------------

async function showUpgradeQuote(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;
  const q = await quoteUpgrade(userId);
  await ctx.answerCallbackQuery();
  if (!q.ok) {
    await ctx.editMessageText(`ℹ️ ${q.error}`, {
      reply_markup: new InlineKeyboard().text("⬅️ Main Menu", "member:home"),
    });
    return;
  }
  const paidThrough = q.currentPaidThrough
    ? `Your Regular access is already paid through *${fmtDate(q.currentPaidThrough)}* and is preserved.`
    : `You do not have a paid Regular subscription right now.`;
  await ctx.editMessageText(
    `⬆️ *UPGRADE TO RETRO PLUS*\n\n` +
    `• *New price:* ${q.newPriceStars} Stars / 30 days (full price)\n` +
    `• *Retro access starts:* immediately once Telegram confirms your payment\n` +
    `• ${paidThrough}\n\n` +
    `⚠️ Telegram Stars cannot prorate a plan change. Retro Plus is a *new* subscription charged in full today. ` +
    `Your existing Regular subscription keeps renewing unless you cancel it.\n\n` +
    `Choose how to handle the Regular renewal. *Nothing is cancelled until your Retro Plus payment is verified.*`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text("✅ Upgrade & cancel Regular renewal", "member:upg_cfm:1")
        .row()
        .text("✅ Upgrade, keep Regular renewing", "member:upg_cfm:0")
        .row()
        .text("❌ Cancel", "member:plans"),
    }
  );
}

membershipComposer.callbackQuery("member:upgrade", showUpgradeQuote);

membershipComposer.callbackQuery(/^member:upg_cfm:([01])$/, async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  const cancelRegular = ctx.match[1] === "1";
  const q = await confirmUpgradeIntent(userId, cancelRegular);
  if (!q.ok) {
    await ctx.answerCallbackQuery({ text: q.error ?? "Upgrade unavailable.", show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery({ text: "Generating Retro Plus subscription..." });
  await sendPlanInvoice(ctx, "retro_plus");
});

// ---- Downgrade: Retro Plus → Regular ------------------------------------------

membershipComposer.callbackQuery("member:downgrade", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  const q = await quoteDowngrade(userId);
  await ctx.answerCallbackQuery();
  if (!q.ok) {
    await ctx.editMessageText(`ℹ️ ${q.error}`, {
      reply_markup: new InlineKeyboard().text("⬅️ Main Menu", "member:home"),
    });
    return;
  }
  await ctx.editMessageText(
    `⬇️ *SWITCH TO REGULAR*\n\n` +
    `If you confirm, your Retro Plus subscription will *stop renewing*.\n` +
    `• Retro access you already paid for continues until *${fmtDate(q.retroPaidThrough)}*.\n` +
    `• After that date Retro access ends automatically.\n` +
    (q.regularPaidThrough
      ? `• Your Regular access remains valid through *${fmtDate(q.regularPaidThrough)}*.\n`
      : `• To keep Regular access afterwards, subscribe to Regular from *Membership Plans* once Retro Plus ends.\n`) +
    `\nNo refund or proration is issued by Telegram for the remaining Retro days.`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text("✅ Confirm: stop Retro Plus renewal", "member:dng_cfm")
        .row()
        .text("❌ Keep Retro Plus", "member:plans"),
    }
  );
});

membershipComposer.callbackQuery("member:dng_cfm", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  const res = await confirmDowngrade(ctx.api, userId);
  await ctx.answerCallbackQuery();
  if (!res.ok || !res.cancelled) {
    await ctx.editMessageText(
      `⚠️ We could not cancel the renewal automatically (${res.error ?? "unknown error"}).\n` +
      `You can cancel it yourself in Telegram Settings > Stars. Your access is unchanged.`,
      { reply_markup: new InlineKeyboard().text("⬅️ Main Menu", "member:home") }
    );
    return;
  }
  await ctx.editMessageText(
    `✅ *Retro Plus will not renew.*\n\n` +
    `You keep Retro access until *${fmtDate(res.retroPaidThrough)}*.`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard().text("⬅️ Main Menu", "member:home"),
    }
  );
});

// ---- Status & channels --------------------------------------------------------

membershipComposer.callbackQuery("member:status", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const summary = await getMembershipSummary(userId);
  const kb = new InlineKeyboard();

  if (summary.isMember) {
    kb.text("🔓 Access My Channels", "member:channels").row();
    if (summary.plan === "regular" && getPlan("retro_plus").enabled) {
      kb.text("⬆️ Upgrade to Retro Plus", "member:upgrade").row();
    }
    if (summary.activeEntitlements.some((e) => e.source === "telegram_stars" && e.plan === "retro_plus")) {
      kb.text("⬇️ Switch to Regular", "member:downgrade").row();
    }
  } else {
    kb.text(`💎 Membership Plans`, "member:plans").row();
  }
  kb.text("⬅️ Main Menu", "member:home");

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(messages.membershipStatus(summary), {
    parse_mode: "Markdown",
    reply_markup: kb,
  });
});

async function buildLinks(ctx: Context, spaces: SpaceId[]) {
  const out: { spaceId: SpaceId; url: string }[] = [];
  for (const spaceId of spaces) {
    // A space whose chat is not configured cannot have a link.
    if (!getChatId(spaceId)) continue;
    try {
      out.push({ spaceId, url: await getOrCreateJoinLink(ctx.api, spaceId) });
    } catch (err) {
      console.error(`Failed to generate join link for space ${spaceId}:`, err);
    }
  }
  return out;
}

// Access My Channels (Generates/retrieves secure join-request links)
membershipComposer.callbackQuery("member:channels", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const summary = await getMembershipSummary(userId);

  if (!summary.isMember || summary.accessibleSpaces.length === 0) {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(messages.accessChannels([]), {
      parse_mode: "Markdown",
      reply_markup: plansKeyboard("none"),
    });
    return;
  }

  await ctx.answerCallbackQuery({ text: "Generating secure channel access links..." });
  // Links are only generated for spaces the member's entitlements include.
  const spaceLinks = await buildLinks(ctx, summary.accessibleSpaces);

  if (spaceLinks.length === 0) {
    await ctx.reply(
      "⚠️ Channel links are temporarily unavailable. Please alert an administrator.",
      { reply_markup: new InlineKeyboard().text("⬅️ Main Menu", "member:home") }
    );
    return;
  }

  await ctx.editMessageText(messages.accessChannels(summary.accessibleSpaces), {
    parse_mode: "Markdown",
    reply_markup: spacesKeyboard(spaceLinks),
  });
});

// General Chat shortcut
membershipComposer.callbackQuery("member:general_chat", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  const summary = await getMembershipSummary(userId);

  if (!summary.accessibleSpaces.includes("general_chat")) {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `🔒 *${getClubName()} General Chat* is for members.\nSee the plans to join:`,
      { parse_mode: "Markdown", reply_markup: plansKeyboard(summary.plan) }
    );
    return;
  }

  await ctx.answerCallbackQuery({ text: "Generating secure link..." });
  const links = await buildLinks(ctx, ["general_chat"]);
  if (links.length === 0) {
    await ctx.reply("⚠️ Chat link is temporarily unavailable. Please alert an administrator.");
    return;
  }
  await ctx.editMessageText(`💬 *${getClubName()} General Chat*\n\nTap to request entry:`, {
    parse_mode: "Markdown",
    reply_markup: spacesKeyboard(links),
  });
});
