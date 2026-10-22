/**
 * LA CONFRÉRIE — Configuration & Environment Loading
 */

import { SpaceId } from "./types.ts";

export interface AppConfig {
  BOT_TOKEN: string;
  BOT_USERNAME: string;
  WEBHOOK_SECRET: string;
  ADMIN_USER_IDS: number[];
  VIP_COLLECTIONS_CHAT_ID: number;
  /** UG-04: private RETRO | LA CONFRÉRIE forum (0 = not configured). */
  TELEGRAM_RETRO_FORUM_CHAT_ID: number;
  TELEGRAM_AMATEUR_FORUM_CHAT_ID: number;
  TELEGRAM_AMATEUR_CHAT_ID: number;
  TELEGRAM_ADMIN_REVIEW_CHAT_ID: number;
  PUBLIC_DIRECTORY_CHAT_ID: number;
  /** UG-05: optional public t.me link of the directory channel (used by navigation buttons). */
  PUBLIC_DIRECTORY_URL: string;
  /** UG-07: optional channel/group for the bot-managed leaderboard post (0 = none). */
  TELEGRAM_LEADERBOARD_CHAT_ID: number;
  /** UG-05: public info group "LA CONFRÉRIE | ACCUEIL" (0 = not configured). Never access-controlled. */
  TELEGRAM_PUBLIC_LOBBY_CHAT_ID: number;
  /** UG-05: public invite/t.me link to the lobby ("" = not configured). */
  TELEGRAM_PUBLIC_LOBBY_URL: string;
  /** UG-05: public welcome channel that carries the bot-managed welcome menu (0 = none). */
  TELEGRAM_PUBLIC_WELCOME_CHAT_ID: number;
  /** UG-05: initial membership acquisition mode before an admin changes it in Settings. */
  MEMBERSHIP_MODE: "contribution_only" | "contributions_and_stars" | "stars_only";
  WANTED_LIST_CHAT_ID: number;
  GENERAL_CHAT_ID: number;
  /** UG-04: public club name used in all user-facing text. */
  CLUB_DISPLAY_NAME: string;
  /** Regular plan price (unchanged UG-01 variable). */
  STARS_PRICE_AMOUNT: number;
  /** Retro Plus: 1,200 Stars per 30 days by default; explicit 0 disables billing. */
  RETRO_PLUS_STARS_PRICE_AMOUNT: number;
  STARS_SUBSCRIPTION_PERIOD_SECONDS: number;
  CURRENCY: string;
  BOT_MODE: "webhook" | "polling";
  PORT: number;
  DENO_ENV: "production" | "development" | "test";
  SUPPORT_USERNAME: string;
  DIRECTORY_UPDATE_CRON: string;
  VOTING_PERIOD_DAYS: number;
  VOTING_SHORTLIST_SIZE: number;
  DIGEST_ENABLED: boolean;
  BASE_CURRENCY: string;
  DEFAULT_STARS_REWARD_VALUATION_USD: number;
  TREASURY_REPORT_CHANNEL_ID: number;
  EXCHANGE_RATE_API_URL: string;
  /** UG-04: max message IDs per copyMessages call (1-100). */
  MIGRATION_BATCH_SIZE: number;
  /** UG-04: pause between copy batches, in milliseconds (rate-limit friendly). */
  MIGRATION_BATCH_DELAY_MS: number;
}

let activeConfig: AppConfig | null = null;

export function loadConfig(envOverride?: Record<string, string>): AppConfig {
  const getEnv = (key: string, defaultValue = ""): string => {
    if (envOverride && key in envOverride) {
      return envOverride[key];
    }
    try {
      return Deno.env.get(key) ?? defaultValue;
    } catch {
      return defaultValue;
    }
  };

  const adminRaw = getEnv("ADMIN_USER_IDS", "");
  const adminIds = adminRaw
    ? adminRaw
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => !isNaN(n) && n > 0)
    : [];

  const config: AppConfig = {
    BOT_TOKEN: getEnv("BOT_TOKEN", ""),
    BOT_USERNAME: getEnv("BOT_USERNAME", "UndergroundManagerBot"),
    WEBHOOK_SECRET: getEnv("WEBHOOK_SECRET", ""),
    ADMIN_USER_IDS: adminIds,
    VIP_COLLECTIONS_CHAT_ID: Number(getEnv("VIP_COLLECTIONS_CHAT_ID", "0")),
    TELEGRAM_RETRO_FORUM_CHAT_ID: Number(getEnv("TELEGRAM_RETRO_FORUM_CHAT_ID", "0")),
    TELEGRAM_AMATEUR_CHAT_ID: Number(getEnv("TELEGRAM_AMATEUR_CHAT_ID", "0")),
    TELEGRAM_ADMIN_REVIEW_CHAT_ID: Number(getEnv("TELEGRAM_ADMIN_REVIEW_CHAT_ID", "0")),
    TELEGRAM_AMATEUR_FORUM_CHAT_ID: Number(getEnv("TELEGRAM_AMATEUR_FORUM_CHAT_ID", "0")),
    PUBLIC_DIRECTORY_CHAT_ID: Number(getEnv("PUBLIC_DIRECTORY_CHAT_ID", "0")),
    PUBLIC_DIRECTORY_URL: getEnv("PUBLIC_DIRECTORY_URL", "").trim(),
    TELEGRAM_LEADERBOARD_CHAT_ID: Number(getEnv("TELEGRAM_LEADERBOARD_CHAT_ID", "0")) || 0,
    TELEGRAM_PUBLIC_LOBBY_CHAT_ID: Number(getEnv("TELEGRAM_PUBLIC_LOBBY_CHAT_ID", "0")) || 0,
    TELEGRAM_PUBLIC_LOBBY_URL: getEnv("TELEGRAM_PUBLIC_LOBBY_URL", "").trim(),
    TELEGRAM_PUBLIC_WELCOME_CHAT_ID: Number(getEnv("TELEGRAM_PUBLIC_WELCOME_CHAT_ID", "0")) || 0,
    MEMBERSHIP_MODE: parseMembershipMode(getEnv("MEMBERSHIP_MODE", "")),
    WANTED_LIST_CHAT_ID: Number(getEnv("WANTED_LIST_CHAT_ID", "0")),
    GENERAL_CHAT_ID: Number(getEnv("GENERAL_CHAT_ID", "0")),
    CLUB_DISPLAY_NAME: getEnv("CLUB_DISPLAY_NAME", "").trim() || "LA CONFRÉRIE",
    STARS_PRICE_AMOUNT: Number(getEnv("STARS_PRICE_AMOUNT", "750")),
    RETRO_PLUS_STARS_PRICE_AMOUNT: Number(getEnv("RETRO_PLUS_STARS_PRICE_AMOUNT", "1200").trim() || "1200"),
    STARS_SUBSCRIPTION_PERIOD_SECONDS: Number(
      getEnv("STARS_SUBSCRIPTION_PERIOD_SECONDS", "2592000") // 30 days
    ),
    CURRENCY: getEnv("CURRENCY", "XTR"),
    BOT_MODE: getEnv("BOT_MODE", "webhook") === "polling" ? "polling" : "webhook",
    PORT: Number(getEnv("PORT", "8000")),
    DENO_ENV: (getEnv("DENO_ENV", "development") as AppConfig["DENO_ENV"]),
    SUPPORT_USERNAME: getEnv("SUPPORT_USERNAME", "@UndergroundSupport"),
    DIRECTORY_UPDATE_CRON: getEnv("DIRECTORY_UPDATE_CRON", "0 3 * * *"),
    VOTING_PERIOD_DAYS: Number(getEnv("VOTING_PERIOD_DAYS", "5")),
    VOTING_SHORTLIST_SIZE: Number(getEnv("VOTING_SHORTLIST_SIZE", "5")),
    DIGEST_ENABLED: getEnv("DIGEST_ENABLED", "false") === "true",
    BASE_CURRENCY: getEnv("BASE_CURRENCY", "CAD"),
    DEFAULT_STARS_REWARD_VALUATION_USD: Number(
      getEnv("DEFAULT_STARS_REWARD_VALUATION_USD", "0.013")
    ),
    TREASURY_REPORT_CHANNEL_ID: Number(
      getEnv("TREASURY_REPORT_CHANNEL_ID", "0")
    ),
    EXCHANGE_RATE_API_URL: getEnv(
      "EXCHANGE_RATE_API_URL",
      "https://open.er-api.com/v6/latest/USD"
    ),
    MIGRATION_BATCH_SIZE: Math.min(
      100,
      Math.max(1, Math.floor(Number(getEnv("MIGRATION_BATCH_SIZE", "30")) || 30))
    ),
    MIGRATION_BATCH_DELAY_MS: Math.max(
      0,
      Number(getEnv("MIGRATION_BATCH_DELAY_MS", "3000")) || 0
    ),
  };

  activeConfig = config;
  return config;
}

function parseMembershipMode(raw: string): AppConfig["MEMBERSHIP_MODE"] {
  return raw === "contributions_and_stars" || raw === "stars_only" ? raw : "contribution_only";
}

export function getClubName(config: AppConfig = getConfig()): string {
  return config.CLUB_DISPLAY_NAME;
}

export function getConfig(): AppConfig {
  if (!activeConfig) {
    return loadConfig();
  }
  return activeConfig;
}

export function setConfigForTesting(config: AppConfig): void {
  activeConfig = config;
}

export function validateConfig(config: AppConfig): string[] {
  const errors: string[] = [];

  if (!config.BOT_TOKEN) {
    errors.push("BOT_TOKEN is missing or empty.");
  }

  if (config.ADMIN_USER_IDS.length === 0) {
    errors.push("ADMIN_USER_IDS must contain at least one valid numeric Telegram user ID.");
  }

  if (!config.VIP_COLLECTIONS_CHAT_ID) {
    errors.push("VIP_COLLECTIONS_CHAT_ID is missing or invalid.");
  }

  if (!config.WANTED_LIST_CHAT_ID) {
    errors.push("WANTED_LIST_CHAT_ID is missing or invalid.");
  }

  if (!config.GENERAL_CHAT_ID) {
    errors.push("GENERAL_CHAT_ID is missing or invalid.");
  }

  if (config.STARS_PRICE_AMOUNT <= 0) {
    errors.push("STARS_PRICE_AMOUNT must be greater than zero.");
  }

  if (config.TELEGRAM_RETRO_FORUM_CHAT_ID === config.VIP_COLLECTIONS_CHAT_ID && config.TELEGRAM_RETRO_FORUM_CHAT_ID !== 0) {
    errors.push("TELEGRAM_RETRO_FORUM_CHAT_ID must differ from VIP_COLLECTIONS_CHAT_ID.");
  }

  if (
    config.TELEGRAM_PUBLIC_LOBBY_CHAT_ID !== 0 &&
    [config.VIP_COLLECTIONS_CHAT_ID, config.TELEGRAM_RETRO_FORUM_CHAT_ID, config.TELEGRAM_AMATEUR_FORUM_CHAT_ID, config.TELEGRAM_AMATEUR_CHAT_ID, config.TELEGRAM_ADMIN_REVIEW_CHAT_ID, config.WANTED_LIST_CHAT_ID, config.GENERAL_CHAT_ID].includes(
      config.TELEGRAM_PUBLIC_LOBBY_CHAT_ID
    )
  ) {
    errors.push("TELEGRAM_PUBLIC_LOBBY_CHAT_ID must be a separate PUBLIC group, never one of the private member spaces.");
  }

  if (config.RETRO_PLUS_STARS_PRICE_AMOUNT < 0 || !Number.isInteger(config.RETRO_PLUS_STARS_PRICE_AMOUNT)) {
    errors.push("RETRO_PLUS_STARS_PRICE_AMOUNT must be a non-negative integer (0 keeps Retro Plus billing disabled).");
  }

  if (config.STARS_SUBSCRIPTION_PERIOD_SECONDS <= 0) {
    errors.push("STARS_SUBSCRIPTION_PERIOD_SECONDS must be greater than zero.");
  }

  if (config.BOT_MODE === "webhook") {
    // Without the secret, anyone who finds the URL can forge updates — including
    // `successful_payment` — and grant themselves membership. Required in EVERY
    // environment, not just production.
    if (!config.WEBHOOK_SECRET) {
      errors.push("WEBHOOK_SECRET is required in webhook mode (Telegram secret_token, 1-256 chars of A-Z a-z 0-9 _ -).");
    } else if (!/^[A-Za-z0-9_-]{16,256}$/.test(config.WEBHOOK_SECRET)) {
      errors.push("WEBHOOK_SECRET must be 16-256 characters of A-Z a-z 0-9 _ - (Telegram's allowed secret_token alphabet).");
    }
  }

  if (config.STARS_SUBSCRIPTION_PERIOD_SECONDS !== 2592000) {
    errors.push("STARS_SUBSCRIPTION_PERIOD_SECONDS must be 2592000: Telegram only accepts a 30-day subscription_period.");
  }
  if (config.STARS_PRICE_AMOUNT > 10000) {
    errors.push("STARS_PRICE_AMOUNT exceeds Telegram's 10000-Star subscription maximum.");
  }

  if (config.CURRENCY !== "XTR") {
    errors.push("CURRENCY must be XTR (Telegram Stars) for the Stars payment provider.");
  }

  const chatIds = [
    config.VIP_COLLECTIONS_CHAT_ID,
    config.TELEGRAM_RETRO_FORUM_CHAT_ID,
    config.TELEGRAM_AMATEUR_FORUM_CHAT_ID,
    config.TELEGRAM_AMATEUR_CHAT_ID,
    config.TELEGRAM_ADMIN_REVIEW_CHAT_ID,
    config.PUBLIC_DIRECTORY_CHAT_ID,
    config.WANTED_LIST_CHAT_ID,
    config.GENERAL_CHAT_ID,
  ].filter(Boolean);
  if (new Set(chatIds).size !== chatIds.length) {
    errors.push("Creator forums, the public directory, Wanted List and General Chat must use different chats.");
  }

  return errors;
}

/**
 * Errors that make it unsafe to serve traffic at all (regardless of DENO_ENV).
 */
export function fatalConfigErrors(config: AppConfig): string[] {
  return validateConfig(config).filter(
    (e) =>
      e.startsWith("BOT_TOKEN") ||
      e.startsWith("WEBHOOK_SECRET") ||
      e.startsWith("ADMIN_USER_IDS")
  );
}

/** Local hour (America/Toronto) at which the daily directory/wanted sync runs. */
export function getDailySyncHour(config: AppConfig = getConfig()): number {
  const m = /^\s*\d+\s+(\d{1,2})\s+\*\s+\*\s+\*\s*$/.exec(config.DIRECTORY_UPDATE_CRON);
  const hour = m ? Number(m[1]) : 3;
  return hour >= 0 && hour <= 23 ? hour : 3;
}

export function isAdministrator(userId: number, config: AppConfig = getConfig()): boolean {
  return config.ADMIN_USER_IDS.includes(userId);
}

export function getChatIdForSpace(spaceId: SpaceId, config: AppConfig = getConfig()): number {
  switch (spaceId) {
    case "vip_collections":
      return config.VIP_COLLECTIONS_CHAT_ID;
    case "retro_collections":
      return config.TELEGRAM_RETRO_FORUM_CHAT_ID;
    case "amateur_chat":
      return config.TELEGRAM_AMATEUR_CHAT_ID;
    case "amateur_collections":
      return config.TELEGRAM_AMATEUR_FORUM_CHAT_ID;
    case "wanted_list":
      return config.WANTED_LIST_CHAT_ID;
    case "general_chat":
      return config.GENERAL_CHAT_ID;
  }
}

export function getSpaceIdForChatId(chatId: number, config: AppConfig = getConfig()): SpaceId | null {
  if (chatId === config.VIP_COLLECTIONS_CHAT_ID) return "vip_collections";
  if (config.TELEGRAM_RETRO_FORUM_CHAT_ID && chatId === config.TELEGRAM_RETRO_FORUM_CHAT_ID) {
    return "retro_collections";
  }
  if (config.TELEGRAM_AMATEUR_CHAT_ID && chatId === config.TELEGRAM_AMATEUR_CHAT_ID) return "amateur_chat";
  if (chatId === config.WANTED_LIST_CHAT_ID) return "wanted_list";
  if (config.TELEGRAM_AMATEUR_FORUM_CHAT_ID && chatId === config.TELEGRAM_AMATEUR_FORUM_CHAT_ID) return "amateur_collections";
  if (chatId === config.GENERAL_CHAT_ID) return "general_chat";
  return null;
}
