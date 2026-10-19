/**
 * LA CONFRÉRIE — Start & Main Menu Handlers
 */

import { Composer } from "grammy";
import { escapeMd } from "../../util/markdown.ts";
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
      await ctx.reply("⚠️ Collection de créateur introuvable ou déplacée.", {
        reply_markup: new InlineKeyboard().text("⬅️ Menu principal", "member:home"),
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
        .url(`👉 Ouvrir le sujet de ${creator.name}`, topicUrl)
        .row()
        .text("⬅️ Menu principal", "member:home");

      await ctx.reply(
        `💎 *${escapeMd(creator.name)}* est disponible dans *${forumName}* !

` +
        `📅 *Dernière mise à jour du contenu :* ${updatedStr}

` +
        `En tant que membre actif, vous pouvez accéder directement au sujet de ce créateur :`,
        {
          parse_mode: "Markdown",
          reply_markup: kb,
        }
      );
    } else {
      const retroLocked = collection === "retro" && summary.isMember;
      const kb = new InlineKeyboard();
      if (retroLocked && getPlan("retro_plus").enabled) {
        kb.text("⬆️ Passer à Retro Plus", "member:upgrade").row();
      } else {
        kb.text("💎 Forfaits d'adhésion", "member:plans").row();
      }
      kb.text("⬅️ Menu principal", "member:home");

      await ctx.reply(
        `💎 *${escapeMd(creator.name)}* fait partie de *${forumName}*.

` +
        `📅 *Dernière mise à jour du contenu :* ${updatedStr}

` +
        (collection === "retro"
          ? `🔒 Cette collection est réservée aux membres *${club} Retro Plus*.`
          : `🔒 Cette collection est réservée aux membres ${club}.
Abonnez-vous avec les Étoiles Telegram pour débloquer l'accès immédiat aux archives de créateurs !`),
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
      `🎯 *${getClubName()} | LISTE DE SOUHAITS*

` +
      `Dites-nous quels créateurs nous devrions acquérir ensuite !

` +
      `• *Suggérer :* Soumettre de nouvelles demandes de créateurs
` +
      `• *Appuyer :* Voter pour les suggestions existantes de la communauté
` +
      `• *Règles :* 1 suggestion ou appui par membre payant par cycle mensuel

` +
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

  await ctx.reply(messages.welcome(firstName, summary.isMember, summary.plan), {
    parse_mode: "Markdown",
    reply_markup: mainMenuKeyboard(summary.isMember, isAdmin, summary.plan),
  });
});

startComposer.callbackQuery("member:home", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const firstName = ctx.from?.first_name || "Membre";
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

// Diagnostic: shows the numeric ID the bot sees, whether it is in ADMIN_USER_IDS and
// the membership the database holds for it. Private chats only; reveals nothing sensitive.
startComposer.command("whoami", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId || ctx.chat?.type !== "private") return;

  const summary = await getMembershipSummary(userId);
  const lines = [
    `Votre identifiant Telegram : ${userId}`,
    `Administrateur : ${isAdministrator(userId) ? "oui" : "non (cet identifiant n'est pas dans ADMIN_USER_IDS)"}`,
    `Membre actif : ${summary.isMember ? "oui" : "non"}`,
    `Type : ${summary.primaryType}`,
    `Espaces accessibles : ${summary.accessibleSpaces.join(", ") || "aucun"}`,
    `Expiration : ${summary.effectiveExpiry ?? "—"}`,
  ];
  await ctx.reply(lines.join("\n"));
});
