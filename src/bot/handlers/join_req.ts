/**
 * Underground Manager — Chat Join Request Handler
 */

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
      // Send helpful message to the user if they were rejected
      try {
        const title = getSpaceTitle(result.spaceId);
        await ctx.api.sendMessage(
          result.userId,
          `⛔ *Access Denied to ${title}*\n\n` +
          `Your join request could not be approved because you do not have an active subscription for this space.\n\n` +
          `Subscribe with Telegram Stars below to get instant access:`,
          {
            parse_mode: "Markdown",
            reply_markup: new InlineKeyboard().text(
              "🌟 Join Underground VIP",
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
