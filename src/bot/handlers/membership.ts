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
  return new Date(iso).toLocaleDateString("fr-CA", { year: "numeric", month: "short", day: "numeric" });
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
    await ctx.reply(`⏳ La facturation du forfait ${plan.label} n'est pas encore disponible.`);
    return;
  }

  const payload = TelegramStarsProvider.buildInvoicePayload(userId, planId);

  try {
    const description =
      planId === "retro_plus"
        ? `Accès Retro Plus récurrent de 30 jours : tout ce qui est inclus dans Regular, plus RETRO | ${club}.`
        : `Accès récurrent de 30 jours à TOKEBEC VIP COLLECTIONS, au clavardage général de ${club} et à la Liste de souhaits.`;
    const link = await ctx.api.createInvoiceLink(
      `${club} ${plan.label}`,
      description,
      payload,
      "", // provider_token is empty string for Telegram Stars
      config.CURRENCY,
      [{ label: `${club} ${plan.label} (30 jours)`, amount: plan.priceStars }],
      { subscription_period: config.STARS_SUBSCRIPTION_PERIOD_SECONDS }
    );

    const kb = new InlineKeyboard()
      .url(`🌟 S'abonner (${plan.priceStars} Étoiles / 30 jours)`, link)
      .row()
      .text("⬅️ Menu principal", "member:home");

    await ctx.reply(
      `💎 *${club.toUpperCase()} ${plan.label.toUpperCase()}*

` +
      `Cliquez sur le bouton ci-dessous pour vous abonner avec les Étoiles Telegram.
` +
      `• *Prix :* ${plan.priceStars} Étoiles
` +
      `• *Durée :* 30 jours (renouvellement automatique)
` +
      `• *Annulation :* En tout temps dans Paramètres Telegram > Étoiles`,
      { parse_mode: "Markdown", reply_markup: kb }
    );
  } catch (err) {
    console.error("Failed to create Stars subscription link:", err);
    await ctx.reply(
      "⚠️ Impossible de générer le lien d'abonnement pour le moment. Veuillez réessayer plus tard ou communiquer avec le soutien."
    );
  }
}

// Legacy callback: the original single-plan button maps to Regular
membershipComposer.callbackQuery("member:pay_stars", async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Génération de l'abonnement par Étoiles Telegram..." });
  await sendPlanInvoice(ctx, "regular");
});

membershipComposer.callbackQuery("member:pay:regular", async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Génération de l'abonnement par Étoiles Telegram..." });
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
  await ctx.answerCallbackQuery({ text: "Génération de l'abonnement par Étoiles Telegram..." });
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
    ? `Votre accès Regular est déjà payé jusqu'au *${fmtDate(q.currentPaidThrough)}* et il est conservé.`
    : `Vous n'avez pas d'abonnement Regular payant en ce moment.`;
  await ctx.editMessageText(
    `⬆️ *PASSER À RETRO PLUS*\n\n` +
    `• *Nouveau prix :* ${q.newPriceStars} Étoiles / 30 jours (plein prix)\n` +
    `• *L'accès Retro commence :* dès que Telegram confirme votre paiement\n` +
    `• ${paidThrough}\n\n` +
    `⚠️ Les Étoiles Telegram ne permettent pas de calcul au prorata. Retro Plus est un *nouvel* abonnement facturé en entier aujourd'hui. ` +
    `Votre abonnement Regular actuel continue de se renouveler à moins que vous ne l'annuliez.\n\n` +
    `Choisissez comment traiter le renouvellement Regular. *Rien n'est annulé tant que votre paiement Retro Plus n'est pas vérifié.*`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text("✅ Passer à Retro Plus et annuler le renouvellement Regular", "member:upg_cfm:1")
        .row()
        .text("✅ Passer à Retro Plus, garder le renouvellement Regular", "member:upg_cfm:0")
        .row()
        .text("❌ Annuler", "member:plans"),
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
    await ctx.answerCallbackQuery({ text: q.error ?? "Mise à niveau indisponible.", show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery({ text: "Génération de l'abonnement Retro Plus..." });
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
    `⬇️ *REVENIR À REGULAR*\n\n` +
    `Si vous confirmez, votre abonnement Retro Plus *ne se renouvellera plus*.\n` +
    `• L'accès Retro que vous avez déjà payé continue jusqu'au *${fmtDate(q.retroPaidThrough)}*.\n` +
    `• Après cette date, l'accès Retro se termine automatiquement.\n` +
    (q.regularPaidThrough
      ? `• Votre accès Regular reste valide jusqu'au *${fmtDate(q.regularPaidThrough)}*.\n`
      : `• Pour garder l'accès Regular ensuite, abonnez-vous à Regular depuis les *Forfaits d'adhésion* une fois Retro Plus terminé.\n`) +
    `\nTelegram n'accorde ni remboursement ni calcul au prorata pour les jours Retro restants.`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text("✅ Confirmer : arrêter le renouvellement Retro Plus", "member:dng_cfm")
        .row()
        .text("❌ Garder Retro Plus", "member:plans"),
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
      `⚠️ Nous n'avons pas pu annuler le renouvellement automatiquement (${res.error ?? "erreur inconnue"}).\n` +
      `Vous pouvez l'annuler vous-même dans Paramètres Telegram > Étoiles. Votre accès est inchangé.`,
      { reply_markup: new InlineKeyboard().text("⬅️ Main Menu", "member:home") }
    );
    return;
  }
  await ctx.editMessageText(
    `✅ *Retro Plus ne se renouvellera pas.*\n\n` +
    `Vous gardez l'accès Retro jusqu'au *${fmtDate(res.retroPaidThrough)}*.`,
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
    kb.text("🔓 Accéder à mes canaux", "member:channels").row();
    if (summary.plan === "regular" && getPlan("retro_plus").enabled) {
      kb.text("⬆️ Passer à Retro Plus", "member:upgrade").row();
    }
    if (summary.activeEntitlements.some((e) => e.source === "telegram_stars" && e.plan === "retro_plus")) {
      kb.text("⬇️ Revenir à Regular", "member:downgrade").row();
    }
  } else {
    kb.text("💎 Forfaits d'adhésion", "member:plans").row();
  }
  kb.text("⬅️ Menu principal", "member:home");

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

  await ctx.answerCallbackQuery({ text: "Génération des liens d'accès sécurisés aux canaux..." });
  // Links are only generated for spaces the member's entitlements include.
  const spaceLinks = await buildLinks(ctx, summary.accessibleSpaces);

  if (spaceLinks.length === 0) {
    await ctx.reply(
      "⚠️ Les liens des canaux sont temporairement indisponibles. Veuillez en aviser un administrateur.",
      { reply_markup: new InlineKeyboard().text("⬅️ Menu principal", "member:home") }
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
      `🔒 *Clavardage général de ${getClubName()}* est réservé aux membres.\nConsultez les forfaits pour vous joindre :`,
      { parse_mode: "Markdown", reply_markup: plansKeyboard(summary.plan) }
    );
    return;
  }

  await ctx.answerCallbackQuery({ text: "Génération du lien sécurisé..." });
  const links = await buildLinks(ctx, ["general_chat"]);
  if (links.length === 0) {
    await ctx.reply("⚠️ Le lien du clavardage est temporairement indisponible. Veuillez en aviser un administrateur.");
    return;
  }
  await ctx.editMessageText(`💬 *Clavardage général de ${getClubName()}*\n\nAppuyez pour demander l'accès :`, {
    parse_mode: "Markdown",
    reply_markup: spacesKeyboard(links),
  });
});
