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
      if (result.spaceId === "amateur_collections") {
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
          `Votre demande d'adhésion n'a pas pu être approuvée, car vous n'avez pas d'abonnement actif pour cet espace.\n\n` +
          `Abonnez-vous avec les Étoiles Telegram ci-dessous pour obtenir un accès immédiat :`,
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
