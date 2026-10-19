/**
 * LA CONFRÉRIE — Member-facing Creator Directory (UG-04)
 * One unified directory with All / Regular / Retro filters.
 * Listing is public information; protected topic links are only ever issued
 * by the tier-checked /start creator_<id> flow.
 */

import { Composer, InlineKeyboard } from "grammy";
import { getConfig } from "../../config.ts";
import { listCreators } from "../../db/creators.ts";
import { buildDirectorySections } from "../../directory/sync.ts";
import { CollectionCategory } from "../../types.ts";

export const directoryComposer = new Composer();

function filterKeyboard(active: "all" | CollectionCategory): InlineKeyboard {
  const mark = (id: string, label: string) => (active === id ? `• ${label}` : label);
  return new InlineKeyboard()
    .text(mark("all", "All"), "dir:all")
    .text(mark("regular", "Regular"), "dir:regular")
    .text(mark("retro", "Retro"), "dir:retro")
    .row()
    .text("⬅️ Main Menu", "member:home");
}

directoryComposer.callbackQuery(/^dir:(all|regular|retro)$/, async (ctx) => {
  const filter = ctx.match[1] as "all" | CollectionCategory;
  const creators = await listCreators({ status: "active", hasContentOnly: true });
  const sections = buildDirectorySections(creators, getConfig().BOT_USERNAME, {
    collection: filter === "all" ? undefined : filter,
  });

  await ctx.answerCallbackQuery();
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
