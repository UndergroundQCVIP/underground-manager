/**
 * Underground Manager — Member Self-Service & Spaces Handlers
 */

import { Composer, InlineKeyboard } from "grammy";
import { getConfig } from "../../config.ts";
import { getMembershipSummary } from "../../db/entitlements.ts";
import { TelegramStarsProvider } from "../../payments/stars.ts";
import { getOrCreateJoinLink } from "../../access/links.ts";
import { messages } from "../messages.ts";
import { spacesKeyboard, subscribeKeyboard } from "../keyboards.ts";
import { SpaceId } from "../../types.ts";

export const membershipComposer = new Composer();

// View subscription explanation
membershipComposer.callbackQuery("member:join", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(messages.nonMemberInfo(), {
    parse_mode: "Markdown",
    reply_markup: subscribeKeyboard(),
  });
});

// Pay with Stars: Sends native recurring Stars invoice
membershipComposer.callbackQuery("member:pay_stars", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const config = getConfig();
  const payload = TelegramStarsProvider.buildInvoicePayload(userId);

  await ctx.answerCallbackQuery({ text: "Génération de l'abonnement par Étoiles Telegram..." });

  try {
    const link = await ctx.api.createInvoiceLink(
      "Abonnement Underground VIP",
      `Accès VIP récurrent de 30 jours à TOKEBEC VIP COLLECTIONS, au clavardage général et à la Liste de souhaits.`,
      payload,
      "", // provider_token is empty string for Telegram Stars
      config.CURRENCY,
      [{ label: "Underground VIP (30 jours)", amount: config.STARS_PRICE_AMOUNT }],
      {
        subscription_period: config.STARS_SUBSCRIPTION_PERIOD_SECONDS,
      }
    );

    const kb = new InlineKeyboard()
      .url(`🌟 S'abonner (${config.STARS_PRICE_AMOUNT} Étoiles / 30 jours)`, link)
      .row()
      .text("⬅️ Menu principal", "member:home");

    await ctx.reply(
      `💎 *ABONNEMENT UNDERGROUND VIP*\n\n` +
      `Cliquez sur le bouton ci-dessous pour vous abonner avec les Étoiles Telegram.\n` +
      `• *Prix :* ${config.STARS_PRICE_AMOUNT} Étoiles\n` +
      `• *Durée :* 30 jours (renouvellement automatique)\n` +
      `• *Annulation :* En tout temps dans Paramètres Telegram > Étoiles`,
      {
        parse_mode: "Markdown",
        reply_markup: kb,
      }
    );
  } catch (err) {
    console.error("Failed to create Stars subscription link:", err);
    await ctx.reply(
      "⚠️ Impossible de générer le lien d'abonnement pour le moment. Veuillez réessayer plus tard ou communiquer avec le soutien."
    );
  }
});

// View Membership Status
membershipComposer.callbackQuery("member:status", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const summary = await getMembershipSummary(userId);
  const kb = new InlineKeyboard();

  if (summary.isMember) {
    kb.text("🔓 Accéder à mes canaux", "member:channels").row();
  } else {
    kb.text("🌟 Joindre Underground", "member:join").row();
  }
  kb.text("⬅️ Menu principal", "member:home");

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(messages.membershipStatus(summary), {
    parse_mode: "Markdown",
    reply_markup: kb,
  });
});

// Access My Channels (Generates/retrieves secure join-request links)
membershipComposer.callbackQuery("member:channels", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const summary = await getMembershipSummary(userId);

  if (!summary.isMember || summary.accessibleSpaces.length === 0) {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(messages.accessChannels([]), {
      parse_mode: "Markdown",
      reply_markup: subscribeKeyboard(),
    });
    return;
  }

  await ctx.answerCallbackQuery({ text: "Génération des liens d'accès sécurisés aux canaux..." });

  const spaceLinks: { spaceId: SpaceId; url: string }[] = [];

  for (const spaceId of summary.accessibleSpaces) {
    try {
      const link = await getOrCreateJoinLink(ctx.api, spaceId);
      spaceLinks.push({ spaceId, url: link });
    } catch (err) {
      console.error(`Failed to generate join link for space ${spaceId}:`, err);
    }
  }

  if (spaceLinks.length === 0) {
    await ctx.reply(
      "⚠️ Les liens des canaux sont temporairement indisponibles. Veuillez en aviser un administrateur.",
      {
        reply_markup: new InlineKeyboard().text("⬅️ Menu principal", "member:home"),
      }
    );
    return;
  }

  await ctx.editMessageText(messages.accessChannels(summary.accessibleSpaces), {
    parse_mode: "Markdown",
    reply_markup: spacesKeyboard(spaceLinks),
  });
});
