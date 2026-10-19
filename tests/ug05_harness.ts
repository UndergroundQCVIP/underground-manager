/**
 * LA CONFRÉRIE — Test harness: drive the real assembled bot with a fake Telegram transport.
 */

import { createBot } from "../src/bot/bot.ts";

export interface Call {
  method: string;
  payload: Record<string, unknown>;
}

export function makeBot() {
  const bot = createBot("123456:TEST_TOKEN");
  // deno-lint-ignore no-explicit-any
  (bot as any).botInfo = {
    id: 999999, is_bot: true, first_name: "Bot", username: "UndergroundManagerBot",
    can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
    can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false,
    allows_users_to_create_topics: false,
  };
  const calls: Call[] = [];
  let nextTopic = 7000;
  let nextMsg = 100;
  bot.api.config.use((_prev, method, payload) => {
    const p = payload as Record<string, unknown>;
    calls.push({ method, payload: p });
    const msg = { message_id: nextMsg++, date: 0, chat: { id: 1, type: "private" }, text: "x" };
    switch (method) {
      case "createInvoiceLink":
        return Promise.resolve({ ok: true, result: "https://t.me/$invoice" } as never);
      case "createChatInviteLink":
        return Promise.resolve({ ok: true, result: { invite_link: `https://t.me/+invite${p.chat_id}` } } as never);
      case "createForumTopic":
        return Promise.resolve({ ok: true, result: { message_thread_id: nextTopic++, name: p.name } } as never);
      case "copyMessages":
        return Promise.resolve({ ok: true, result: (p.message_ids as number[]).map(() => ({ message_id: nextMsg++ })) } as never);
      default:
        return Promise.resolve({
          ok: true,
          result: method.startsWith("edit") || method.startsWith("send") ? msg : true,
        } as never);
    }
  });
  return { bot, calls };
}

let uid = 90000;
export const cb = (userId: number, data: string) => ({
  update_id: uid++,
  callback_query: {
    id: `c${uid}`, from: { id: userId, is_bot: false, first_name: "U" }, chat_instance: "x", data,
    message: { message_id: 7, date: 0, chat: { id: userId, type: "private" as const, first_name: "U" }, text: "m" },
  },
});
export const text = (userId: number, body: string) => {
  const isCmd = body.startsWith("/");
  return {
    update_id: uid++,
    message: {
      message_id: uid, date: 0,
      chat: { id: userId, type: "private" as const, first_name: "U" },
      from: { id: userId, is_bot: false, first_name: "U" },
      text: body,
      ...(isCmd ? { entities: [{ type: "bot_command" as const, offset: 0, length: body.split(" ")[0].length }] } : {}),
    },
  };
};
export const photo = (userId: number, messageId: number, groupId?: string) => ({
  update_id: uid++,
  message: {
    message_id: messageId, date: 0,
    chat: { id: userId, type: "private" as const, first_name: "U" },
    from: { id: userId, is_bot: false, first_name: "U" },
    photo: [{ file_id: "f", file_unique_id: "u", width: 1, height: 1 }],
    ...(groupId ? { media_group_id: groupId } : {}),
  },
});
export const preCheckout = (userId: number, payload: string, amount = 750) => ({
  update_id: uid++,
  pre_checkout_query: {
    id: `pc${uid}`, from: { id: userId, is_bot: false, first_name: "U" },
    currency: "XTR", total_amount: amount, invoice_payload: payload,
  },
});
export const joined = (calls: Call[], method: string) => calls.filter((c) => c.method === method);
export const sentTexts = (calls: Call[], method = "sendMessage") =>
  calls.filter((c) => c.method === method).map((c) => String(c.payload.text ?? ""));
