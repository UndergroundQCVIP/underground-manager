/**
 * LA CONFRÉRIE — Start & Main Menu Handlers
 */

import { Composer } from "grammy";
import { getClubName, isAdministrator } from "../../config.ts";
import { creatorCollection } from "../../db/creators.ts";
import { getPlan } from "../../plans/plans.ts";
import { getMembershipSummary } from "../../db/entitlements.ts";
import { messages } from "../messages.ts";
import { mainMenuKeyboard, supportKeyboard } from "../keyboards.ts";

import { getCreator } from "../../db/creators.ts";
import { formatCreatorDate } from "../../directory/sync.ts";
import { InlineKeyboard } from "grammy";

export const startComposer = new Composer();

startComposer.command("start", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const match = ctx.match?.trim();
  const summary = await getMembershipSummary(userId);

  // 1. Deep Link: Creator details / directory entry
  if (match && match.startsWith("creator_")) {
    const creatorId = match.replace("creator_", "");
    const creator = await getCreator(creatorId);

    if (!creator) {
      await ctx.reply("⚠️ Creator collection not found or was moved.", {
        reply_markup: new InlineKeyboard().text("⬅️ Main Menu", "member:home"),
      });
      return;
    }

    const updatedStr = formatCreatorDate(creator.lastContentUpdatedAt);
    const collection = creatorCollection(creator);
    const club = getClubName();
    const forumName = collection === "retro" ? `RETRO | ${club}` : "TOKEBEC VIP COLLECTIONS";
    const requiredSpace = collection === "retro" ? "retro_collections" : "vip_collections";

    // The protected topic link is ONLY ever handed to members whose active
    // entitlements include the creator's vault (Retro needs Retro Plus).
    if (summary.isMember && summary.accessibleSpaces.includes(requiredSpace)) {
      const cleanChatId = String(creator.chatId).replace(/^-100/, "");
      const topicUrl = `https://t.me/c/${cleanChatId}/${creator.topicId}`;

      const kb = new InlineKeyboard()
        .url(`👉 Open ${creator.name} Topic`, topicUrl)
        .row()
        .text("⬅️ Main Menu", "member:home");

      await ctx.reply(
        `💎 *${creator.name}* is available in *${forumName}*!\n\n` +
        `📅 *Last Content Update:* ${updatedStr}\n\n` +
        `As an active member, you can jump directly to this creator's topic:`,
        {
          parse_mode: "Markdown",
          reply_markup: kb,
        }
      );
    } else {
      const retroLocked = collection === "retro" && summary.isMember;
      const kb = new InlineKeyboard();
      if (retroLocked && getPlan("retro_plus").enabled) {
        kb.text("⬆️ Upgrade to Retro Plus", "member:upgrade").row();
      } else {
        kb.text("💎 Membership Plans", "member:plans").row();
      }
      kb.text("⬅️ Main Menu", "member:home");

      await ctx.reply(
        `💎 *${creator.name}* is part of *${forumName}*.\n\n` +
        `📅 *Last Content Update:* ${updatedStr}\n\n` +
        (collection === "retro"
          ? `🔒 This collection is exclusive to *${club} Retro Plus* members.`
          : `🔒 This collection is exclusive to ${club} members.\nSubscribe with Telegram Stars to unlock instant access to the creator archives!`),
        {
          parse_mode: "Markdown",
          reply_markup: kb,
        }
      );
    }
    return;
  }

  // 2. Deep Link: Wanted List
  if (match === "wanted") {
    const { wantedMenuKeyboard } = await import("./wanted.ts");
    const { getActiveBallot } = await import("../../db/voting.ts");
    const activeBallot = await getActiveBallot();

    await ctx.reply(
      `🎯 *${getClubName()} | WANTED LIST*\n\n` +
      `Tell us which creators we should acquire next!\n\n` +
      `• *Suggest:* Submit new creator requests\n` +
      `• *Support:* Vote on existing community nominations\n` +
      `• *Rules:* 1 suggestion/support per paying member per monthly cycle\n\n` +
      `Select an option below:`,
      {
        parse_mode: "Markdown",
        reply_markup: wantedMenuKeyboard(activeBallot !== null),
      }
    );
    return;
  }

  // 3. Deep Link: Acquisition Voting
  if (match === "vote") {
    const { handleOpenVote } = await import("./voting.ts");
    await handleOpenVote(ctx);
    return;
  }

  const firstName = ctx.from?.first_name || "Member";
  const isAdmin = isAdministrator(userId);

  await ctx.reply(messages.welcome(firstName, summary.isMember, summary.plan), {
    parse_mode: "Markdown",
    reply_markup: mainMenuKeyboard(summary.isMember, isAdmin, summary.plan),
  });
});

startComposer.callbackQuery("member:home", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const firstName = ctx.from?.first_name || "Member";
  const summary = await getMembershipSummary(userId);
  const isAdmin = isAdministrator(userId);

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(messages.welcome(firstName, summary.isMember, summary.plan), {
    parse_mode: "Markdown",
    reply_markup: mainMenuKeyboard(summary.isMember, isAdmin, summary.plan),
  });
});

startComposer.command("help", async (ctx) => {
  await ctx.reply(messages.paySupport(), {
    parse_mode: "Markdown",
    reply_markup: supportKeyboard(),
  });
});

startComposer.command("paysupport", async (ctx) => {
  await ctx.reply(messages.paySupport(), {
    parse_mode: "Markdown",
    reply_markup: supportKeyboard(),
  });
});

startComposer.callbackQuery("member:support", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(messages.paySupport(), {
    parse_mode: "Markdown",
    reply_markup: supportKeyboard(),
  });
});
