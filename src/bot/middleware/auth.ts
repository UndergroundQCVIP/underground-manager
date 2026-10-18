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
    } else if (ctx.chat?.type === "private") {
      // Never answer in groups/channels: that would leak that the command exists
      // and spam shared chats.
      await ctx.reply(messages.unauthorized(), { parse_mode: "Markdown" });
    }
    return;
  }

  await next();
}

/**
 * Scopes the administrator check to a composer's own routes.
 *
 * `composer.use(adminOnlyMiddleware)` would gate EVERY update that reaches the
 * composer — including ordinary members' /suggest, /vote and callback taps and
 * every message in the group chats — silently disabling the member features
 * registered after it and spamming "Access Denied". This guard only applies the
 * admin check to the given slash-commands and `admin:*` callback buttons and
 * lets everything else flow on to later composers.
 */
export function adminRouteGuard(commands: string[]) {
  return async (ctx: Context, next: NextFunction): Promise<void> => {
    const data = ctx.callbackQuery?.data;
    const isAdminCallback = typeof data === "string" && data.startsWith("admin:");
    const isAdminCommand = commands.length > 0 && ctx.hasCommand(commands);

    if (isAdminCallback || isAdminCommand) {
      await adminOnlyMiddleware(ctx, next);
      return;
    }
    await next();
  };
}
