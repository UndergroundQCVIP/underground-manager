/**
 * LA CONFRÉRIE — Bot-managed leaderboard post (UG-07)
 * Optional: only published when TELEGRAM_LEADERBOARD_CHAT_ID is configured.
 */

import { getConfig } from "../config.ts";
import { NavApiLike, syncSlotMessage } from "../navigation/service.ts";
import { buildLeaderboardPost } from "./service.ts";

export async function syncLeaderboardPost(api: NavApiLike, force = false) {
  const chatId = getConfig().TELEGRAM_LEADERBOARD_CHAT_ID;
  if (!chatId) return { outcome: "not_configured" as const };
  return await syncSlotMessage(api, "leaderboard", chatId, await buildLeaderboardPost(), force);
}
