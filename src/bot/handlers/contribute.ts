/**
 * LA CONFRÉRIE — Member Contributions UI (UG-04)
 * Member flow: Contribute → pick creator → send photos/videos → Finish.
 * Admin flow (cadm:*): review queue → Approve & publish / Reject.
 */

import { Composer, InlineKeyboard } from "grammy";
import { getClubName } from "../../config.ts";
import { adminRouteGuard } from "../middleware/auth.ts";
import { creatorCollection, listCreators } from "../../db/creators.ts";
import { getContribution, listContributions } from "../../db/contributions.ts";
import {
  addContributionItem,
  approveContribution,
  cancelContribution,
  finishContribution,
  rejectContribution,
  startContribution,
} from "../../contributions/service.ts";

export const contributeComposer = new Composer();

const PAGE = 8;

// ---- Member: pick a creator -------------------------------------------------------

async function showCreatorList(ctx: { answerCallbackQuery: () => Promise<unknown>; editMessageText: (t: string, o: object) => Promise<unknown> }, page: number) {
  const creators = (await listCreators({ status: "active" })).filter((c) => !c.retiredAt);
  const slice = creators.slice(page * PAGE, page * PAGE + PAGE);
  const kb = new InlineKeyboard();
  for (const c of slice) {
    kb.text(`${c.name} (${creatorCollection(c) === "retro" ? "Retro" : "Regular"})`, `contrib:pick:${c.id}`).row();
  }
  if (page > 0) kb.text("◀️ Prev", `contrib:list:${page - 1}`);
  if ((page + 1) * PAGE < creators.length) kb.text("Next ▶️", `contrib:list:${page + 1}`);
  kb.row().text("⬅️ Main Menu", "member:home");
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `➕ *CONTRIBUTE TO ${getClubName()}*\n\nWhich creator is your content for?\n` +
    `_Everything you send is reviewed by an administrator before it is published._` +
    (creators.length === 0 ? `\n\nNo creators are available yet.` : ""),
    { parse_mode: "Markdown", reply_markup: kb }
  );
}

contributeComposer.callbackQuery("contrib:start", (ctx) => showCreatorList(ctx, 0));
contributeComposer.callbackQuery(/^contrib:list:(\d+)$/, (ctx) => showCreatorList(ctx, Number(ctx.match[1])));

contributeComposer.callbackQuery(/^contrib:pick:([\w-]+)$/, async (ctx) => {
  const res = await startContribution(ctx.from.id, ctx.match[1]);
  await ctx.answerCallbackQuery();
  if (!res.ok || !res.contribution) {
    await ctx.editMessageText(`⚠️ ${res.error}`, {
      reply_markup: new InlineKeyboard().text("⬅️ Back", "contrib:start"),
    });
    return;
  }
  await ctx.editMessageText(
    `📤 *Contributing to ${res.contribution.creatorName}*\n\n` +
    `Send me the photos and videos now (albums are fine). When you're done, tap *Finish*.\n` +
    `Once approved, the bot publishes them for you — you won't appear as the poster.`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text("✅ Finish", "contrib:finish")
        .text("❌ Cancel", "contrib:cancel"),
    }
  );
});

// ---- Member: receive media in private chat -----------------------------------------

contributeComposer.on(["message:photo", "message:video"], async (ctx, next) => {
  if (ctx.chat.type !== "private") return next();
  const msg = ctx.message;
  const res = await addContributionItem(ctx.from.id, {
    messageId: msg.message_id,
    kind: msg.photo ? "photo" : "video",
    mediaGroupId: msg.media_group_id,
  });
  if (!res.contribution) return next(); // no open session: ignore silently
  if (res.added && res.newAlbum) {
    await ctx.reply(`✔ Received (${res.count} so far). Send more, or tap Finish.`, {
      reply_markup: new InlineKeyboard().text("✅ Finish", "contrib:finish").text("❌ Cancel", "contrib:cancel"),
    });
  }
});

contributeComposer.on("message", async (ctx, next) => {
  // Other message types during an open session: explain what is supported.
  if (ctx.chat.type === "private" && !ctx.message.text?.startsWith("/") && (ctx.message.document || ctx.message.animation || ctx.message.audio || ctx.message.voice)) {
    const { getActiveContribution } = await import("../../db/contributions.ts");
    if (await getActiveContribution(ctx.from.id)) {
      await ctx.reply("Only photos and videos are supported for contributions.");
      return;
    }
  }
  return next();
});

contributeComposer.callbackQuery("contrib:finish", async (ctx) => {
  const res = await finishContribution(ctx.api, ctx.from.id);
  await ctx.answerCallbackQuery();
  await ctx.reply(
    res.ok
      ? `✅ Thank you! Your ${res.contribution!.items.length} item(s) for *${res.contribution!.creatorName}* were sent for review. You'll get a message when an administrator decides.`
      : `⚠️ ${res.error}`,
    { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("⬅️ Main Menu", "member:home") }
  );
});

contributeComposer.callbackQuery("contrib:cancel", async (ctx) => {
  await cancelContribution(ctx.from.id);
  await ctx.answerCallbackQuery();
  await ctx.reply("Contribution cancelled. Nothing was sent.", {
    reply_markup: new InlineKeyboard().text("⬅️ Main Menu", "member:home"),
  });
});

// ---- Administrator review (cadm:*) -------------------------------------------------

contributeComposer.use(adminRouteGuard({ callbackPrefixes: ["cadm:"], commands: [] }));

contributeComposer.callbackQuery("cadm:queue", async (ctx) => {
  const pending = await listContributions("pending");
  const kb = new InlineKeyboard();
  let text = `📥 *CONTRIBUTIONS AWAITING REVIEW* (${pending.length})\n\n`;
  if (pending.length === 0) text += "_Nothing to review._";
  for (const c of pending.slice(0, 15)) {
    text += `• *${c.creatorName}* — ${c.items.length} item(s) from \`${c.userId}\`\n`;
    kb.text(`Review: ${c.creatorName} (${c.items.length})`, `cadm:view:${c.id}`).row();
  }
  kb.text("⬅️ Admin Menu", "admin:menu");
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: kb });
});

contributeComposer.callbackQuery(/^cadm:view:([\w-]+)$/, async (ctx) => {
  const c = await getContribution(ctx.match[1]);
  await ctx.answerCallbackQuery();
  if (!c || !["pending", "failed"].includes(c.status)) {
    await ctx.reply("This contribution is no longer awaiting review.");
    return;
  }
  // Re-send the preview so the admin sees exactly what would be published.
  try {
    await ctx.api.copyMessages(ctx.from.id, c.userId, c.items.map((i) => i.messageId).sort((a, b) => a - b));
  } catch {
    await ctx.reply("⚠️ Preview unavailable (the member may have deleted the originals).");
  }
  await ctx.reply(
    `📥 *${c.creatorName}* — ${c.items.length} item(s) from \`${c.userId}\`${c.note ? `\n_${c.note}_` : ""}`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text("✅ Approve & publish", `cadm:ok:${c.id}`)
        .text("❌ Reject", `cadm:no:${c.id}`),
    }
  );
});

contributeComposer.callbackQuery(/^cadm:ok:([\w-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Publishing..." });
  const res = await approveContribution(ctx.api, ctx.match[1], ctx.from.id);
  await ctx.reply(res.ok ? `✅ Published ${res.published} item(s).` : `⚠️ ${res.error}`);
});

contributeComposer.callbackQuery(/^cadm:no:([\w-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const res = await rejectContribution(ctx.api, ctx.match[1], ctx.from.id);
  await ctx.reply(res.ok ? "❌ Rejected. The member was notified." : `⚠️ ${res.error}`);
});
