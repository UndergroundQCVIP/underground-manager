/**
 * LA CONFRÉRIE — Main Application Entry Point
 * Supports Deno Deploy (webhook + Deno.cron) and local development (polling).
 */

import { webhookCallback } from "grammy";
import { getConfig, loadConfig, validateConfig } from "./config.ts";
import { createBot } from "./bot/bot.ts";
import { registerCronJobs } from "./cron/reconciliation.ts";
import { getKv } from "./db/kv.ts";

async function main() {
  const config = loadConfig();

  console.log("=========================================");
  console.log(`   ${config.CLUB_DISPLAY_NAME} — PHASE UG-04    `);
  console.log("=========================================");
  console.log(`Environment: ${config.DENO_ENV}`);
  console.log(`Bot Mode:    ${config.BOT_MODE}`);
  console.log(`Regular:     ${config.STARS_PRICE_AMOUNT} XTR / 30 days`);
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
    if (config.DENO_ENV === "production") {
      console.error("\nFatal: Missing required configuration in production. Exiting.");
      Deno.exit(1);
    }
  }

  // Ensure Deno KV database is accessible
  try {
    await getKv();
    console.log("[Database] Deno KV connection initialized.");
  } catch (err) {
    console.error("[Database Fatal] Could not open Deno KV database:", err);
    if (config.DENO_ENV === "production") {
      Deno.exit(1);
    }
  }

  // Initialize bot instance
  const bot = createBot();

  // Register scheduled hourly reconciliation
  registerCronJobs(bot);

  if (config.BOT_MODE === "polling") {
    console.log("[Bot] Launching in long polling mode for development...");
    await bot.start({
      onStart: (botInfo) => {
        console.log(`[Bot] Successfully started polling as @${botInfo.username}`);
      },
    });
  } else {
    // Webhook mode (default for Deno Deploy)
    const handleWebhook = webhookCallback(bot, "std/http");

    console.log(`[Server] Starting HTTP webhook listener on port ${config.PORT}...`);

    Deno.serve({ port: config.PORT }, async (req: Request) => {
      const url = new URL(req.url);

      // Health check endpoint
      if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
        return new Response(
          JSON.stringify({
            status: "ok",
            app: "underground-manager",
            phase: "UG-04",
            env: config.DENO_ENV,
            timestamp: new Date().toISOString(),
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      // Webhook endpoint
      if (req.method === "POST" && (url.pathname === "/webhook" || url.pathname === "/")) {
        // Verify Telegram secret token header if configured
        if (config.WEBHOOK_SECRET) {
          const secretHeader = req.headers.get("x-telegram-bot-api-secret-token");
          if (secretHeader !== config.WEBHOOK_SECRET) {
            console.warn("[Security] Rejected webhook request with invalid secret token.");
            return new Response("Unauthorized", { status: 401 });
          }
        }

        try {
          return await handleWebhook(req);
        } catch (err) {
          console.error("[Webhook Error] Unhandled error processing webhook:", err);
          return new Response("Internal Server Error", { status: 500 });
        }
      }

      return new Response("Not Found", { status: 404 });
    });
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[Fatal Error]", err);
    Deno.exit(1);
  });
}
