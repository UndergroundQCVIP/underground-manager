/**
 * LA CONFRÉRIE — Member-facing Creator Directory (UG-04)
 * Separate Regular and Retro messages with All / Regular / Retro filters.
 * Listing is public information; protected topic links are only ever issued
 * by the tier-checked /start creator_<id> flow.
 */

import { Composer, InlineKeyboard } from "grammy";
import { getConfig } from "../../config.ts";
import { listCreators } from "../../db/creators.ts";
import { buildDirectorySections, directoryContentCounts, syncPublicDirectory } from "../../directory/sync.ts";
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

function filterKeyboard(active: "all" | CollectionCategory): InlineKeyboard {
  const mark = (id: string, label: string) => (active === id ? `• ${label}` : label);
  return new InlineKeyboard()
    .text(mark("all", "Tous"), "dir:all")
    .text(mark("regular", "En activité"), "dir:regular")
    .text(mark("retro", "Plus en activité"), "dir:retro")
    .row()
    .text("⬅️ Menu principal", "member:home");
}

directoryComposer.callbackQuery(/^dir:(all|regular|retro)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const filter = ctx.match[1] as "all" | CollectionCategory;
  const creators = await listCreators({ status: "active", hasContentOnly: true });
  const sections = buildDirectorySections(creators, getConfig().BOT_USERNAME, {
    collection: filter === "all" ? undefined : filter,
    contentCounts: await directoryContentCounts(creators),
  });

  await ctx.editMessageText(sections[0], {
    parse_mode: "Markdown",
    reply_markup: filterKeyboard(filter),
    link_preview_options: { is_disabled: true },
  });
  // Additional chunks (large directories) follow as separate messages.
  for (const extra of sections.slice(1)) {
    await ctx.reply(extra, {
      parse_mode: "Markdown",
      link_preview_options: { is_disabled: true },
    });
  }
});
