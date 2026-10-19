/**
 * LA CONFRÉRIE — Bot Assembly & Error Handling
 */

import { Bot } from "grammy";
import { getConfig } from "../config.ts";
import { idempotencyMiddleware } from "./middleware/idempotency.ts";
import { trackUserMiddleware } from "./middleware/auth.ts";
import { startComposer } from "./handlers/start.ts";
import { membershipComposer } from "./handlers/membership.ts";
import { paymentsComposer } from "./handlers/payments.ts";
import { joinReqComposer } from "./handlers/join_req.ts";
import { adminComposer } from "./handlers/admin.ts";
import { forumComposer } from "./handlers/forum.ts";
import { wantedComposer } from "./handlers/wanted.ts";
import { votingComposer } from "./handlers/voting.ts";
import { treasuryComposer } from "./handlers/treasury.ts";
import { migrationComposer } from "./handlers/migration.ts";
import { directoryComposer } from "./handlers/directory.ts";
import { contributeComposer } from "./handlers/contribute.ts";
import { adminSettingsComposer } from "./handlers/admin_settings.ts";
import { referralsComposer } from "./handlers/referrals.ts";

export function createBot(token?: string): Bot {
  const config = getConfig();
  const botToken = token || config.BOT_TOKEN;

  if (!botToken) {
    throw new Error("BOT_TOKEN is required to initialize the bot.");
  }

  const bot = new Bot(botToken);

  // Global Error Handler
  bot.catch((err) => {
    const ctx = err.ctx;
    console.error(`[Bot Error] Update ID ${ctx.update.update_id}:`, err.error);
  });

  // Global Middlewares
  bot.use(idempotencyMiddleware);
  bot.use(trackUserMiddleware);

  // Feature Composers
  bot.use(startComposer);
  bot.use(membershipComposer);
  bot.use(paymentsComposer);
  bot.use(joinReqComposer);
  bot.use(adminComposer);
  bot.use(migrationComposer);
  bot.use(adminSettingsComposer);
  bot.use(directoryComposer);
  bot.use(referralsComposer);
  bot.use(contributeComposer);
  bot.use(forumComposer);
  bot.use(wantedComposer);
  bot.use(votingComposer);
  bot.use(treasuryComposer);

  return bot;
}
