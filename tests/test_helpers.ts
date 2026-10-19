/**
 * LA CONFRÉRIE — Test Helpers & Mock Telegram API
 */

import { setConfigForTesting, AppConfig } from "../src/config.ts";
import { setKvForTesting } from "../src/db/kv.ts";
import { SpaceId } from "../src/types.ts";

export const MOCK_CONFIG: AppConfig = {
  BOT_TOKEN: "123456789:ABCDEF_mock_token_for_tests",
  BOT_USERNAME: "UndergroundManagerBot",
  WEBHOOK_SECRET: "test_secret_token_12345",
  ADMIN_USER_IDS: [111111, 222222],
  VIP_COLLECTIONS_CHAT_ID: -1001001,
  TELEGRAM_RETRO_FORUM_CHAT_ID: -1001005,
  PUBLIC_DIRECTORY_CHAT_ID: -1001004,
  WANTED_LIST_CHAT_ID: -1001002,
  GENERAL_CHAT_ID: -1001003,
  CLUB_DISPLAY_NAME: "LA CONFRÉRIE",
  STARS_PRICE_AMOUNT: 750,
  RETRO_PLUS_STARS_PRICE_AMOUNT: 1500, // test-only value; production price is NOT hardcoded
  STARS_SUBSCRIPTION_PERIOD_SECONDS: 2592000, // 30 days
  CURRENCY: "XTR",
  BOT_MODE: "webhook",
  PORT: 8000,
  DENO_ENV: "test",
  SUPPORT_USERNAME: "@TestUndergroundSupport",
  DIRECTORY_UPDATE_CRON: "0 3 * * *",
  VOTING_PERIOD_DAYS: 5,
  VOTING_SHORTLIST_SIZE: 5,
  DIGEST_ENABLED: false,
  BASE_CURRENCY: "CAD",
  DEFAULT_STARS_REWARD_VALUATION_USD: 0.013,
  TREASURY_REPORT_CHANNEL_ID: -1001002,
  EXCHANGE_RATE_API_URL: "", // disabled in tests: no network, deterministic built-in rates
  MIGRATION_BATCH_SIZE: 30,
  MIGRATION_BATCH_DELAY_MS: 0,
};

export async function setupTestEnvironment(): Promise<Deno.Kv> {
  const kv = await Deno.openKv(":memory:");
  setKvForTesting(kv);
  setConfigForTesting({ ...MOCK_CONFIG });
  return kv;
}

export class MockTelegramApi {
  public approvedJoinRequests: { chatId: number | string; userId: number }[] = [];
  public declinedJoinRequests: { chatId: number | string; userId: number }[] = [];
  public bannedMembers: { chatId: number | string; userId: number }[] = [];
  public unbannedMembers: { chatId: number | string; userId: number }[] = [];
  public sentMessages: { chatId: number | string; text: string; options?: unknown }[] = [];
  public createdInviteLinks: { chatId: number | string; options: unknown }[] = [];

  public mockMemberStatus: Map<string, { status: string; can_invite_users?: boolean; can_restrict_members?: boolean }> =
    new Map();

  async getMe() {
    return { id: 999999, username: "UndergroundManagerBot" };
  }

  async createChatInviteLink(chatId: number | string, options: { name?: string; creates_join_request?: boolean }) {
    this.createdInviteLinks.push({ chatId, options });
    return { invite_link: `https://t.me/+mock_invite_${chatId}` };
  }

  async approveChatJoinRequest(chatId: number | string, userId: number): Promise<boolean> {
    this.approvedJoinRequests.push({ chatId, userId });
    return true;
  }

  async declineChatJoinRequest(chatId: number | string, userId: number): Promise<boolean> {
    this.declinedJoinRequests.push({ chatId, userId });
    return true;
  }

  async getChatMember(chatId: number | string, userId: number) {
    const key = `${chatId}:${userId}`;
    if (this.mockMemberStatus.has(key)) {
      return this.mockMemberStatus.get(key)!;
    }
    // Default: regular member, or administrator if bot itself
    if (userId === 999999) {
      return { status: "administrator", can_invite_users: true, can_restrict_members: true };
    }
    return { status: "member" };
  }

  async banChatMember(chatId: number | string, userId: number): Promise<boolean> {
    this.bannedMembers.push({ chatId, userId });
    return true;
  }

  async unbanChatMember(chatId: number | string, userId: number): Promise<boolean> {
    this.unbannedMembers.push({ chatId, userId });
    return true;
  }

  async sendMessage(chatId: number | string, text: string, options?: unknown) {
    const messageId = this.sentMessages.length + 1;
    this.sentMessages.push({ chatId, text, options });
    return { message_id: messageId, chat: { id: chatId }, text };
  }

  public editedMessages: { chatId: number | string; messageId: number; text: string; options?: unknown }[] = [];

  async editMessageText(chatId: number | string, messageId: number, text: string, options?: unknown) {
    this.editedMessages.push({ chatId, messageId, text, options });
    return { message_id: messageId, chat: { id: chatId }, text };
  }

  async pinChatMessage(chatId: number | string, messageId: number) {
    return true;
  }
}
