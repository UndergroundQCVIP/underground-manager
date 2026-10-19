/**
 * LA CONFRÉRIE — Retro forum creator registration & directory visibility
 * Regression: pre-existing Retro topics could not be registered, so they never reached the directory.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { MockTelegramApi, setupTestEnvironment } from "./test_helpers.ts";
import { RETRO_CHAT, REGULAR_CHAT, seedCreator } from "./ug04_helpers.ts";
import { cb, makeBot, text } from "./ug05_harness.ts";
import { listCreators, getCreatorByTopic } from "../src/db/creators.ts";
import { listMediaIndex } from "../src/db/media_index.ts";
import { syncPublicDirectory } from "../src/directory/sync.ts";

const ADMIN = 111111;

function groupPhoto(chatId: number, userId: number, topicId: number, topicName: string | null, messageId: number, anonymous = false) {
  const chat = { id: chatId, type: "supergroup" as const, title: "Forum", is_forum: true };
  return {
    update_id: 500000 + messageId,
    message: {
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      chat,
      from: anonymous
        ? { id: 1087968824, is_bot: true, first_name: "Group", username: "GroupAnonymousBot" }
        : { id: userId, is_bot: false, first_name: "U" },
      ...(anonymous ? { sender_chat: chat } : {}),
      message_thread_id: topicId,
      is_topic_message: true,
      photo: [{ file_id: "f", file_unique_id: "u", width: 1, height: 1 }],
      ...(topicName
        ? { reply_to_message: { message_id: topicId, date: 0, chat, message_thread_id: topicId, forum_topic_created: { name: topicName, icon_color: 0 } } }
        : {}),
    },
  };
}

Deno.test("RETRO — /register_creator retro registers an existing Retro topic and it appears in the directory", async () => {
  const kv = await setupTestEnvironment();
  try {
    const { bot, calls } = makeBot();
    await bot.handleUpdate(text(ADMIN, "/register_creator retro 17 Maya") as never);
    const c = await getCreatorByTopic(RETRO_CHAT, 17);
    assert(c);
    assertEquals(c!.collection, "retro");
    assertEquals(c!.chatId, RETRO_CHAT);
    assertStringIncludes(JSON.stringify(calls.filter((x) => x.method === "sendMessage")), "Retro");

    // Plain form still registers in the Regular forum
    await bot.handleUpdate(text(ADMIN, "/register_creator 18 Aria") as never);
    assertEquals((await getCreatorByTopic(REGULAR_CHAT, 18))!.collection, "regular");

    const api = new MockTelegramApi();
    await syncPublicDirectory(api, true);
    const published = api.sentMessages.map((m) => m.text).join("\n");
    assertStringIncludes(published, "RETRO — RETRO | LA CONFRÉRIE");
    assertStringIncludes(published, "Maya");
    assertStringIncludes(published, "Aria");
  } finally {
    await kv.close();
  }
});

Deno.test("RETRO — Registering a Retro topic never duplicates an existing creator; non-admins cannot register", async () => {
  const kv = await setupTestEnvironment();
  try {
    await seedCreator({ name: "Aria", topicId: 1 });
    const { bot, calls } = makeBot();
    await bot.handleUpdate(text(ADMIN, "/register_creator retro 40 Aria") as never);
    assertEquals((await listCreators()).length, 1);
    assertStringIncludes(JSON.stringify(calls.filter((x) => x.method === "sendMessage")), "existe déjà");

    calls.length = 0;
    await bot.handleUpdate(text(5555, "/register_creator retro 41 Hacker") as never);
    assertEquals((await listCreators()).length, 1);
  } finally {
    await kv.close();
  }
});

Deno.test("RETRO — An administrator's first upload in an unregistered Retro topic registers it and counts the media", async () => {
  const kv = await setupTestEnvironment();
  try {
    const { bot } = makeBot();
    await bot.handleUpdate(groupPhoto(RETRO_CHAT, ADMIN, 55, "Nova", 900) as never);
    const c = await getCreatorByTopic(RETRO_CHAT, 55);
    assert(c);
    assertEquals(c!.name, "Nova");
    assertEquals(c!.collection, "retro");
    assertEquals(c!.hasContent, true);
    assertEquals((await listMediaIndex(c!.id)).map((e) => e.messageId), [900]);

    // Later uploads keep updating the same creator (no duplicate)
    await bot.handleUpdate(groupPhoto(RETRO_CHAT, ADMIN, 55, "Nova", 901) as never);
    assertEquals((await listCreators()).length, 1);
    assertEquals((await listMediaIndex(c!.id)).length, 2);

    const api = new MockTelegramApi();
    await syncPublicDirectory(api, true);
    assertStringIncludes(api.sentMessages.map((m) => m.text).join("\n"), "Nova");
  } finally {
    await kv.close();
  }
});

Deno.test("RETRO — Uploads by non-admins in an unregistered topic register nothing; same-name Regular creator is never overwritten", async () => {
  const kv = await setupTestEnvironment();
  try {
    const { bot } = makeBot();
    await bot.handleUpdate(groupPhoto(RETRO_CHAT, 4242, 56, "Ghost", 910) as never);
    assertEquals((await listCreators()).length, 0);

    const existing = await seedCreator({ name: "Aria", topicId: 7 });
    await bot.handleUpdate(groupPhoto(RETRO_CHAT, ADMIN, 57, "Aria", 911) as never);
    const all = await listCreators();
    assertEquals(all.length, 1);
    assertEquals(all[0].id, existing.id);
    assertEquals(all[0].chatId, REGULAR_CHAT);
    assertEquals(await getCreatorByTopic(RETRO_CHAT, 57), null);
  } finally {
    await kv.close();
  }
});

Deno.test("RETRO — Help text explains how to register Retro topics", async () => {
  const kv = await setupTestEnvironment();
  try {
    const { bot, calls } = makeBot();
    await bot.handleUpdate(cb(ADMIN, "admin:creator_register_help") as never);
    const t = JSON.stringify(calls.filter((x) => x.method === "editMessageText").at(-1));
    assertStringIncludes(t, "/register_creator retro");
  } finally {
    await kv.close();
  }
});

Deno.test("RETRO — An administrator posting anonymously (as the group) is recognised; a stranger is not", async () => {
  const kv = await setupTestEnvironment();
  try {
    const { bot } = makeBot();
    await bot.handleUpdate(groupPhoto(RETRO_CHAT, 0, 60, "Luna", 920, true) as never);
    const c = await getCreatorByTopic(RETRO_CHAT, 60);
    assert(c, "anonymous admin upload must register the Retro topic");
    assertEquals(c!.collection, "retro");
    assertEquals(c!.hasContent, true);
    // The same shape from a non-anonymous non-admin must still be ignored
    await bot.handleUpdate(groupPhoto(RETRO_CHAT, 4242, 61, "Intruder", 921) as never);
    assertEquals(await getCreatorByTopic(RETRO_CHAT, 61), null);
  } finally {
    await kv.close();
  }
});

Deno.test("DIRECTORY — A failed sync is no longer silent: the error is stored, shown to admins and cleared on success", async () => {
  const kv = await setupTestEnvironment();
  try {
    await seedCreator({ name: "Aria", topicId: 1 });
    await seedCreator({ name: "Maya", topicId: 2, collection: "retro" });
    const api = new MockTelegramApi();
    const orig = api.sendMessage.bind(api);
    api.sendMessage = async () => { throw new Error("Bad Request: can't parse entities"); };
    const res = await syncPublicDirectory(api, true);
    assertEquals(res.updated, false);
    assertStringIncludes(res.error!, "can't parse entities");

    const { bot, calls } = makeBot();
    await bot.handleUpdate(cb(ADMIN, "admin:sync_dir_menu") as never);
    const screen = String((calls.filter((x) => x.method === "editMessageText").at(-1)!.payload as { text: string }).text);
    assertStringIncludes(screen, "Dernière erreur de synchronisation");
    assertStringIncludes(screen, "Retro 1");

    api.sendMessage = orig;
    assertEquals((await syncPublicDirectory(api, true)).updated, true);
    calls.length = 0;
    await bot.handleUpdate(cb(ADMIN, "admin:sync_dir_menu") as never);
    assert(!String((calls.filter((x) => x.method === "editMessageText").at(-1)!.payload as { text: string }).text).includes("Dernière erreur"));
  } finally {
    await kv.close();
  }
});

Deno.test("DIRECTORY — Menu explains how to register Retro when none is registered", async () => {
  const kv = await setupTestEnvironment();
  try {
    await seedCreator({ name: "Aria", topicId: 1 });
    const { bot, calls } = makeBot();
    await bot.handleUpdate(cb(ADMIN, "admin:sync_dir_menu") as never);
    const screen = String((calls.filter((x) => x.method === "editMessageText").at(-1)!.payload as { text: string }).text);
    assertStringIncludes(screen, "Aucun créateur Retro n'est inscrit");
    assertStringIncludes(screen, "/register_creator retro");
  } finally {
    await kv.close();
  }
});
