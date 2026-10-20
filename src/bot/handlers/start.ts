/**
 * LA CONFRÉRIE — Start & Main Menu Handlers
 */

import { Composer } from "grammy";
import { escapeMd } from "../../util/markdown.ts";
import { getClubName, isAdministrator } from "../../config.ts";
import { creatorCollection } from "../../db/creators.ts";
import { getPlan } from "../../plans/plans.ts";
import { getMembershipSummary } from "../../db/entitlements.ts";
import { getMembershipMode } from "../../membership/mode.ts";
import { renderNavPage } from "../public_pages.ts";
import { attributeReferral } from "../../referrals/service.ts";
import { isNewToBot } from "../middleware/auth.ts";
import { NAV_PAGES, NavPage } from "../../navigation/service.ts";
import { messages } from "../messages.ts";
import { mainMenuKeyboard, supportKeyboard } from "../keyboards.ts";

import { getCreator } from "../../db/creators.ts";
import { formatCreatorDate } from "../../directory/sync.ts";
import { InlineKeyboard } from "grammy";

export const startComposer = new Composer();

startComposer.command("start", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  let match: string | undefined = ctx.match?.trim();

  // Referral link (t.me/<bot>?start=ref_<code>): record the referrer on the very first contact only,
  // then continue with the normal welcome.
  if (match?.startsWith("ref_")) {
    await attributeReferral({ payload: match, refereeId: userId, isNewToBot: isNewToBot(ctx) }).catch((err) =>
      console.error("[Referrals] attribution failed:", err)
    );
    match = undefined;
  }
  const summary = await getMembershipSummary(userId);
  const mode = await getMembershipMode();

  // 0. Public navigation deep links (welcome menu / lobby / directory buttons)
  if (match && (NAV_PAGES as readonly string[]).includes(match)) {
    if (match === "leaderboard") {
      const { renderLeaderboard } = await import("../leaderboard_view.ts");
      const view = await renderLeaderboard(userId, "month");
      await ctx.reply(view.text, { parse_mode: "Markdown", reply_markup: view.kb, link_preview_options: { is_disabled: true } });
      return;
    }
    if (match === "contribute") {
      const { contributeChooser } = await import("./contribute.ts");
      await contributeChooser(ctx);
      return;
    }
    const page = await renderNavPage(match as NavPage, ctx.api, summary, mode);
    await ctx.reply(page.text, { parse_mode: "Markdown", reply_markup: page.kb, link_preview_options: { is_disabled: true } });
    return;
  }

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
      if (retroLocked && getPlan("retro_plus").enabled && mode !== "contribution_only") {
        kb.text("⬆️ Passer à Retro Plus", "member:upgrade").row();
      } else {
        kb.text("💎 Comment obtenir l'accès", "member:plans").row();
      }
      // A direct route to contribute content for this very creator.
      if (mode !== "stars_only") kb.text(`➕ Contribuer pour ${creator.name}`.slice(0, 60), `contrib:pick:${creator.id}`).row();
      kb.text("⬅️ Menu principal", "member:home");

      await ctx.reply(
        `💎 *${escapeMd(creator.name)}* fait partie de *${forumName}*.

` +
        `📅 *Dernière mise à jour du contenu :* ${updatedStr}

` +
        (collection === "retro"
          ? `🔒 Cette collection est réservée aux membres ayant l'accès *Retro* (Retro Plus ou accès Retro gagné par contribution).\n`
          : `🔒 Cette collection est réservée aux membres ${club}.\n`) +
        (mode === "contribution_only"
          ? "Vous pouvez gagner l'accès en contribuant du contenu approuvé."
          : mode === "stars_only"
          ? "Abonnez-vous avec les Étoiles Telegram pour débloquer l'accès."
          : "Abonnez-vous avec les Étoiles Telegram ou contribuez pour gagner l'accès."),
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
      `• *Règles :* 1 suggestion ou appui par membre actif par cycle mensuel

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

  await ctx.reply(messages.welcome(firstName, summary.isMember, summary.hasPaid ? summary.plan : "none", mode), {
    parse_mode: "Markdown",
    reply_markup: mainMenuKeyboard(summary.isMember, isAdmin, summary.hasPaid ? summary.plan : "none", mode),
  });
});

startComposer.callbackQuery("member:home", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const firstName = ctx.from?.first_name || "Membre";
  const summary = await getMembershipSummary(userId);
  const mode = await getMembershipMode();
  const isAdmin = isAdministrator(userId);

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(messages.welcome(firstName, summary.isMember, summary.hasPaid ? summary.plan : "none", mode), {
    parse_mode: "Markdown",
    reply_markup: mainMenuKeyboard(summary.isMember, isAdmin, summary.hasPaid ? summary.plan : "none", mode),
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

// In-bot navigation buttons (nav:<page>) mirror the public deep links.
startComposer.callbackQuery(/^nav:([a-z]+)$/, async (ctx) => {
  const page = ctx.match[1] as NavPage;
  if (!(NAV_PAGES as readonly string[]).includes(page)) return;
  const userId = ctx.from?.id;
  if (!userId) return;
  const summary = await getMembershipSummary(userId);
  const mode = await getMembershipMode();
  await ctx.answerCallbackQuery();
  const res = await renderNavPage(page, ctx.api, summary, mode);
  await ctx.editMessageText(res.text, { parse_mode: "Markdown", reply_markup: res.kb, link_preview_options: { is_disabled: true } });
});
