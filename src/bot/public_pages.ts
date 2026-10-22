/**
 * LA CONFRÉRIE — Public information pages inside the bot (UG-05)
 *
 * Reached from the welcome menu / lobby / directory buttons via official bot
 * deep links (t.me/<bot>?start=<page>) and from in-bot buttons (nav:<page>).
 * Pages are informational; the only private link ever produced is a normal
 * approval-gated join link for a member whose entitlements already cover it.
 */

import { InlineKeyboard } from "grammy";
import { getClubName, getConfig } from "../config.ts";
import { getOrCreateJoinLink } from "../access/links.ts";
import { getChatId } from "../access/spaces.ts";
import { membershipMethods, messages } from "./messages.ts";
import { exploreUrl, directoryUrl, NavPage } from "../navigation/service.ts";
import { MembershipMode, MembershipSummary, SpaceId } from "../types.ts";
import { InviteApiLike } from "../access/links.ts";
import { hasAccessToSpace } from "../db/entitlements.ts";

export interface PageResult {
  text: string;
  kb: InlineKeyboard;
}

const back = (kb: InlineKeyboard) => kb.text("⬅️ Menu principal", "member:home");

function howItWorks(mode: MembershipMode): string {
  const club = getClubName();
  return (
    `❓ *COMMENT FONCTIONNE ${club}*\n\n` +
    `${membershipMethods(mode)}\n\n` +
    `*Contributions :*\n` +
    `• N'importe qui peut contribuer, même sans abonnement.\n` +
    `• Un administrateur examine chaque envoi et décide s'il est publié.\n` +
    `• Il décide *séparément* d'accorder ou non du temps d'accès, la durée, et le ou les forums (Regular, Retro ou les deux).\n` +
    `• Les jours gagnés s'additionnent : une nouvelle récompense prolonge le temps restant.\n\n` +
    `*Expiration :* l'accès prend fin quand il ne reste aucun droit valide (abonnement, contribution ou accès gracieux). ` +
    `Un rappel est envoyé environ 3 jours avant. Soumettre du contenu ne garantit pas une prolongation.\n\n` +
    `*Communauté :* les membres actifs (abonnés ou ayant gagné leur accès) accèdent à la Liste de souhaits, au clavardage général et au vote mensuel.`
  );
}

async function collectionPage(
  page: "regular" | "retro",
  api: InviteApiLike,
  summary: MembershipSummary,
  mode: MembershipMode
): Promise<PageResult> {
  const club = getClubName();
  const space: SpaceId = page === "retro" ? "retro_collections" : "vip_collections";
  const title = page === "retro" ? `RETRO | ${club}` : "TOKEBEC VIP COLLECTIONS";
  const kb = new InlineKeyboard();
  let text =
    `${page === "retro" ? "🎞️" : "📖"} *COLLECTION ${page === "retro" ? "RETRO" : "REGULAR"}*\n\n` +
    `Forum privé de créateurs : *${title}*.\n` +
    (page === "retro"
      ? `La collection Retro est un forum distinct, avec ses propres accès.\n\n`
      : `La collection Regular est le forum principal de créateurs.\n\n`);

  if (summary.accessibleSpaces.includes(space) && getChatId(space)) {
    let url: string | null = null;
    try {
      url = await getOrCreateJoinLink(api, space);
    } catch (err) {
      console.error("[Pages] join link failed:", err);
    }
    text += `✅ Vous avez accès à cette collection.`;
    if (url) kb.url(`👉 Joindre ${title}`, url).row();
  } else {
    text += `🔒 Vous n'avez pas encore accès à cette collection.\n\n${membershipMethods(mode)}`;
    kb.text("➕ Contribuer", "contrib:start").row();
    if (mode !== "contribution_only") kb.text("💎 Options d'adhésion", "member:plans").row();
  }
  kb.text("📚 Répertoire des créateurs", "dir:all").row();
  return { text, kb: back(kb) };
}

export async function renderNavPage(
  page: NavPage,
  api: InviteApiLike,
  summary: MembershipSummary,
  mode: MembershipMode
): Promise<PageResult> {
  const club = getClubName();
  const kb = new InlineKeyboard();

  switch (page) {
    case "amateur": {
      let text = "🔒 *COLLECTION AMATEUR*\n\nL'accès est accordé uniquement par les administrateurs, sur autorisation distincte.\nLes abonnements et les récompenses Regular/Retro ne débloquent pas cette collection.";
      if (getChatId("amateur_collections") && await hasAccessToSpace(summary.userId, "amateur_collections")) {
        try { kb.url("👉 Joindre la collection Amateur", await getOrCreateJoinLink(api, "amateur_collections")).row();
          text += "\n\n✅ Votre autorisation Amateur est active.";
        } catch { text += "\n\nLe lien est temporairement indisponible. Communiquez avec un administrateur."; }
      } else text += "\n\n🔐 Collection verrouillée. Communiquez avec un administrateur pour demander l'accès.";
      return { text, kb: back(kb) };
    }
    case "regular":
    case "retro":
      return await collectionPage(page, api, summary, mode);

    case "how":
      kb.text("➕ Contribuer", "contrib:start").row();
      if (mode !== "contribution_only") kb.text("💎 Options d'adhésion", "member:plans").row();
      return { text: howItWorks(mode), kb: back(kb) };

    case "contribute":
      // The bot menu itself is the contribution entry point; this page is a fallback title.
      kb.text("➕ Contribuer", "contrib:start").row();
      return {
        text: `➕ *CONTRIBUER À ${club}*\n\nAppuyez ci-dessous pour envoyer du contenu pour un créateur existant ou proposer un nouveau créateur. Tout envoi est examiné par un administrateur.`,
        kb: back(kb),
      };

    case "join": {
      let text = `💎 *JOINDRE ${club}*\n\n${membershipMethods(mode)}`;
      if (mode === "contribution_only") {
        text += `\n\nLes abonnements par Étoiles ne sont pas offerts actuellement : le moyen de se joindre est de contribuer.`;
      }
      if (mode !== "stars_only") kb.text("➕ Contribuer", "contrib:start").row();
      if (mode !== "contribution_only") kb.text("🌟 Voir les abonnements", "member:plans").row();
      return { text, kb: back(kb) };
    }

    case "rules": {
      const text =
        `📜 *RÈGLES ET SOUTIEN*\n\n` +
        `• Respectez les autres membres; pas de partage du contenu privé à l'extérieur.\n` +
        `• Ne soumettez que du contenu que vous avez le droit de partager; chaque envoi est examiné.\n` +
        `• Seules des personnes majeures ayant consenti à la diffusion sont acceptées.\n` +
        `• Les administrateurs peuvent refuser un envoi ou retirer l'accès en cas d'abus.\n\n` +
        messages.paySupport();
      kb.text("➕ Contribuer", "contrib:start").row();
      return { text, kb: back(kb) };
    }

    case "leaderboard": {
      const { renderLeaderboard } = await import("./leaderboard_view.ts");
      const view = await renderLeaderboard(summary.userId, "month");
      return { text: view.text, kb: view.kb };
    }

    case "directory":
      kb.text("Tous", "dir:all").text("Regular", "dir:regular").text("Retro", "dir:retro").row();
      kb.url("📣 Ouvrir le répertoire public", directoryUrl()).row();
      return { text: `📚 *RÉPERTOIRE DES CRÉATEURS*\n\nChoisissez un filtre :`, kb: back(kb) };

    case "explore": {
      const lobby = getConfig().TELEGRAM_PUBLIC_LOBBY_URL;
      if (lobby) kb.url("🧭 Ouvrir LA CONFRÉRIE | ACCUEIL", exploreUrl()).row();
      kb.text("📖 Collection Regular", "nav:regular").text("🎞️ Collection Retro", "nav:retro").row();
      kb.text("🔒 Collection Amateur", "nav:amateur").row();
      kb.text("❓ Comment ça fonctionne", "nav:how").text("📚 Répertoire", "nav:directory").row();
      return {
        text:
          `🧭 *EXPLORER ${club}*\n\n` +
          `Une collection de créateurs propulsée par la communauté : Regular et Retro, ainsi qu'une collection Amateur sur autorisation administrative distincte.\n\n` +
          `${membershipMethods(mode)}`,
        kb: back(kb),
      };
    }
  }
}
