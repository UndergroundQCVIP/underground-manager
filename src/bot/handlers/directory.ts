/**
 * LA CONFRÉRIE — Member-facing Creator Directory (UG-04)
 * Separate Regular and Retro messages with All / Regular / Retro filters.
 * Listing is public information; protected topic links are only ever issued
 * by the tier-checked /start creator_<id> flow.
 */

import { Composer, InlineKeyboard } from "grammy";
import { getConfig, isAdministrator } from "../../config.ts";
import { listCreators } from "../../db/creators.ts";
import { buildDirectoryMessages, datedDirectoryPage, directoryContentCounts, showDirectoryPage, syncPublicDirectory } from "../../directory/sync.ts";
import { getKv } from "../../db/kv.ts";
import { withJobLease } from "../../ops/locks.ts";
import { isMessageGone, isMessageNotModified } from "../../wanted/service.ts";
import { CollectionCategory } from "../../types.ts";

export const directoryComposer = new Composer();

// Each public post refreshes its own collection; no private topic URLs are published.
directoryComposer.callbackQuery(/^dir:refresh:(regular|retro)$/, async (ctx) => {
  if (ctx.chat?.id !== getConfig().PUBLIC_DIRECTORY_CHAT_ID) {
    await ctx.answerCallbackQuery();
    return;
  }
  const collection = ctx.match[1] as CollectionCategory;
  await ctx.answerCallbackQuery({ text: `Actualisation des créateurs ${collection === "regular" ? "en activité" : "qui ne sont plus en activité"}…` });
  const result = await syncPublicDirectory(ctx.api, isAdministrator(ctx.from.id), collection);
  if (result.error && isAdministrator(ctx.from.id)) await ctx.api.sendMessage(ctx.from.id, `⚠️ Le canal n'a pas pu être actualisé : ${result.error}`);
});

directoryComposer.callbackQuery(/^dir:page:(regular|retro):(\d+)$/, async ctx => {
  await ctx.answerCallbackQuery();
  if (!ctx.chat || !ctx.callbackQuery.message) return;
  await showDirectoryPage(ctx.api, ctx.chat.id, ctx.callbackQuery.message.message_id,
    ctx.match[1] as CollectionCategory, Number(ctx.match[2]));
});

function filterKeyboard(active: "all" | CollectionCategory): InlineKeyboard {
  const mark = (id: string, label: string) => (active === id ? `• ${label}` : label);
  const kb = new InlineKeyboard()
    .text(mark("all", "Tous"), "dir:all")
    .text(mark("regular", "En activité"), "dir:regular")
    .text(mark("retro", "Plus en activité"), "dir:retro")
    .row()
    .text("⬅️ Menu principal", "member:home");
  return kb;
}

directoryComposer.callbackQuery(/^dir:(all|regular|retro)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.chat || !ctx.callbackQuery.message) return;
  const chatId = ctx.chat.id;
  const rootId = ctx.callbackQuery.message.message_id;
  await withJobLease(`directory_view:${chatId}:${rootId}`, 60_000, async () => {
    const filter = ctx.match[1] as "all" | CollectionCategory;
    const creators = await listCreators({ status: "active", hasContentOnly: true });
    const messages = buildDirectoryMessages(creators, getConfig().BOT_USERNAME, {
      collection: filter === "all" ? undefined : filter,
      contentCounts: await directoryContentCounts(creators),
    });
    const admin = isAdministrator(ctx.from.id);
    const kv = await getKv();
    // The menu remains a compact control panel; BOTH lists are their own messages.
    // Previously the first list replaced the menu and only Retro appeared as a new reply.
    const key = ["directory_view_messages_v3", chatId, rootId];
    const existing = (await kv.get<number[]>(key)).value ?? [];
    const extraIds: number[] = [];
    try {
      await ctx.editMessageText("📚 Répertoire\nChoisissez les créateurs en activité ou ceux qui ne sont plus en activité. Les listes sont affichées ci-dessous.", {
        reply_markup: filterKeyboard(filter),
      });
    } catch (error) { if (!isMessageNotModified(error)) throw error; }
    for (let i = 0; i < messages.length; i++) {
      const message = datedDirectoryPage(messages[i], new Date().toISOString());
      const options = {
        entities: message.entities,
        reply_markup: admin ? new InlineKeyboard().text("📢 Actualiser le canal — " +
            (message.collection === "regular" ? "en activité" : "inactifs"), `admin:sync_dir:${message.collection}`) : undefined,
        link_preview_options: { is_disabled: true },
      };
      let id = existing[i];
      if (id) {
        try { await ctx.api.editMessageText(chatId, id, message.text, options); }
        catch (error) {
          if (isMessageGone(error)) id = (await ctx.reply(message.text, options)).message_id;
          else if (!isMessageNotModified(error)) throw error;
        }
      } else id = (await ctx.reply(message.text, options)).message_id;
      extraIds.push(id);
      await kv.set(key, [...extraIds, ...existing.slice(extraIds.length)]);
    }
    for (const stale of existing.slice(extraIds.length)) {
      await ctx.api.deleteMessage(chatId, stale).catch(() => {});
    }
    // Remove continuation replies made by the previous view format when reopening it.
    const legacyKey = ["directory_view_messages", chatId, rootId];
    for (const stale of (await kv.get<number[]>(legacyKey)).value ?? []) {
      await ctx.api.deleteMessage(chatId, stale).catch(() => {});
    }
    await kv.delete(legacyKey);
    await kv.set(key, extraIds);
  });
});
