/**
 * Underground Manager — Start & Main Menu Handlers
 */

import { Composer } from "grammy";
import { isAdministrator } from "../../config.ts";
import { getMembershipSummary } from "../../db/entitlements.ts";
import { messages } from "../messages.ts";
import { mainMenuKeyboard, supportKeyboard } from "../keyboards.ts";

export const startComposer = new Composer();

startComposer.command("start", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const firstName = ctx.from?.first_name || "Member";
  const summary = await getMembershipSummary(userId);
  const isAdmin = isAdministrator(userId);

  await ctx.reply(messages.welcome(firstName, summary.isMember), {
    parse_mode: "Markdown",
    reply_markup: mainMenuKeyboard(summary.isMember, isAdmin),
  });
});

startComposer.callbackQuery("member:home", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const firstName = ctx.from?.first_name || "Member";
  const summary = await getMembershipSummary(userId);
  const isAdmin = isAdministrator(userId);

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(messages.welcome(firstName, summary.isMember), {
    parse_mode: "Markdown",
    reply_markup: mainMenuKeyboard(summary.isMember, isAdmin),
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
