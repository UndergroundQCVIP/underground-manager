/**
 * Underground Manager — Auth & Member Tracking Middleware
 */

import { Context, NextFunction } from "grammy";
import { isAdministrator } from "../../config.ts";
import { upsertMember } from "../../db/members.ts";
import { logAuditEvent } from "../../db/audit.ts";
import { messages } from "../messages.ts";

export async function trackUserMiddleware(ctx: Context, next: NextFunction): Promise<void> {
  if (ctx.from) {
    try {
      await upsertMember({
        id: ctx.from.id,
        username: ctx.from.username,
        first_name: ctx.from.first_name,
        last_name: ctx.from.last_name,
      });
    } catch (err) {
      console.error("Failed to track user interaction:", err);
    }
  }
  await next();
}

export async function adminOnlyMiddleware(ctx: Context, next: NextFunction): Promise<void> {
  const userId = ctx.from?.id;

  if (!userId || !isAdministrator(userId)) {
    if (userId) {
      await logAuditEvent(
        "unauthorized_access_attempt",
        { command: ctx.message?.text || ctx.callbackQuery?.data },
        0,
        userId
      );
    }

    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({
        text: "⛔ Access Denied: Administrator privileges required.",
        show_alert: true,
      });
    } else {
      await ctx.reply(messages.unauthorized(), { parse_mode: "Markdown" });
    }
    return;
  }

  await next();
}
