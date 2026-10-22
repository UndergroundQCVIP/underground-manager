/**
 * LA CONFRÉRIE — Main Application Entry Point
 * Supports Deno Deploy (webhook + Deno.cron) and local development (polling).
 */

import { API_CONSTANTS, webhookCallback } from "grammy";
import { fatalConfigErrors, loadConfig, validateConfig } from "./config.ts";
import { createBot } from "./bot/bot.ts";
import { registerCronJobs } from "./cron/reconciliation.ts";
import { getKv } from "./db/kv.ts";
import { createFetchHandler, createPreviewFetchHandler, isLiveBotRuntime } from "./server.ts";
import { syncDirectoryIfNeeded } from "./directory/sync.ts";
import { repairLegacyFullContentRewards } from "./complimentary/service.ts";
import { refreshAmateurConfiguration } from "./db/amateur.ts";
import { syncNavigationMessages } from "./navigation/service.ts";

async function main() {
  const config = loadConfig();

  console.log("=========================================");
  console.log(`   ${config.CLUB_DISPLAY_NAME}`);
  console.log("=========================================");
  console.log(`Environment: ${config.DENO_ENV}`);
  console.log(`Bot Mode:    ${config.BOT_MODE}`);
  console.log(`Regular:     ${config.STARS_PRICE_AMOUNT} XTR / ${config.STARS_SUBSCRIPTION_PERIOD_SECONDS}s`);
  console.log(
    `Retro Plus:  ${config.RETRO_PLUS_STARS_PRICE_AMOUNT > 0 ? `${config.RETRO_PLUS_STARS_PRICE_AMOUNT} XTR / 30 days` : "billing disabled (price not configured)"}`
  );
  console.log(`Retro forum: ${config.TELEGRAM_RETRO_FORUM_CHAT_ID ? "configured" : "NOT configured"}`);

  const errors = validateConfig(config);
  if (errors.length > 0) {
    console.error("\n[Configuration Warnings/Errors]:");
    for (const err of errors) {
      console.error(` - ${err}`);
    }
    // Security-critical problems are fatal in every environment: a missing webhook
    // secret or bot token must never fall through to "serve anyway".
    if (config.DENO_ENV === "production" || fatalConfigErrors(config).length > 0) {
      console.error("\nFatal: invalid configuration. Exiting.");
      Deno.exit(1);
    }
  }

  // Ensure Deno KV database is accessible
  try {
    await getKv();
    await refreshAmateurConfiguration();
    console.log("[Database] Deno KV connection initialized.");
  } catch (err) {
    console.error("[Database Fatal] Could not open Deno KV database:", err);
    Deno.exit(1);
  }

  try {
    const repaired = await repairLegacyFullContentRewards();
    if (repaired) console.log(`[Rewards] Added missing Retro access to ${repaired} full content reward(s).`);
  } catch (error) { console.error("[Rewards repair] Will retry during reconciliation:", error); }

  if (config.BOT_MODE === "polling") {
    console.log("[Bot] Launching in long polling mode for development...");
    await bot.start({
      allowed_updates: [...API_CONSTANTS.ALL_UPDATE_TYPES],
      onStart: (botInfo) => {
        console.log(`[Bot] Successfully started polling as @${botInfo.username}`);
      },
    });
  } else {
    // Webhook mode (default for Deno Deploy)
    const handleWebhook = // Long jobs (imports, large publications) budget ~20s per step; grammY's default 10s timeout would
    // answer Telegram with a 500 and trigger redeliveries while the work is still running.
    webhookCallback(bot, "std/http", { timeoutMilliseconds: 55_000 });
    console.log(`[Server] Starting HTTP webhook listener on port ${config.PORT}...`);
    Deno.serve(
      { port: config.PORT },
      createFetchHandler({ webhookSecret: config.WEBHOOK_SECRET, handleWebhook })
    );
    // Upgrade/repair the public posts immediately after serving starts, using production KV.
    void syncDirectoryIfNeeded(bot.api).then((result) => {
      if (result.error) console.error("[Directory startup]", result.error);
    }).catch((error) => console.error("[Directory startup]", error));
    void syncNavigationMessages(bot.api).then((result) => {
      for (const [page, outcome] of Object.entries(result)) {
        if (outcome.error) console.error(`[Navigation startup: ${page}]`, outcome.error);
      }
    }).catch((error) => console.error("[Navigation startup]", error));
  }
}

// Deno.cron jobs must be registered synchronously while the main module is being
// evaluated (before any `await`); jobs registered later on Deno Deploy never run.
let bot: ReturnType<typeof createBot>;
if (import.meta.main) {
  if (!isLiveBotRuntime(Deno.env.get("DENO_TIMELINE"))) {
    // Build warmup starts previews with a fresh KV database. Never let them publish
    // empty directories, accept live updates or register reconciliation workers.
    console.log("[Preview] Telegram bot and scheduled jobs disabled.");
    Deno.serve({ port: Number(Deno.env.get("PORT") ?? "8000") }, createPreviewFetchHandler());
  } else {
    const bootConfig = loadConfig();
    if (fatalConfigErrors(bootConfig).length > 0) {
      // main() prints the details and exits; avoid constructing a bot without a token.
      main().catch((err) => {
        console.error("[Fatal Error]", err);
        Deno.exit(1);
      });
    } else {
      bot = createBot();
      registerCronJobs(bot);
      main().catch((err) => {
        console.error("[Fatal Error]", err);
        Deno.exit(1);
      });
    }
  }
}
