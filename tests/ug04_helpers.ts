/**
 * LA CONFRÉRIE — UG-04 test helpers: mock Bot API for plans & migration.
 */

import { MockTelegramApi, MOCK_CONFIG } from "./test_helpers.ts";
import { saveCreator } from "../src/db/creators.ts";
import { recordMediaIndex } from "../src/db/media_index.ts";
import { Creator } from "../src/types.ts";
import { TelegramStarsProvider } from "../src/payments/stars.ts";
import { MembershipPlanId } from "../src/types.ts";

export const REGULAR_CHAT = MOCK_CONFIG.VIP_COLLECTIONS_CHAT_ID;
export const RETRO_CHAT = MOCK_CONFIG.TELEGRAM_RETRO_FORUM_CHAT_ID;

export class MockMigrationApi extends MockTelegramApi {
  public chats = new Map<number, { is_forum?: boolean; has_protected_content?: boolean }>([
    [REGULAR_CHAT, { is_forum: true }],
    [RETRO_CHAT, { is_forum: true }],
  ]);
  public botRights: Record<number, Record<string, unknown>> = {};
  public copyCalls: { to: number; from: number; ids: number[]; thread?: number }[] = [];
  public createdTopics: { chatId: number; name: string; id: number }[] = [];
  public deletedTopics: { chatId: number; topicId: number }[] = [];
  public starSubscriptionEdits: { userId: number; chargeId: string; canceled: boolean }[] = [];

  /** Source message IDs that no longer exist (Telegram silently skips them). */
  public missingMessageIds = new Set<number>();
  /** Throw this for the next N copyMessages calls. */
  public failNextCopies: { count: number; error: unknown } | null = null;
  public protectedAtCopyTime = false;
  public delayMs = 0;
  private nextDest = 9000;
  private nextTopic = 500;

  override async getMe() {
    return { id: 999999, username: "UndergroundManagerBot" };
  }

  async getChat(chatId: number | string) {
    const c = this.chats.get(Number(chatId));
    if (!c) throw new Error("Bad Request: chat not found");
    return { id: Number(chatId), ...c };
  }

  override async getChatMember(chatId: number | string, userId: number) {
    if (userId === 999999) {
      return {
        status: "administrator",
        can_invite_users: true,
        can_restrict_members: true,
        can_manage_topics: true,
        can_delete_messages: true,
        ...(this.botRights[Number(chatId)] ?? {}),
      };
    }
    return super.getChatMember(chatId, userId);
  }

  async createForumTopic(chatId: number | string, name: string) {
    const id = this.nextTopic++;
    this.createdTopics.push({ chatId: Number(chatId), name, id });
    return { message_thread_id: id, name };
  }

  async editForumTopic(chatId: number | string, topicId: number, other?: { name?: string }) {
    const known = this.createdTopics.some((t) => t.chatId === Number(chatId) && t.id === topicId);
    if (!known) throw new Error("Bad Request: message thread not found");
    if (other?.name) throw new Error("Bad Request: TOPIC_NOT_MODIFIED");
    return true;
  }

  async deleteForumTopic(chatId: number | string, topicId: number) {
    this.deletedTopics.push({ chatId: Number(chatId), topicId });
    return true;
  }

  async copyMessages(
    chatId: number | string,
    fromChatId: number | string,
    ids: number[],
    other?: { message_thread_id?: number }
  ) {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    this.copyCalls.push({ to: Number(chatId), from: Number(fromChatId), ids: [...ids], thread: other?.message_thread_id });
    if (this.protectedAtCopyTime) throw { description: "Bad Request: CHAT_FORWARDS_RESTRICTED" };
    if (this.failNextCopies && this.failNextCopies.count > 0) {
      this.failNextCopies.count--;
      throw this.failNextCopies.error;
    }
    return ids
      .filter((id) => !this.missingMessageIds.has(id))
      .map(() => ({ message_id: this.nextDest++ }));
  }

  public deletedMessages: { chatId: number; ids: number[] }[] = [];
  async deleteMessages(chatId: number | string, ids: number[]) {
    this.deletedMessages.push({ chatId: Number(chatId), ids: [...ids] });
    return true;
  }

  async editUserStarSubscription(userId: number, chargeId: string, canceled: boolean) {
    this.starSubscriptionEdits.push({ userId, chargeId, canceled });
    return true;
  }
}

export interface SeedOptions {
  id?: string;
  name?: string;
  topicId?: number;
  /** Message IDs; ids that appear in `albums` share a media_group_id. */
  messageIds?: number[];
  albums?: number[][];
  inventory?: "complete" | "partial";
  collection?: "regular" | "retro";
  lastContentUpdatedAt?: string;
}

export async function seedCreator(opts: SeedOptions = {}): Promise<Creator> {
  const id = opts.id ?? crypto.randomUUID();
  const now = new Date().toISOString();
  const topicId = opts.topicId ?? 101;
  const collection = opts.collection ?? "regular";
  const chatId = collection === "retro" ? RETRO_CHAT : REGULAR_CHAT;
  const name = opts.name ?? "Aria";
  const creator: Creator = {
    id,
    name,
    normalizedName: name.toLowerCase(),
    chatId,
    topicId,
    topicCreatedAt: now,
    hasContent: true,
    lastContentUpdatedAt: opts.lastContentUpdatedAt ?? "2026-10-18T12:00:00.000Z",
    status: "active",
    collection,
    inventoryStatus: opts.inventory ?? "complete",
    createdAt: now,
    updatedAt: now,
  };
  await saveCreator(creator);

  const ids = opts.messageIds ?? [];
  const groupOf = new Map<number, string>();
  (opts.albums ?? []).forEach((album, i) => album.forEach((m) => groupOf.set(m, `grp${i}`)));
  for (const messageId of ids) {
    await recordMediaIndex({
      creatorId: id,
      chatId,
      topicId,
      messageId,
      kind: "photo",
      mediaGroupId: groupOf.get(messageId),
      hasCaption: messageId % 2 === 0,
      source: "live",
      recordedAt: now,
    });
  }
  return creator;
}

/** Drive a real Stars payment through the production code path. */
export async function pay(
  userId: number,
  planId: MembershipPlanId,
  chargeId: string,
  opts: { expiresInDays?: number; amount?: number } = {}
) {
  const provider = new TelegramStarsProvider();
  const amount = opts.amount ?? (planId === "retro_plus" ? MOCK_CONFIG.RETRO_PLUS_STARS_PRICE_AMOUNT : MOCK_CONFIG.STARS_PRICE_AMOUNT);
  return await provider.handleSuccessfulPayment(
    {
      currency: "XTR",
      total_amount: amount,
      invoice_payload: TelegramStarsProvider.buildInvoicePayload(userId, planId),
      telegram_payment_charge_id: chargeId,
      provider_payment_charge_id: `prov_${chargeId}`,
      subscription_expiration_date: opts.expiresInDays
        ? Math.floor(Date.now() / 1000) + opts.expiresInDays * 86400
        : undefined,
      is_recurring: true,
    },
    userId
  );
}
