/**
 * Underground Manager — Start & Main Menu Handlers
 */

import { Composer } from "grammy";
import { escapeMd } from "../../util/markdown.ts";
import { isAdministrator } from "../../config.ts";
import { getMembershipSummary } from "../../db/entitlements.ts";
import { messages } from "../messages.ts";
import { mainMenuKeyboard, supportKeyboard } from "../keyboards.ts";

import { getCreator } from "../../db/creators.ts";
import { formatCreatorDate } from "../../directory/sync.ts";
import { InlineKeyboard } from "grammy";
import { getConfig } from "../../config.ts";

export const startComposer = new Composer();

startComposer.command("start", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const match = ctx.match?.trim();
  const summary = await getMembershipSummary(userId);
  const config = getConfig();

  // 1. Deep Link: Creator details / directory entry
  if (match && match.startsWith("creator_")) {
    const creatorId = match.replace("creator_", "");
    const creator = await getCreator(creatorId);

    if (!creator) {
      await ctx.reply("⚠️ Collection de créateur introuvable ou déplacée.", {
        reply_markup: new InlineKeyboard().text("⬅️ Menu principal", "member:home"),
      });
      return;
    }

    const updatedStr = formatCreatorDate(creator.lastContentUpdatedAt);

    if (summary.isMember && summary.accessibleSpaces.includes("vip_collections")) {
      const cleanChatId = String(creator.chatId).replace(/^-100/, "");
      const topicUrl = `https://t.me/c/${cleanChatId}/${creator.topicId}`;

      const kb = new InlineKeyboard()
        .url(`👉 Ouvrir le sujet de ${creator.name}`, topicUrl)
        .row()
        .text("⬅️ Menu principal", "member:home");

      await ctx.reply(
        `💎 *${escapeMd(creator.name)}* est disponible dans *TOKEBEC VIP COLLECTIONS* !\n\n` +
        `📅 *Dernière mise à jour du contenu :* ${updatedStr}\n\n` +
        `En tant que membre VIP actif, vous pouvez accéder directement au sujet de ce créateur :`,
        {
          parse_mode: "Markdown",
          reply_markup: kb,
        }
      );
    } else {
      const kb = new InlineKeyboard()
        .text(`🌟 Joindre Underground (${config.STARS_PRICE_AMOUNT} Étoiles)`, "member:join")
        .row()
        .text("⬅️ Menu principal", "member:home");

      await ctx.reply(
        `💎 *${escapeMd(creator.name)}* est disponible dans *TOKEBEC VIP COLLECTIONS* !\n\n` +
        `📅 *Dernière mise à jour du contenu :* ${updatedStr}\n\n` +
        `🔒 Cette collection est réservée aux membres Underground VIP.\n` +
        `Abonnez-vous avec les Étoiles Telegram pour débloquer l'accès immédiat à toutes les archives de créateurs !`,
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
      `🎯 *UNDERGROUND | LISTE DE SOUHAITS*\n\n` +
      `Dites-nous quels créateurs nous devrions acquérir ensuite !\n\n` +
      `• *Suggérer :* Soumettre de nouvelles demandes de créateurs\n` +
      `• *Appuyer :* Voter pour les suggestions existantes de la communauté\n` +
      `• *Règles :* 1 suggestion ou appui par membre payant par cycle mensuel\n\n` +
      `Choisissez une option ci-dessous :`,
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

  const firstName = ctx.from?.first_name || "Membre";
  const isAdmin = isAdministrator(userId);

  await ctx.reply(messages.welcome(firstName, summary.isMember), {
    parse_mode: "Markdown",
    reply_markup: mainMenuKeyboard(summary.isMember, isAdmin),
  });
});

startComposer.callbackQuery("member:home", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const firstName = ctx.from?.first_name || "Membre";
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
