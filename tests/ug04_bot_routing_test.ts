/**
 * LA CONFRÉRIE — UG-04 Pre-Publish Test Suite: BOT ROUTING, MENUS & TIER-GATED LINKS
 * Drives the real assembled bot with a fake Telegram transport (no network).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { MOCK_CONFIG, setupTestEnvironment } from "./test_helpers.ts";
import { pay, seedCreator } from "./ug04_helpers.ts";
import { setConfigForTesting } from "../src/config.ts";
import { createBot } from "../src/bot/bot.ts";

interface Call {
  method: string;
  payload: Record<string, unknown>;
}

function makeBot() {
  const bot = createBot("123456:TEST_TOKEN");
  // deno-lint-ignore no-explicit-any
  (bot as any).botInfo = {
    id: 999999, is_bot: true, first_name: "Bot", username: "UndergroundManagerBot",
    can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
    can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false,
    allows_users_to_create_topics: false,
  };
  const calls: Call[] = [];
  bot.api.config.use((_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    const msg = { message_id: 1, date: 0, chat: { id: 1, type: "private" }, text: "x" };
    if (method === "createInvoiceLink") return Promise.resolve({ ok: true, result: "https://t.me/$invoice" } as never);
    if (method === "createChatInviteLink") return Promise.resolve({ ok: true, result: { invite_link: "https://t.me/+x" } } as never);
    return Promise.resolve({ ok: true, result: method.startsWith("edit") || method.startsWith("send") ? msg : true } as never);
  });
  return { bot, calls };
}

let updateId = 1000;
function cb(userId: number, data: string) {
  return {
    update_id: updateId++,
    callback_query: {
      id: `cbq${updateId}`,
      from: { id: userId, is_bot: false, first_name: "U" },
      chat_instance: "ci",
      data,
      message: { message_id: 7, date: 0, chat: { id: userId, type: "private" as const, first_name: "U" }, text: "menu" },
    },
  };
}
function cmd(userId: number, text: string) {
  const len = text.split(" ")[0].length;
  return {
    update_id: updateId++,
    message: {
      message_id: updateId,
      date: 0,
      chat: { id: userId, type: "private" as const, first_name: "U" },
      from: { id: userId, is_bot: false, first_name: "U" },
      text,
      entities: [{ type: "bot_command" as const, offset: 0, length: len }],
    },
  };
}
const texts = (calls: Call[], m: string) => calls.filter((c) => c.method === m).map((c) => String(c.payload.text ?? ""));

Deno.test("UG04 ROUTING — Members reach Wanted List and Plans (admin guard no longer swallows member updates)", async () => {
  const kv = await setupTestEnvironment();
  try {
    const { bot, calls } = makeBot();
    await bot.handleUpdate(cb(5000, "wanted:menu") as never);
    assertStringIncludes(texts(calls, "editMessageText").join("\n"), "LA CONFRÉRIE | LISTE DE SOUHAITS");

    calls.length = 0;
    await bot.handleUpdate(cb(5000, "member:plans") as never);
    const plans = texts(calls, "editMessageText").join("\n");
    assertStringIncludes(plans, "Regular");
    assertStringIncludes(plans, "Retro Plus");
    assertStringIncludes(plans, "1500 Étoiles");
    assert(!/underground/i.test(plans));
  } finally {
    await kv.close();
  }
});

Deno.test("UG04 ROUTING — Administrator routes (admin:, mig:, migration commands) stay admin-only", async () => {
  const kv = await setupTestEnvironment();
  try {
    const { bot, calls } = makeBot();
    for (const data of ["admin:menu", "mig:pick", "mig:list", "admin:plans", "admin:repair_dir"]) {
      calls.length = 0;
      await bot.handleUpdate(cb(5000, data) as never);
      assertEquals(texts(calls, "editMessageText").length, 0, data);
      assertEquals(calls.some((c) => c.method === "answerCallbackQuery" && c.payload.show_alert === true), true, data);
    }
    for (const text of ["/admin", "/index_media Aria https://t.me/c/1/2/3", "/move_to_retro Aria", "/relink_creator Aria 5"]) {
      calls.length = 0;
      await bot.handleUpdate(cmd(5000, text) as never);
      assertStringIncludes(texts(calls, "sendMessage").join("\n"), "Accès refusé");
    }

    // Admin passes
    calls.length = 0;
    await bot.handleUpdate(cb(111111, "mig:pick") as never);
    assertStringIncludes(texts(calls, "editMessageText").join("\n"), "PASSER À RETRO");
    calls.length = 0;
    await bot.handleUpdate(cb(111111, "admin:menu") as never);
    assertStringIncludes(texts(calls, "editMessageText").join("\n"), "LA CONFRÉRIE | ADMIN");
  } finally {
    await kv.close();
  }
});

Deno.test("UG04 ROUTING — Retro creator deep link is only issued to Retro Plus members", async () => {
  const kv = await setupTestEnvironment();
  try {
    const retroCreator = await seedCreator({ name: "Maya", topicId: 321, collection: "retro" });
    const regularCreator = await seedCreator({ name: "Aria", topicId: 322, collection: "regular" });
    await pay(5101, "regular", "ch_route_reg");
    await pay(5102, "retro_plus", "ch_route_retro");

    const urlsFor = (calls: Call[]) =>
      JSON.stringify(calls.filter((c) => c.method === "sendMessage").map((c) => c.payload.reply_markup));

    // Anonymous visitor: no topic link at all
    let r = makeBot();
    await r.bot.handleUpdate(cmd(5100, `/start creator_${retroCreator.id}`) as never);
    assert(!urlsFor(r.calls).includes("t.me/c/"));

    // Regular member: no Retro link, sees upgrade
    r = makeBot();
    await r.bot.handleUpdate(cmd(5101, `/start creator_${retroCreator.id}`) as never);
    assert(!urlsFor(r.calls).includes("t.me/c/"));
    assertStringIncludes(urlsFor(r.calls), "member:upgrade");

    // ... but does get the Regular creator's link
    r = makeBot();
    await r.bot.handleUpdate(cmd(5101, `/start creator_${regularCreator.id}`) as never);
    assertStringIncludes(urlsFor(r.calls), `t.me/c/1001/${regularCreator.topicId}`);

    // Retro Plus member gets the Retro link (Retro forum chat id 1005)
    r = makeBot();
    await r.bot.handleUpdate(cmd(5102, `/start creator_${retroCreator.id}`) as never);
    assertStringIncludes(urlsFor(r.calls), `t.me/c/1005/${retroCreator.topicId}`);
  } finally {
    await kv.close();
  }
});

Deno.test("UG04 ROUTING — Retro Plus checkout is unavailable until its price is configured", async () => {
  const kv = await setupTestEnvironment();
  try {
    setConfigForTesting({ ...MOCK_CONFIG, RETRO_PLUS_STARS_PRICE_AMOUNT: 0 });
    const { bot, calls } = makeBot();
    await bot.handleUpdate(cb(5200, "member:pay:retro_plus") as never);
    assertEquals(calls.some((c) => c.method === "createInvoiceLink"), false);
    assertStringIncludes(texts(calls, "sendMessage").join("\n"), "pas encore disponible");

    // Plans screen says "Bientôt disponible" and offers no Retro Plus buy button
    calls.length = 0;
    await bot.handleUpdate(cb(5200, "member:plans") as never);
    assertStringIncludes(texts(calls, "editMessageText").join("\n"), "Bientôt disponible");
    assert(!JSON.stringify(calls).includes("member:pay:retro_plus"));
  } finally {
    await kv.close();
  }
});

Deno.test("UG04 ROUTING — Regular checkout builds a Regular invoice; Regular subscribers are routed through the confirmed upgrade", async () => {
  const kv = await setupTestEnvironment();
  try {
    let r = makeBot();
    await r.bot.handleUpdate(cb(5300, "member:pay:regular") as never);
    const inv = r.calls.find((c) => c.method === "createInvoiceLink")!;
    assertEquals(inv.payload.title, "LA CONFRÉRIE Regular");
    assertStringIncludes(String(inv.payload.payload), "vip_monthly");

    await pay(5301, "regular", "ch_route_up", { expiresInDays: 15 });
    r = makeBot();
    await r.bot.handleUpdate(cb(5301, "member:pay:retro_plus") as never);
    // Not an invoice yet: the user must first see price/effective date and confirm
    assertEquals(r.calls.some((c) => c.method === "createInvoiceLink"), false);
    const shown = texts(r.calls, "editMessageText").join("\n");
    assertStringIncludes(shown, "1500 Étoiles");
    assertStringIncludes(shown, "Rien n'est annulé tant que votre paiement Retro Plus n'est pas vérifié");

    r = makeBot();
    await r.bot.handleUpdate(cb(5301, "member:upg_cfm:1") as never);
    const retroInv = r.calls.find((c) => c.method === "createInvoiceLink")!;
    assertStringIncludes(String(retroInv.payload.payload), "retro_plus_monthly");
    assertEquals(r.calls.some((c) => c.method === "editUserStarSubscription"), false); // nothing cancelled yet
  } finally {
    await kv.close();
  }
});

Deno.test("UG04 ROUTING — Separate directory messages and filters respond for members", async () => {
  const kv = await setupTestEnvironment();
  try {
    await seedCreator({ name: "Aria", topicId: 1, collection: "regular" });
    await seedCreator({ name: "Maya", topicId: 2, collection: "retro" });
    const { bot, calls } = makeBot();
    await bot.handleUpdate(cb(5400, "dir:all") as never);
    let t = [...texts(calls, "editMessageText"), ...texts(calls, "sendMessage")].join("\n");
    assertStringIncludes(t, "Aria");
    assertStringIncludes(t, "Maya");

    calls.length = 0;
    await bot.handleUpdate(cb(5400, "dir:retro") as never);
    t = texts(calls, "editMessageText").join("\n");
    assertStringIncludes(t, "Maya");
    assert(!t.includes("Aria"));
  } finally {
    await kv.close();
  }
});
