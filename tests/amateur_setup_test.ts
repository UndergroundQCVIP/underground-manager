import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { MOCK_CONFIG, setupTestEnvironment } from "./test_helpers.ts";
import {
  createFakeTelegram,
  groupMessage,
  privateMessage,
} from "./bot_harness.ts";
import { getConfig, setConfigForTesting } from "../src/config.ts";
import { bindPrivateChat } from "../src/db/chat_bindings.ts";
import { refreshAmateurConfiguration } from "../src/db/amateur.ts";

const BASIC = -234567,
  UPGRADED = -100234567,
  ADMIN = MOCK_CONFIG.ADMIN_USER_IDS[0];
function command(chatId = BASIC, text = "/setup_amateur_chat") {
  return {
    message: {
      ...groupMessage(chatId, ADMIN, text).message,
      entities: [{
        type: "bot_command",
        offset: 0,
        length: text.split(/\s/)[0].length,
      }],
    },
  };
}

Deno.test("AMATEUR SETUP — ordinary private groups bind successfully and preserve chat permissions/webhook events", async () => {
  const kv = await setupTestEnvironment();
  try {
    const tg = await createFakeTelegram();
    tg.bot.api.config.use((prev, method, payload, signal) => {
      if (method === "getChat") {
        return Promise.resolve(
          {
            ok: true,
            result: {
              id: BASIC,
              type: "group",
              title: "Amateur Chat",
              permissions: {
                can_send_messages: true,
                can_send_videos: true,
                can_invite_users: true,
              },
            },
          } as never,
        );
      }
      if (method === "getWebhookInfo") {
        return Promise.resolve(
          {
            ok: true,
            result: {
              url: "https://bot.example/webhook",
              allowed_updates: [
                "message",
                "callback_query",
                "pre_checkout_query",
              ],
            },
          } as never,
        );
      }
      return prev(method, payload, signal);
    });
    await tg.send(command());
    assertEquals(getConfig().TELEGRAM_AMATEUR_CHAT_ID, BASIC);
    const invite = tg.callsOf("createChatInviteLink").at(-1)!.payload;
    assertEquals(invite.chat_id, BASIC);
    assertEquals(invite.creates_join_request, true);
    assert(Array.from(String(invite.name)).length <= 32);
    assertStringIncludes(
      String(tg.callsOf("sendMessage").at(-1)!.payload.text),
      "✅ Clavardage Amateur configuré",
    );
    const permissions = tg.callsOf("setChatPermissions")[0].payload
      .permissions as Record<string, unknown>;
    assertEquals(permissions.can_send_messages, true);
    assertEquals(permissions.can_send_videos, true);
    assertEquals(permissions.can_invite_users, false);
    const updates = tg.callsOf("setWebhook")[0].payload
      .allowed_updates as string[];
    for (
      const name of [
        "message",
        "callback_query",
        "pre_checkout_query",
        "chat_join_request",
        "chat_member",
      ]
    ) assert(updates.includes(name));
    setConfigForTesting({ ...MOCK_CONFIG });
    await refreshAmateurConfiguration();
    assertEquals(getConfig().TELEGRAM_AMATEUR_CHAT_ID, BASIC);
  } finally {
    await kv.close();
  }
});

Deno.test("AMATEUR SETUP — private numeric-ID setup works and getChat errors produce a useful reply", async () => {
  const kv = await setupTestEnvironment();
  try {
    const tg = await createFakeTelegram();
    let unavailable = true;
    tg.bot.api.config.use((prev, method, payload, signal) => {
      if (method === "getChat") {
        return unavailable
          ? Promise.resolve(
            {
              ok: false,
              error_code: 400,
              description: "Bad Request: chat not found",
            } as never,
          )
          : Promise.resolve(
            {
              ok: true,
              result: {
                id: BASIC,
                type: "group",
                title: "Amateur",
                permissions: { can_send_messages: true },
              },
            } as never,
          );
      }
      if (method === "getWebhookInfo") {
        return Promise.resolve({ ok: true, result: { url: "" } } as never);
      }
      return prev(method, payload, signal);
    });
    await tg.send(privateMessage(ADMIN, `/setup_amateur_chat ${BASIC}`));
    assertStringIncludes(
      String(tg.callsOf("sendMessage").at(-1)!.payload.text),
      "Configuration impossible (lecture du groupe)",
    );
    assertEquals(getConfig().TELEGRAM_AMATEUR_CHAT_ID, 0);
    unavailable = false;
    await tg.send(privateMessage(ADMIN, `/setup_amateur_chat ${BASIC}`));
    assertEquals(getConfig().TELEGRAM_AMATEUR_CHAT_ID, BASIC);
    assertEquals(tg.callsOf("sendMessage").at(-1)!.payload.chat_id, ADMIN);
  } finally {
    await kv.close();
  }
});

Deno.test("AMATEUR SETUP — missing permissions never bind or accidentally silence members", async () => {
  const kv = await setupTestEnvironment();
  try {
    const tg = await createFakeTelegram();
    let missingRights = true;
    tg.bot.api.config.use((prev, method, payload, signal) => {
      if (method === "getChat") {
        return Promise.resolve(
          {
            ok: true,
            result: { id: BASIC, type: "group", title: "Amateur" },
          } as never,
        );
      }
      if (method === "getChatMember" && missingRights) {
        return Promise.resolve(
          {
            ok: true,
            result: {
              status: "administrator",
              can_invite_users: true,
              can_restrict_members: false,
            },
          } as never,
        );
      }
      return prev(method, payload, signal);
    });
    await tg.send(command());
    assertStringIncludes(
      String(tg.callsOf("sendMessage").at(-1)!.payload.text),
      "Bannir/restreindre",
    );
    missingRights = false;
    await tg.send(command());
    assertStringIncludes(
      String(tg.callsOf("sendMessage").at(-1)!.payload.text),
      "permissions actuelles",
    );
    assertEquals(tg.callsOf("setChatPermissions").length, 0);
    assertEquals(getConfig().TELEGRAM_AMATEUR_CHAT_ID, 0);
  } finally {
    await kv.close();
  }
});

Deno.test("AMATEUR SETUP — anonymous admins receive guidance without bypassing configured-admin authorization", async () => {
  const kv = await setupTestEnvironment();
  try {
    const tg = await createFakeTelegram();
    const update = command();
    update.message.from.id = 1087968824;
    await tg.send({
      message: {
        ...update.message,
        sender_chat: { id: BASIC, type: "group", title: "Anonymous" },
      },
    });
    assertStringIncludes(
      String(tg.callsOf("sendMessage").at(-1)!.payload.text),
      "profil personnel",
    );
    assertEquals(tg.callsOf("getChatMember").length, 0);
    assertEquals(getConfig().TELEGRAM_AMATEUR_CHAT_ID, 0);
  } finally {
    await kv.close();
  }
});

Deno.test("AMATEUR SETUP — Telegram migration responses retry the new group and move an existing binding", async () => {
  const kv = await setupTestEnvironment();
  try {
    await bindPrivateChat("amateur_chat", BASIC, ADMIN);
    const tg = await createFakeTelegram();
    tg.bot.api.config.use((prev, method, payload, signal) => {
      if (method === "getChat") {
        return Number((payload as { chat_id: number }).chat_id) === BASIC
          ? Promise.resolve(
            {
              ok: false,
              error_code: 400,
              description: "Bad Request: group chat was upgraded",
              parameters: { migrate_to_chat_id: UPGRADED },
            } as never,
          )
          : Promise.resolve(
            {
              ok: true,
              result: {
                id: UPGRADED,
                type: "supergroup",
                title: "Amateur",
                permissions: { can_send_messages: true },
              },
            } as never,
          );
      }
      if (method === "getWebhookInfo") {
        return Promise.resolve({ ok: true, result: { url: "" } } as never);
      }
      return prev(method, payload, signal);
    });
    await tg.send(command());
    assertEquals(getConfig().TELEGRAM_AMATEUR_CHAT_ID, UPGRADED);
    assertEquals(
      tg.callsOf("setChatPermissions").at(-1)!.payload.chat_id,
      UPGRADED,
    );
    assertEquals(tg.callsOf("sendMessage").at(-1)!.payload.chat_id, UPGRADED);
    setConfigForTesting({ ...MOCK_CONFIG });
    await refreshAmateurConfiguration();
    assertEquals(getConfig().TELEGRAM_AMATEUR_CHAT_ID, UPGRADED);
  } finally {
    await kv.close();
  }
});

Deno.test("AMATEUR SETUP — later group upgrades preserve the Amateur chat binding", async () => {
  const kv = await setupTestEnvironment();
  try {
    await bindPrivateChat("amateur_chat", BASIC, ADMIN);
    const tg = await createFakeTelegram();
    tg.bot.api.config.use((prev, method, payload, signal) =>
      method === "getChat"
        ? Promise.resolve(
          {
            ok: true,
            result: { id: UPGRADED, type: "supergroup", title: "Amateur" },
          } as never,
        )
        : prev(method, payload, signal)
    );
    await tg.send({
      message: {
        ...groupMessage(BASIC, ADMIN, "").message,
        migrate_to_chat_id: UPGRADED,
      },
    });
    assertEquals(getConfig().TELEGRAM_AMATEUR_CHAT_ID, UPGRADED);
    setConfigForTesting({ ...MOCK_CONFIG });
    await refreshAmateurConfiguration();
    assertEquals(getConfig().TELEGRAM_AMATEUR_CHAT_ID, UPGRADED);
  } finally {
    await kv.close();
  }
});
