/**
 * LA CONFRÉRIE — Message Templates & Strings
 * Organized cleanly to facilitate localization (Quebec French strings).
 * Every club-facing name comes from CLUB_DISPLAY_NAME (see config.ts).
 */

import { getClubName, getConfig } from "../config.ts";
import { formatTorontoDate } from "../util/time.ts";
import { MembershipPlanId, MembershipSummary, SpaceId } from "../types.ts";
import { getSpaceTitle } from "../access/spaces.ts";
import { getPlan } from "../plans/plans.ts";

function planLine(planId: MembershipPlanId): string {
  const plan = getPlan(planId);
  const price = plan.enabled ? `${plan.priceStars} Étoiles / 30 jours` : "Bientôt disponible";
  return `*${plan.label}* — ${price}`;
}

export const messages = {
  welcome: (firstName: string, isMember: boolean, plan: MembershipPlanId | "none" = "none") => {
    const club = getClubName();
    if (isMember) {
      const planName = plan === "retro_plus" ? "Retro Plus" : plan === "regular" ? "Regular" : "";
      return (
        `👋 *Bon retour, ${escapeMarkdown(firstName)} !*\n\n` +
        `Vous avez un abonnement *${club}*${planName ? ` *${planName}*` : ""} actif.\n` +
        `Gérez votre abonnement ou accédez à vos espaces privés ci-dessous.`
      );
    }
    return (
      `👋 *Bienvenue sur ${club}, ${escapeMarkdown(firstName)}.*\n\n` +
      `${club} est une communauté privée exclusive offrant des archives de créateurs triées sur le volet, des collections privées et des discussions entre membres.\n\n` +
      `🌟 ${planLine("regular")}\n` +
      `🎞️ ${planLine("retro_plus")}\n` +
      `Abonnements récurrents facturés par les Étoiles Telegram officielles.\n\n` +
      `Choisissez une option ci-dessous pour vous joindre ou gérer votre compte :`
    );
  },

  plansOverview: (summary?: MembershipSummary) => {
    const club = getClubName();
    const retro = getPlan("retro_plus");
    let text =
      `💎 *${club} — FORFAITS D'ADHÉSION*\n\n` +
      `*Regular* — ${getPlan("regular").priceStars} Étoiles / 30 jours\n` +
      `• TOKEBEC VIP COLLECTIONS (voûte Regular)\n` +
      `• Liste de souhaits privée\n` +
      `• Clavardage général de ${club}\n` +
      `• Suggestions de créateurs et votes\n\n` +
      `*Retro Plus* — ${retro.enabled ? `${retro.priceStars} Étoiles / 30 jours` : "Bientôt disponible"}\n` +
      `• Tout ce qui est inclus dans Regular\n` +
      `• RETRO | ${club} (voûte Retro)\n\n` +
      `Les deux forfaits donnent exactement les mêmes droits de vote. Retro Plus ajoute seulement l'accès à la collection Retro.\n` +
      `🔄 Abonnements récurrents de 30 jours par Étoiles Telegram — annulables en tout temps dans Paramètres Telegram > Étoiles.`;
    if (summary?.plan === "regular" && retro.enabled) {
      text += `\n\n⬆️ Vous pouvez passer à Retro Plus ci-dessous.`;
    }
    return text;
  },

  nonMemberInfo: () => messages.plansOverview(),

  membershipStatus: (summary: MembershipSummary) => {
    if (!summary.isMember) {
      const retro = getPlan("retro_plus");
      return (
        `📋 *MON ABONNEMENT*\n\n` +
        `*Statut :* ⚪ Inactif / Aucun abonnement\n` +
        `*Regular :* ${getPlan("regular").priceStars} Étoiles tous les 30 jours\n` +
        `*Retro Plus :* ${retro.enabled ? `${retro.priceStars} Étoiles tous les 30 jours` : "Bientôt disponible"}\n\n` +
        `Vous n'avez actuellement aucun abonnement actif. Appuyez ci-dessous pour voir les forfaits.`
      );
    }

    const typeStr = summary.hasPaid ? "🌟 Payant (Étoiles Telegram)" : "🎁 Gracieux";
    const planStr = summary.plan === "retro_plus" ? "🎞️ Retro Plus" : "Regular";

    const fmtOpts = { year: "numeric", month: "short", day: "numeric" } as const;
    const expiryStr = summary.effectiveExpiry
      ? formatTorontoDate(summary.effectiveExpiry, { ...fmtOpts, hour: "2-digit", minute: "2-digit" })
      : "Indéterminée";

    const spacesList = summary.accessibleSpaces
      .map((s) => `  ✓ ${getSpaceTitle(s)}`)
      .join("\n");

    const renewalStr = summary.isRecurring
      ? "Renouvellement automatique tous les 30 jours par Étoiles Telegram"
      : "Non renouvelable (accès gracieux)";

    // Per-entitlement paid-through dates keep plan changes transparent.
    const lines = summary.activeEntitlements
      .filter((e) => e.source === "telegram_stars")
      .map((e) => `  • ${getPlan(e.plan ?? "regular").label} : payé jusqu'au ${formatTorontoDate(e.expiresAt, fmtOpts)}`)
      .join("\n");

    return (
      `📋 *MON ABONNEMENT*\n\n` +
      `*Forfait :* ${planStr}\n` +
      `*Type :* ${typeStr}\n` +
      `*Statut :* 🟢 Actif\n` +
      `*Valide jusqu'au :* ${expiryStr}\n` +
      `*Renouvellement :* ${renewalStr}\n` +
      (lines ? `${lines}\n` : "") +
      `\n*Espaces accessibles :*\n${spacesList}\n\n` +
      `_Gérez vos abonnements Telegram récurrents en tout temps dans Paramètres Telegram > Étoiles._`
    );
  },

  accessChannels: (accessibleSpaces: SpaceId[]) => {
    if (accessibleSpaces.length === 0) {
      return (
        `🔒 *ACCÈS AUX CANAUX PRIVÉS*\n\n` +
        `Vous n'avez accès à aucun espace privé.\n` +
        `Veuillez acheter un abonnement pour débloquer les espaces ${getClubName()}.`
      );
    }

    return (
      `🔓 *ACCÈS AUX CANAUX PRIVÉS*\n\n` +
      `Appuyez sur chaque bouton ci-dessous pour demander à joindre vos espaces autorisés.\n` +
      `Notre système approuvera automatiquement votre demande sur-le-champ.`
    );
  },

  paySupport: () => {
    const config = getConfig();
    return (
      `💬 *SUPPORT ET FACTURATION ${getClubName()}*\n\n` +
      `Besoin d'aide avec votre abonnement ou votre paiement ?\n\n` +
      `• *Étoiles Telegram :* Gérées directement par Telegram. Vous pouvez consulter, gérer ou annuler vos abonnements actifs dans Paramètres Telegram > Étoiles.\n` +
      `• *Soutien du bot :* Communiquez avec ${config.SUPPORT_USERNAME} en indiquant votre identifiant Telegram pour toute question de facturation.\n` +
      `• *Remboursements :* Les remboursements admissibles sont traités selon les politiques des Étoiles Telegram.`
    );
  },

  paymentSuccess: (expiresAt: string, planId: MembershipPlanId = "regular") => {
    const club = getClubName();
    const dateStr = formatTorontoDate(expiresAt, { year: "numeric", month: "short", day: "numeric" });
    const retroLine = planId === "retro_plus" ? `• RETRO | ${club}\n` : "";

    return (
      `🎉 *PAIEMENT CONFIRMÉ !*\n\n` +
      `Merci ! Votre abonnement ${club} *${getPlan(planId).label}* est maintenant *actif* jusqu'au *${dateStr}*.\n\n` +
      `Vous avez maintenant accès à :\n` +
      `• TOKEBEC VIP COLLECTIONS\n` +
      retroLine +
      `• Clavardage général de ${club}\n` +
      `• Liste de souhaits\n\n` +
      `Appuyez sur *Accéder à mes canaux* ci-dessous pour entrer dans vos espaces !`
    );
  },

  adminMenu: () => {
    return (
      `🛠️ *${getClubName()} | ADMIN*\n\n` +
      `Choisissez un module d'administration :`
    );
  },

  unauthorized: () => {
    return `⛔ *Accès refusé :* Vous n'êtes pas autorisé à accéder à l'administration.`;
  },
};

export function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}
