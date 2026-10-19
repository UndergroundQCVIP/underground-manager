/**
 * Underground Manager — Message Templates & Strings
 * Organized cleanly to facilitate localization (Quebec French strings).
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
        `👋 *Bon retour, ${escapeMarkdown(firstName)} !*\n\n` +
        `Vous avez un abonnement *Underground VIP* actif.\n` +
        `Gérez votre abonnement ou accédez à vos espaces privés ci-dessous.`
      );
    }
    return (
      `👋 *Bienvenue sur Underground Manager, ${escapeMarkdown(firstName)}.*\n\n` +
      `Underground est une communauté privée exclusive offrant des archives de créateurs triées sur le volet, des collections privées et des discussions VIP.\n\n` +
      `🌟 *Abonnement VIP :* ${config.STARS_PRICE_AMOUNT} Étoiles Telegram / 30 jours\n` +
      `Abonnement récurrent facturé par les Étoiles Telegram officielles.\n\n` +
      `Choisissez une option ci-dessous pour vous joindre ou gérer votre compte :`
    );
  },

  nonMemberInfo: () => {
    const config = getConfig();
    return (
      `💎 *ABONNEMENT UNDERGROUND VIP*\n\n` +
      `Votre abonnement vous donne un accès exclusif à :\n` +
      `• *TOKEBEC VIP COLLECTIONS* — Bibliothèque de créateurs sélectionnés\n` +
      `• *Underground General Chat* — Conversations privées entre membres\n` +
      `• *Liste de souhaits* — Demandes et suggestions de créateurs\n\n` +
      `💳 *Prix :* ${config.STARS_PRICE_AMOUNT} Étoiles / 30 jours\n` +
      `🔄 *Type :* Abonnement récurrent, annulable en tout temps dans les paramètres de Telegram\n\n` +
      `Appuyez ci-dessous pour vous abonner immédiatement :`
    );
  },

  membershipStatus: (summary: MembershipSummary) => {
    const config = getConfig();
    if (!summary.isMember) {
      return (
        `📋 *MON ABONNEMENT*\n\n` +
        `*Statut :* ⚪ Inactif / Aucun abonnement\n` +
        `*Prix :* ${config.STARS_PRICE_AMOUNT} Étoiles tous les 30 jours\n\n` +
        `Vous n'avez actuellement aucun abonnement actif. Appuyez ci-dessous pour vous abonner.`
      );
    }

    const typeStr = summary.hasPaid
      ? "🌟 Payant (Étoiles Telegram)"
      : "🎁 Gracieux";

    const expiryStr = summary.effectiveExpiry
      ? formatTorontoDate(summary.effectiveExpiry, {
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "Indéterminée";

    const spacesList = summary.accessibleSpaces
      .map((s) => `  ✓ ${getSpaceTitle(s)}`)
      .join("\n");

    const renewalStr = summary.isRecurring
      ? "Renouvellement automatique tous les 30 jours par Étoiles Telegram"
      : "Non renouvelable (accès gracieux)";

    return (
      `📋 *MON ABONNEMENT*\n\n` +
      `*Type :* ${typeStr}\n` +
      `*Statut :* 🟢 Actif\n` +
      `*Valide jusqu'au :* ${expiryStr}\n` +
      `*Renouvellement :* ${renewalStr}\n\n` +
      `*Espaces accessibles :*\n${spacesList}\n\n` +
      `_Gérez vos abonnements Telegram récurrents en tout temps dans Paramètres Telegram > Étoiles._`
    );
  },

  accessChannels: (accessibleSpaces: SpaceId[]) => {
    if (accessibleSpaces.length === 0) {
      return (
        `🔒 *ACCÈS AUX CANAUX PRIVÉS*\n\n` +
        `Vous n'avez accès à aucun espace privé.\n` +
        `Veuillez acheter un abonnement pour débloquer les espaces Underground.`
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
      `💬 *SUPPORT ET FACTURATION UNDERGROUND*\n\n` +
      `Besoin d'aide avec votre abonnement ou votre paiement ?\n\n` +
      `• *Étoiles Telegram :* Gérées directement par Telegram. Vous pouvez consulter, gérer ou annuler vos abonnements actifs dans Paramètres Telegram > Étoiles.\n` +
      `• *Soutien du bot :* Communiquez avec ${config.SUPPORT_USERNAME} en indiquant votre identifiant Telegram pour toute question de facturation.\n` +
      `• *Remboursements :* Les remboursements admissibles sont traités selon les politiques des Étoiles Telegram.`
    );
  },

  paymentSuccess: (expiresAt: string) => {
    const dateStr = formatTorontoDate(expiresAt, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });

    return (
      `🎉 *PAIEMENT CONFIRMÉ !*\n\n` +
      `Merci ! Votre abonnement Underground VIP est maintenant *actif* jusqu'au *${dateStr}*.\n\n` +
      `Vous avez maintenant un accès complet à :\n` +
      `• TOKEBEC VIP COLLECTIONS\n` +
      `• Underground General Chat\n` +
      `• Liste de souhaits\n\n` +
      `Appuyez sur *Accéder à mes canaux* ci-dessous pour entrer dans vos espaces !`
    );
  },

  adminMenu: () => {
    return (
      `🛠️ *UNDERGROUND MANAGER — ADMINISTRATION*\n\n` +
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
