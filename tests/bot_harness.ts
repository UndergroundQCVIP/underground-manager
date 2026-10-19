/**
 * Underground Manager — Full-pipeline bot harness.
 *
 * Builds the REAL grammY bot (all middlewares and composers, exactly as production
 * wires them) and replaces only the HTTP transport with an in-memory fake of the
 * Telegram Bot API. Updates are pushed through `bot.handleUpdate`, so tests exercise
 * routing, authorization gates, idempotency and handlers together — not just the
 * service functions in isolation.
 */

import { Bot } from "grammy";
import { createBot } from "../src/bot/bot.ts";

export interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}

export interface FakeTelegram {
  bot: Bot;
  calls: ApiCall[];
  /** Calls of one method. */
  callsOf(method: string): ApiCall[];
  /** Per `${chatId}:${userId}` getChatMember status override. */
  memberStatus: Map<string, string>;
  /** Methods that should fail (name -> error description), e.g. to simulate outages. */
  failing: Map<string, string>;
  /** Canned getStarTransactions pages: array of full responses served in order of offset. */
  starTransactions: unknown[];
  send(update: Record<string, unknown>): Promise<void>;
  reset(): void;
}

let updateCounter = 1000;
let messageCounter = 1;

export function nextUpdateId(): number {
  return ++updateCounter;
}

export async function createFakeTelegram(): Promise<FakeTelegram> {
  const bot = createBot("123456:TEST_TOKEN_FOR_HARNESS");
  bot.botInfo = {
    id: 999999,
    is_bot: true,
    first_name: "Underground Manager",
    username: "UndergroundManagerBot",
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
  } as unknown as typeof bot.botInfo;

  const calls: ApiCall[] = [];
  const memberStatus = new Map<string, string>();
  const failing = new Map<string, string>();
  const state: FakeTelegram = {
    bot,
    calls,
    callsOf: (method) => calls.filter((c) => c.method === method),
    memberStatus,
    failing,
    starTransactions: [],
    send: async (update) => {
      await bot.handleUpdate({ update_id: nextUpdateId(), ...update } as never);
    },
    reset: () => {
      calls.length = 0;
    },
  };

  bot.api.config.use((_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });

    const failure = failing.get(method);
    if (failure) {
      return Promise.resolve({ ok: false as const, error_code: 500, description: failure });
    }

    const p = payload as Record<string, unknown>;
    let result: unknown = true;
    switch (method) {
      case "getMe":
        result = bot.botInfo;
        break;
      case "sendMessage":
      case "editMessageText":
        result = {
          message_id: ++messageCounter,
          date: Math.floor(Date.now() / 1000),
          chat: { id: p.chat_id ?? 0, type: "private" },
          text: p.text,
        };
        break;
      case "createChatInviteLink":
        result = { invite_link: `https://t.me/+invite_${p.chat_id}`, creator: bot.botInfo, creates_join_request: true, is_primary: false, is_revoked: false };
        break;
      case "createInvoiceLink":
        result = `https://t.me/$invoice_${messageCounter}`;
        break;
      case "getChatMember": {
        const status = memberStatus.get(`${p.chat_id}:${p.user_id}`) ??
          (p.user_id === 999999 ? "administrator" : "member");
        result = {
          status,
          user: { id: p.user_id, is_bot: p.user_id === 999999, first_name: "u" },
          can_invite_users: true,
          can_restrict_members: true,
        };
        break;
      }
      case "getStarTransactions": {
        const offset = Number(p.offset ?? 0);
        const all = state.starTransactions as unknown[];
        result = { transactions: all.slice(offset, offset + Number(p.limit ?? 100)) };
        break;
      }
    }
    return Promise.resolve({ ok: true as const, result: result as never });
  });

  await Promise.resolve();
  return state;
}

// ---------------------------------------------------------------------------
// Update builders
// ---------------------------------------------------------------------------

export function user(id: number, name = `User${id}`) {
  return { id, is_bot: false, first_name: name, username: `user${id}` };
}

export function privateMessage(userId: number, text: string) {
  const entities = text.startsWith("/")
    ? [{ type: "bot_command", offset: 0, length: text.split(/\s/)[0].length }]
    : undefined;
  return {
    message: {
      message_id: ++messageCounter,
      date: Math.floor(Date.now() / 1000),
      chat: { id: userId, type: "private", first_name: `User${userId}` },
      from: user(userId),
      text,
      entities,
    },
  };
}

export function groupMessage(chatId: number, userId: number, text: string) {
  return {
    message: {
      message_id: ++messageCounter,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: "supergroup", title: "Group" },
      from: user(userId),
      text,
    },
  };
}

export function callback(userId: number, data: string) {
  return {
    callback_query: {
      id: `cb_${++messageCounter}`,
      from: user(userId),
      chat_instance: "ci",
      data,
      message: {
        message_id: ++messageCounter,
        date: Math.floor(Date.now() / 1000),
        chat: { id: userId, type: "private", first_name: `User${userId}` },
        from: { id: 999999, is_bot: true, first_name: "Underground Manager", username: "UndergroundManagerBot" },
        text: "menu",
      },
    },
  };
}

export function successfulPayment(
  userId: number,
  opts: {
    chargeId: string;
    payload: string;
    amount?: number;
    expiresUnix?: number;
    recurring?: boolean;
    first?: boolean;
  }
) {
  return {
    message: {
      message_id: ++messageCounter,
      date: Math.floor(Date.now() / 1000),
      chat: { id: userId, type: "private", first_name: `User${userId}` },
      from: user(userId),
      successful_payment: {
        currency: "XTR",
        total_amount: opts.amount ?? 750,
        invoice_payload: opts.payload,
        telegram_payment_charge_id: opts.chargeId,
        provider_payment_charge_id: `prov_${opts.chargeId}`,
        subscription_expiration_date: opts.expiresUnix,
        is_recurring: opts.recurring === false ? undefined : true,
        is_first_recurring: opts.first ? true : undefined,
      },
    },
  };
}

export function chatJoinRequest(chatId: number, userId: number) {
  return {
    chat_join_request: {
      chat: { id: chatId, type: "supergroup", title: "Space" },
      from: user(userId),
      user_chat_id: userId,
      date: Math.floor(Date.now() / 1000),
    },
  };
}

export function forumMessage(
  chatId: number,
  userId: number,
  threadId: number,
  kind: "photo" | "video" | "text" | "topic_created" | "topic_edited",
  extra: { name?: string; date?: number } = {}
) {
  const base: Record<string, unknown> = {
    message_id: ++messageCounter,
    date: extra.date ?? Math.floor(Date.now() / 1000),
    chat: { id: chatId, type: "supergroup", title: "TOKEBEC VIP COLLECTIONS", is_forum: true },
    from: user(userId),
    message_thread_id: threadId,
    is_topic_message: true,
  };
  switch (kind) {
    case "photo":
      base.photo = [{ file_id: "p", file_unique_id: "pu", width: 10, height: 10 }];
      break;
    case "video":
      base.video = { file_id: "v", file_unique_id: "vu", width: 10, height: 10, duration: 1 };
      break;
    case "text":
      base.text = "hello";
      break;
    case "topic_created":
      base.forum_topic_created = { name: extra.name ?? "Creator", icon_color: 1 };
      break;
    case "topic_edited":
      base.forum_topic_edited = { name: extra.name };
      break;
  }
  return { message: base };
}

export function preCheckout(userId: number, payload: string, amount = 750) {
  return {
    pre_checkout_query: {
      id: `pcq_${++messageCounter}`,
      from: user(userId),
      currency: "XTR",
      total_amount: amount,
      invoice_payload: payload,
    },
  };
}

export function refundedPayment(userId: number, chargeId: string, payload: string, amount = 750) {
  return {
    message: {
      message_id: ++messageCounter,
      date: Math.floor(Date.now() / 1000),
      chat: { id: userId, type: "private", first_name: `User${userId}` },
      from: user(userId),
      refunded_payment: {
        currency: "XTR",
        total_amount: amount,
        invoice_payload: payload,
        telegram_payment_charge_id: chargeId,
      },
    },
  };
}
