/**
 * Underground Manager — Operational Setup & Live Verification Tool
 *
 * Runs non-destructive diagnostic checks against Telegram Bot API and Deno KV
 * to verify environment readiness before live deployment.
 *
 * Usage:
 *   deno run --allow-net --allow-env --unstable-kv scripts/verify_setup.ts
 */

import { Bot } from "grammy";
import { getConfig, validateConfig } from "../src/config.ts";
import { getKv } from "../src/db/kv.ts";
import { SPACE_DEFINITIONS, SPACE_IDS } from "../src/types.ts";
import { checkBotPermissions } from "../src/access/sync.ts";

async function main() {
  console.log("=================================================");
  console.log("   UNDERGROUND MANAGER — LIVE SETUP VERIFICATION ");
  console.log("=================================================\n");

  const config = getConfig();

  // 1. Configuration Validation
  console.log("1. Environment & Configuration Check:");
  const errors = validateConfig(config);
  if (errors.length > 0) {
    console.log("  ⚠️  Configuration issues detected:");
    for (const e of errors) {
      console.log(`     - ${e}`);
    }
  } else {
    console.log("  ✅ Configuration parameters are valid.");
  }
  console.log(`     • Admin User IDs: ${config.ADMIN_USER_IDS.join(", ") || "None"}`);
  console.log(`     • Stars Price:    ${config.STARS_PRICE_AMOUNT} ${config.CURRENCY} / ${config.STARS_SUBSCRIPTION_PERIOD_SECONDS}s`);
  console.log(`     • Runtime Mode:   ${config.BOT_MODE}`);
  console.log(`     • Environment:    ${config.DENO_ENV}\n`);

  // 2. Deno KV Connectivity
  console.log("2. Persistent Database (Deno KV) Check:");
  try {
    const kv = await getKv();
    const testKey = ["_health_check_diag", Date.now()];
    await kv.set(testKey, { ok: true, ts: new Date().toISOString() });
    const read = await kv.get(testKey);
    await kv.delete(testKey);

    if (read.value) {
      console.log("  ✅ Deno KV read/write/delete operations verified.\n");
    } else {
      console.log("  ❌ Deno KV read check failed.\n");
    }
  } catch (err) {
    console.log(`  ❌ Deno KV Error: ${err instanceof Error ? err.message : String(err)}\n`);
  }

  // 3. Telegram Bot Token Verification
  if (!config.BOT_TOKEN) {
    console.log("3. Telegram Bot API: ⚠️ Skipped (BOT_TOKEN not provided).\n");
    printSummary(false);
    return;
  }

  console.log("3. Telegram Bot API Connectivity:");
  const bot = new Bot(config.BOT_TOKEN);

  let botId = 0;
  try {
    const me = await bot.api.getMe();
    botId = me.id;
    console.log(`  ✅ Bot token verified. Connected as @${me.username} (ID: ${me.id}).\n`);
  } catch (err) {
    console.log(`  ❌ Failed to connect to Telegram Bot API: ${err instanceof Error ? err.message : String(err)}\n`);
    printSummary(false);
    return;
  }

  // 4. Space Permissions Check
  console.log("4. Protected Telegram Spaces & Administrator Rights:");
  let allSpacesOk = true;

  for (const spaceId of SPACE_IDS) {
    const def = SPACE_DEFINITIONS[spaceId];
    const chatId = config[def.envVar];

    if (!chatId) {
      console.log(`  ⚠️  ${def.name} (${spaceId}): Missing Chat ID (${def.envVar}).`);
      allSpacesOk = false;
      continue;
    }

    try {
      const chat = await bot.api.getChat(chatId);
      const permCheck = await checkBotPermissions(bot.api, spaceId);

      if (permCheck.ok) {
        console.log(`  ✅ ${def.name}: OK`);
        console.log(`     • Title:   ${"title" in chat ? chat.title : "N/A"}`);
        console.log(`     • Chat ID: ${chatId}`);
        console.log(`     • Rights:  Administrator with invite & restrict permissions.`);
      } else {
        allSpacesOk = false;
        console.log(`  ⚠️  ${def.name}: Chat found but missing required rights:`);
        for (const p of permCheck.missingPermissions) {
          console.log(`     - ${p}`);
        }
      }
    } catch (err) {
      allSpacesOk = false;
      console.log(`  ❌ ${def.name} (Chat ID: ${chatId}): Cannot access chat.`);
      console.log(`     Reason: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Check Public Creator Directory
  if (config.PUBLIC_DIRECTORY_CHAT_ID) {
    try {
      const pubChat = await bot.api.getChat(config.PUBLIC_DIRECTORY_CHAT_ID);
      const pubMember = await bot.api.getChatMember(config.PUBLIC_DIRECTORY_CHAT_ID, botId);
      const isAdm = pubMember.status === "administrator";
      console.log(`  ✅ Public Creator Directory: OK`);
      console.log(`     • Title:   ${"title" in pubChat ? pubChat.title : "N/A"}`);
      console.log(`     • Chat ID: ${config.PUBLIC_DIRECTORY_CHAT_ID}`);
      console.log(`     • Rights:  ${isAdm ? "Administrator (can post/edit directory)" : pubMember.status}`);
    } catch (err) {
      allSpacesOk = false;
      console.log(`  ❌ Public Creator Directory (Chat ID: ${config.PUBLIC_DIRECTORY_CHAT_ID}): Cannot access chat.`);
      console.log(`     Reason: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    console.log(`  ⚠️  Public Creator Directory: Missing Chat ID (PUBLIC_DIRECTORY_CHAT_ID).`);
  }
  console.log();

  // 5. Webhook Status Check
  console.log("5. Telegram Webhook Status:");
  try {
    const webhookInfo = await bot.api.getWebhookInfo();
    console.log(`     • Webhook URL:        ${webhookInfo.url || "(None - Polling Mode)"}`);
    console.log(`     • Pending Updates:    ${webhookInfo.pending_update_count}`);
    if (webhookInfo.last_error_message) {
      console.log(`     • Last Delivery Error: ${webhookInfo.last_error_message}`);
    }
    console.log();
  } catch (err) {
    console.log(`  ⚠️ Could not query webhook info: ${err instanceof Error ? err.message : String(err)}\n`);
  }

  printSummary(errors.length === 0 && allSpacesOk);
}

function printSummary(ready: boolean) {
  console.log("=================================================");
  if (ready) {
    console.log("🎉 ALL SYSTEMS READY FOR PRODUCTION DEPLOYMENT!");
  } else {
    console.log("⚠️  ACTION REQUIRED BEFORE LIVE PRODUCTION LAUNCH.");
    console.log("Review any warnings above and consult README.md.");
  }
  console.log("=================================================\n");
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Diagnostic tool encountered an unhandled error:", err);
  });
}
