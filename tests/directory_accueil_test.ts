import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { MOCK_CONFIG, MockTelegramApi, setupTestEnvironment } from "./test_helpers.ts";
import { seedCreator } from "./ug04_helpers.ts";
import { callback, createFakeTelegram, privateMessage } from "./bot_harness.ts";
import { getConfig, setConfigForTesting } from "../src/config.ts";
import { getDirectorySyncState, saveDirectorySyncState } from "../src/db/directory.ts";
import { getNavigationState, saveNavigationState } from "../src/db/navigation.ts";
import { refreshAmateurConfiguration } from "../src/db/amateur.ts";
import { saveCreator } from "../src/db/creators.ts";
import { syncPublicDirectory } from "../src/directory/sync.ts";
import { syncDirectoryButtons, syncNavigationMessages } from "../src/navigation/service.ts";

const ADMIN = MOCK_CONFIG.ADMIN_USER_IDS[0];
const ACCUEIL = -100880088;

Deno.test("DIRECTORY — every manual sync dates the same post, while background sync stays quiet", async () => {
  const kv = await setupTestEnvironment();
  try {
    await seedCreator({ name: "Linked Name", topicId: 1 });
    const tg = await createFakeTelegram();
    await tg.send(privateMessage(ADMIN, "/sync_directory regular"));
    const first = tg.callsOf("sendMessage").find(c => c.payload.chat_id === MOCK_CONFIG.PUBLIC_DIRECTORY_CHAT_ID)!;
    assertStringIncludes(String(first.payload.text), "Mis à jour :");
    assertStringIncludes(String(first.payload.text), "(Montréal)");
    const original = (await getDirectorySyncState()).collections!.regular!;
    assertEquals(original.publishedMessageIds.length, 1);
    const unchanged = await syncPublicDirectory(tg.bot.api);
    assertEquals(unchanged.updated, true); // first background sync also creates the separate Retro list
    tg.reset();
    assertEquals((await syncPublicDirectory(tg.bot.api)).updated, false);
    assertEquals(tg.callsOf("editMessageText").length, 0);
    await new Promise(resolve => setTimeout(resolve, 1100));
    await tg.send(privateMessage(ADMIN, "/sync_directory regular"));
    const edit = tg.callsOf("editMessageText").find(c => c.payload.chat_id === MOCK_CONFIG.PUBLIC_DIRECTORY_CHAT_ID)!;
    assertEquals(edit.payload.message_id, original.publishedMessageIds[0]);
    assert(edit.payload.text !== first.payload.text);
    assertEquals(tg.callsOf("sendMessage").filter(c => c.payload.chat_id === MOCK_CONFIG.PUBLIC_DIRECTORY_CHAT_ID).length, 0);
    assertEquals((await getDirectorySyncState()).collections!.regular!.publishedMessageIds, original.publishedMessageIds);
  } finally { await kv.close(); }
});

Deno.test("DIRECTORY — a large list keeps one post, every name remains reachable, and keyboard maintenance preserves the page", async () => {
  const kv = await setupTestEnvironment();
  try {
    const seed = await seedCreator({ name: "Creator 000", topicId: 1 });
    for (let i = 1; i < 250; i++) await saveCreator({ ...seed, id: `page-creator-${i}`, name: `Creator ${String(i).padStart(3, "0")}`, topicId: i + 1 });
    await saveCreator({ ...seed, id: "hidden", name: "Private Amateur", collection: "amateur", chatId: -100999999, topicId: 99 });
    const tg = await createFakeTelegram();
    await syncPublicDirectory(tg.bot.api, true, "regular");
    const slot = (await getDirectorySyncState()).collections!.regular!;
    assertEquals(slot.publishedMessageIds.length, 1);
    assert(slot.pageCount! > 1);
    const post = tg.callsOf("sendMessage").find(c => c.payload.chat_id === MOCK_CONFIG.PUBLIC_DIRECTORY_CHAT_ID)!;
    const texts = [String(post.payload.text)];
    const refreshedAt = slot.refreshedAt;
    for (let page = 1; page < slot.pageCount!; page++) {
      const click = callback(987654, `dir:page:regular:${page}`);
      Object.assign(click.callback_query.message, { message_id: slot.publishedMessageIds[0], chat: { id: MOCK_CONFIG.PUBLIC_DIRECTORY_CHAT_ID, type: "channel" } });
      await tg.send(click);
      const edit = tg.callsOf("editMessageText").at(-1)!;
      assertEquals(edit.payload.message_id, slot.publishedMessageIds[0]);
      texts.push(String(edit.payload.text));
    }
    for (let i = 0; i < 250; i++) assertStringIncludes(texts.join("\n"), `Creator ${String(i).padStart(3, "0")}`);
    assert(!JSON.stringify(tg.calls).includes("Private Amateur"));
    assertEquals((await getDirectorySyncState()).collections!.regular!.refreshedAt, refreshedAt);
    assertEquals(tg.callsOf("sendMessage").filter(c => c.payload.chat_id === MOCK_CONFIG.PUBLIC_DIRECTORY_CHAT_ID).length, 1);
    await syncDirectoryButtons(tg.bot.api, true);
    const markup = JSON.stringify(tg.callsOf("editMessageReplyMarkup").at(-1)!.payload.reply_markup);
    assertStringIncludes(markup, "Précédent");
    assert(!markup.includes("Suivant"));
    tg.reset();
    const forged = callback(987654, "dir:page:regular:0");
    await tg.send(forged); // the private bot chat is not the saved public post
    assertEquals(tg.callsOf("editMessageText").length, 0);
    const stale = callback(987654, "dir:page:regular:99999");
    Object.assign(stale.callback_query.message.chat, { id: MOCK_CONFIG.PUBLIC_DIRECTORY_CHAT_ID, type: "channel" });
    await tg.send(stale);
    assertEquals(tg.callsOf("editMessageText").length, 0);
  } finally { await kv.close(); }
});

Deno.test("DIRECTORY — failed old-post cleanup retries without duplicating the saved root", async () => {
  const kv = await setupTestEnvironment();
  try {
    await seedCreator({ name: "Creator", topicId: 1 });
    await saveDirectorySyncState({ publishedMessageIds: [90, 91, 92], isDirty: true });
    class CleanupApi extends MockTelegramApi {
      fail = true;
      deleted: number[] = [];
      async deleteMessage(_chat: number | string, id: number) {
        if (this.fail) { this.fail = false; throw new Error("Too Many Requests: retry after 1"); }
        this.deleted.push(id);
      }
    }
    const api = new CleanupApi();
    assert((await syncPublicDirectory(api, true, "regular")).error);
    assertEquals((await getDirectorySyncState()).collections!.regular!.publishedMessageIds, [90, 91, 92]);
    const sentBefore = api.sentMessages.length;
    assertEquals((await syncPublicDirectory(api, true, "regular")).updated, true);
    assertEquals(api.sentMessages.length, sentBefore);
    assertEquals((await getDirectorySyncState()).collections!.regular!.publishedMessageIds, [90]);
    assertEquals(api.deleted, [91, 92]);
  } finally { await kv.close(); }
});

Deno.test("ACCUEIL — setup publishes a French menu with real directory links, persists it, and edits it on repeat", async () => {
  const kv = await setupTestEnvironment();
  try {
    await seedCreator({ name: "Creator", topicId: 1 });
    const tg = await createFakeTelegram();
    tg.bot.api.config.use((prev, method, payload, signal) => {
      if (method === "getChat") return Promise.resolve({ ok: true, result: { id: ACCUEIL, type: "channel", title: "Accueil" } } as never);
      if (method === "getChatMember") return Promise.resolve({ ok: true, result: { user: tg.bot.botInfo, status: "administrator", can_post_messages: true, can_pin_messages: true } } as never);
      return prev(method, payload, signal);
    });
    await syncPublicDirectory(tg.bot.api);
    tg.reset();
    const setup = () => privateMessage(ADMIN, `/setup_accueil ${ACCUEIL}`);
    await tg.send(setup());
    const post = tg.callsOf("sendMessage").find(c => c.payload.chat_id === ACCUEIL)!;
    assert(post, JSON.stringify(tg.calls));
    assertStringIncludes(String(post.payload.text), "BIENVENUE");
    assert(String(post.payload.text).length < 600);
    const markup = JSON.stringify(post.payload.reply_markup);
    const state = await getDirectorySyncState();
    for (const collection of ["regular", "retro"] as const) assertStringIncludes(markup,
      `https://t.me/c/${String(MOCK_CONFIG.PUBLIC_DIRECTORY_CHAT_ID).slice(4)}/${state.collections![collection]!.publishedMessageIds[0]}`);
    assertStringIncludes(markup, "start=amateur");
    assert(!markup.includes("t.me/+"));
    assertEquals(tg.callsOf("pinChatMessage").filter(c => c.payload.chat_id === ACCUEIL).length, 1);
    const publishedId = (await getNavigationState()).welcome!.messageId;
    setConfigForTesting({ ...MOCK_CONFIG });
    await refreshAmateurConfiguration();
    assertEquals(getConfig().TELEGRAM_PUBLIC_WELCOME_CHAT_ID, ACCUEIL);
    await tg.send(setup());
    assertEquals(tg.callsOf("sendMessage").filter(c => c.payload.chat_id === ACCUEIL).length, 1);
    assertEquals(tg.callsOf("editMessageText").filter(c => c.payload.chat_id === ACCUEIL).length, 1);
    assertEquals((await getNavigationState()).welcome!.messageId, publishedId);
  } finally { await kv.close(); }
});

Deno.test("ACCUEIL — menu action updates a lobby-only installation, and equal welcome/lobby IDs reuse one post", async () => {
  const kv = await setupTestEnvironment();
  try {
    setConfigForTesting({ ...MOCK_CONFIG, TELEGRAM_PUBLIC_LOBBY_CHAT_ID: ACCUEIL });
    const tg = await createFakeTelegram();
    await tg.send(callback(ADMIN, "admin:nav_sync:welcome"));
    assertEquals(tg.callsOf("sendMessage").filter(c => c.payload.chat_id === ACCUEIL).length, 1);
    const id = (await getNavigationState()).lobby!.messageId;
    setConfigForTesting({ ...getConfig(), TELEGRAM_PUBLIC_WELCOME_CHAT_ID: ACCUEIL });
    await syncNavigationMessages(tg.bot.api, { only: "accueil", force: true });
    assertEquals(tg.callsOf("sendMessage").filter(c => c.payload.chat_id === ACCUEIL).length, 1);
    assertEquals((await getNavigationState()).welcome!.messageId, id);
    assertEquals((await getNavigationState()).lobby, undefined);
  } finally { await kv.close(); }
});

Deno.test("ACCUEIL — setup rejects non-admins, private member spaces and missing publishing rights", async () => {
  const kv = await setupTestEnvironment();
  try {
    const tg = await createFakeTelegram();
    await tg.send(privateMessage(987654, `/setup_accueil ${ACCUEIL}`));
    await tg.send(privateMessage(ADMIN, `/setup_accueil ${MOCK_CONFIG.VIP_COLLECTIONS_CHAT_ID}`));
    tg.bot.api.config.use((prev, method, payload, signal) => {
      if (method === "getChat") return Promise.resolve({ ok: true, result: { id: ACCUEIL, type: "channel", title: "Accueil" } } as never);
      if (method === "getChatMember") return Promise.resolve({ ok: true, result: { user: tg.bot.botInfo, status: "administrator", can_post_messages: false } } as never);
      return prev(method, payload, signal);
    });
    await tg.send(privateMessage(ADMIN, `/setup_accueil ${ACCUEIL}`));
    assertEquals(getConfig().TELEGRAM_PUBLIC_WELCOME_CHAT_ID, 0);
    assertEquals((await getNavigationState()).welcome, undefined);
    assertEquals(tg.callsOf("sendMessage").filter(c => Number(c.payload.chat_id) < 0).length, 0);
    assertStringIncludes(JSON.stringify(tg.calls), "Autorisez le bot à publier");
  } finally { await kv.close(); }
});

Deno.test("ACCUEIL — concurrent sync and independent navigation checkpoints preserve one post and every slot", async () => {
  const kv = await setupTestEnvironment();
  try {
    setConfigForTesting({ ...MOCK_CONFIG, TELEGRAM_PUBLIC_WELCOME_CHAT_ID: ACCUEIL });
    const api = new MockTelegramApi();
    await Promise.all([syncNavigationMessages(api, { only: "welcome", force: true }), syncNavigationMessages(api, { only: "welcome", force: true })]);
    assertEquals(api.sentMessages.length, 1);
    await Promise.all([
      saveNavigationState({ directoryKeyboardHash: "test" }),
      saveNavigationState({ leaderboard: { chatId: -100997, messageId: 9, hash: "leaderboard" } }),
    ]);
    const state = await getNavigationState();
    assert(state.welcome);
    assertEquals(state.directoryKeyboardHash, "test");
    assertEquals(state.leaderboard!.messageId, 9);
  } finally { await kv.close(); }
});
