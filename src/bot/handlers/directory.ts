/**
 * LA CONFRÉRIE — Member-facing Creator Directory (UG-04)
 * Separate Regular and Retro messages with All / Regular / Retro filters.
 * Listing is public information; protected topic links are only ever issued
 * by the tier-checked /start creator_<id> flow.
 */

import { Composer, InlineKeyboard } from "grammy";
import { getConfig, isAdministrator } from "../../config.ts";
import { listCreators } from "../../db/creators.ts";
import { buildDirectoryMessages, directoryContentCounts, syncPublicDirectory } from "../../directory/sync.ts";
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
  await syncPublicDirectory(ctx.api, false, collection);
});

function filterKeyboard(active: "all" | CollectionCategory, collection: CollectionCategory, admin: boolean): InlineKeyboard {
  const mark = (id: string, label: string) => (active === id ? `• ${label}` : label);
  const kb = new InlineKeyboard()
    .text(mark("all", "Tous"), "dir:all")
    .text(mark("regular", "En activité"), "dir:regular")
    .text(mark("retro", "Plus en activité"), "dir:retro")
    .row()
    .text("⬅️ Menu principal", "member:home");
  if (admin) kb.row().text("📢 Actualiser le canal — " + (collection === "regular" ? "en activité" : "inactifs"), `admin:sync_dir:${collection}`);
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
    const key = ["directory_view_messages", chatId, rootId];
    const existing = (await kv.get<number[]>(key)).value ?? [];
    const extraIds: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      const options = {
        entities: message.entities,
        reply_markup: i === 0 ? filterKeyboard(filter, message.collection, admin) :
          admin ? new InlineKeyboard().text("📢 Actualiser le canal — " +
            (message.collection === "regular" ? "en activité" : "inactifs"), `admin:sync_dir:${message.collection}`) : undefined,
        link_preview_options: { is_disabled: true },
      };
      if (i === 0) {
        try { await ctx.editMessageText(message.text, options); }
        catch (error) { if (!isMessageNotModified(error)) throw error; }
        continue;
      }
      let id = existing[i - 1];
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
    await kv.set(key, extraIds);
  });
});
