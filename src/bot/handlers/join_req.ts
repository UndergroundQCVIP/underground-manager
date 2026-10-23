/**
 * LA CONFRÉRIE — Chat Join Request Handler
 */

import { getClubName } from "../../config.ts";
import { Composer, InlineKeyboard } from "grammy";
import { processChatJoinRequest } from "../../access/join_requests.ts";
import { getSpaceTitle } from "../../access/spaces.ts";

export const joinReqComposer = new Composer();

joinReqComposer.on("chat_join_request", async (ctx) => {
  const request = ctx.chatJoinRequest;
  if (!request) return;

  try {
    const result = await processChatJoinRequest(ctx.api, {
      chat: { id: request.chat.id, title: request.chat.title },
      from: {
        id: request.from.id,
        first_name: request.from.first_name,
        username: request.from.username,
      },
    });

    if (!result.approved && result.spaceId) {
      if (result.error) {
        await ctx.api.sendMessage(result.userId,
          (result.eligible ? "✅ Votre accès est bien actif.\n\n" : "⚠️ Votre demande n'a pas pu être traitée.\n\n") +
          "Telegram n'a pas permis de finaliser votre demande d'adhésion. Aucun paiement supplémentaire n'est demandé. Réessayez avec les liens ci-dessous ou contactez un administrateur si la demande reste en attente.",
          { reply_markup: new InlineKeyboard().text("🔄 Réessayer l'accès", "member:channels:refresh") }).catch(() => {});
        return;
      }
      if ((result.spaceId === "amateur_collections" || result.spaceId === "amateur_chat")) {
        await ctx.api.sendMessage(result.userId,
          "🔒 L'accès Amateur nécessite une autorisation distincte d'un administrateur. Aucun abonnement ou accès complet Regular/Retro ne le débloque.",
          { reply_markup: new InlineKeyboard().text("⬅️ Menu principal", "member:home") }).catch(() => {});
        return;
      }
      // Send helpful message to the user if they were rejected
      try {
        const title = getSpaceTitle(result.spaceId);
        await ctx.api.sendMessage(
          result.userId,
          `⛔ *Accès refusé à ${title}*\n\n` +
          `Aucun accès valide n'est actuellement enregistré pour votre compte dans cet espace.\n\n` +
          `Les accès accordés par les administrateurs ou gagnés avec du contenu approuvé sont acceptés. Si un accès vient de vous être accordé, vérifiez votre compte Telegram et contactez un administrateur.`,
          {
            parse_mode: "Markdown",
            reply_markup: new InlineKeyboard().text(
              "🌟 Joindre " + getClubName(),
              "member:join"
            ),
          }
        );
      } catch {
        // User may have blocked bot or not started it yet
      }
    }
  } catch (err) {
    console.error("Unhandled error processing chat_join_request:", err);
  }
});
