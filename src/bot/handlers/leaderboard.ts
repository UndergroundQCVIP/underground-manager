/**
 * LA CONFRÉRIE — Leaderboard handlers (UG-07)
 */

import { Composer } from "grammy";
import { setShowName } from "../../db/points.ts";
import { Tab } from "../../points/service.ts";
import { renderLeaderboard } from "../leaderboard_view.ts";

export const leaderboardComposer = new Composer();

async function show(ctx: { from?: { id: number }; answerCallbackQuery: () => Promise<unknown>; editMessageText: (t: string, o: object) => Promise<unknown> }, tab: Tab) {
  if (!ctx.from) return;
  const { text, kb } = await renderLeaderboard(ctx.from.id, tab);
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: kb, link_preview_options: { is_disabled: true } });
}

leaderboardComposer.callbackQuery(/^lb:(month|all|referrers)$/, (ctx) => show(ctx, ctx.match[1] as Tab));

leaderboardComposer.callbackQuery(/^lb:name:([01]):(month|all|referrers)$/, async (ctx) => {
  await setShowName(ctx.from.id, ctx.match[1] === "1");
  await show(ctx, ctx.match[2] as Tab);
});
