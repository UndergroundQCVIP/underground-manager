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
  if (page > 0) kb.text("◀️ Préc.", `contrib:list:${page - 1}`);
  if ((page + 1) * PAGE < creators.length) kb.text("Suiv. ▶️", `contrib:list:${page + 1}`);
  kb.row().text("⬅️ Menu principal", "member:home");
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `➕ *CONTRIBUER À ${getClubName()}*\n\nPour quel créateur est votre contenu ?\n` +
    `_Tout ce que vous envoyez est examiné par un administrateur avant d'être publié._` +
    (creators.length === 0 ? `\n\nAucun créateur n'est disponible pour le moment.` : ""),
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
      reply_markup: new InlineKeyboard().text("⬅️ Retour", "contrib:start"),
    });
    return;
  }
  await ctx.editMessageText(
    `📤 *Contribution pour ${res.contribution.creatorName}*\n\n` +
    `Envoyez-moi maintenant les photos et vidéos (les albums sont acceptés). Quand vous avez terminé, appuyez sur *Terminer*.\n` +
    `Une fois approuvé, le robot les publie pour vous — vous n'apparaîtrez pas comme l'auteur de la publication.`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text("✅ Terminer", "contrib:finish")
        .text("❌ Annuler", "contrib:cancel"),
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
    await ctx.reply(`✔ Reçu (${res.count} jusqu'ici). Envoyez-en d'autres ou appuyez sur Terminer.`, {
      reply_markup: new InlineKeyboard().text("✅ Terminer", "contrib:finish").text("❌ Annuler", "contrib:cancel"),
    });
  }
});

contributeComposer.on("message", async (ctx, next) => {
  // Other message types during an open session: explain what is supported.
  if (ctx.chat.type === "private" && !ctx.message.text?.startsWith("/") && (ctx.message.document || ctx.message.animation || ctx.message.audio || ctx.message.voice)) {
    const { getActiveContribution } = await import("../../db/contributions.ts");
    if (await getActiveContribution(ctx.from.id)) {
      await ctx.reply("Seules les photos et les vidéos sont acceptées pour les contributions.");
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
      ? `✅ Merci ! Vos ${res.contribution!.items.length} élément(s) pour *${res.contribution!.creatorName}* ont été envoyés pour examen. Vous recevrez un message lorsqu'un administrateur aura décidé.`
      : `⚠️ ${res.error}`,
    { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("⬅️ Menu principal", "member:home") }
  );
});

contributeComposer.callbackQuery("contrib:cancel", async (ctx) => {
  await cancelContribution(ctx.from.id);
  await ctx.answerCallbackQuery();
  await ctx.reply("Contribution annulée. Rien n'a été envoyé.", {
    reply_markup: new InlineKeyboard().text("⬅️ Menu principal", "member:home"),
  });
});

// ---- Administrator review (cadm:*) -------------------------------------------------

contributeComposer.use(adminRouteGuard({ callbackPrefixes: ["cadm:"], commands: [] }));

contributeComposer.callbackQuery("cadm:queue", async (ctx) => {
  const pending = await listContributions("pending");
  const kb = new InlineKeyboard();
  let text = `📥 *CONTRIBUTIONS À EXAMINER* (${pending.length})\n\n`;
  if (pending.length === 0) text += "_Rien à examiner._";
  for (const c of pending.slice(0, 15)) {
    text += `• *${c.creatorName}* — ${c.items.length} élément(s) de \`${c.userId}\`\n`;
    kb.text(`Examiner : ${c.creatorName} (${c.items.length})`, `cadm:view:${c.id}`).row();
  }
  kb.text("⬅️ Menu administrateur", "admin:menu");
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: kb });
});

contributeComposer.callbackQuery(/^cadm:view:([\w-]+)$/, async (ctx) => {
  const c = await getContribution(ctx.match[1]);
  await ctx.answerCallbackQuery();
  if (!c || !["pending", "failed"].includes(c.status)) {
    await ctx.reply("Cette contribution n'est plus en attente d'examen.");
    return;
  }
  // Re-send the preview so the admin sees exactly what would be published.
  try {
    await ctx.api.copyMessages(ctx.from.id, c.userId, c.items.map((i) => i.messageId).sort((a, b) => a - b));
  } catch {
    await ctx.reply("⚠️ Aperçu indisponible (le membre a peut-être supprimé les originaux).");
  }
  await ctx.reply(
    `📥 *${c.creatorName}* — ${c.items.length} élément(s) de \`${c.userId}\`${c.note ? `\n_${c.note}_` : ""}`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text("✅ Approuver et publier", `cadm:ok:${c.id}`)
        .text("❌ Refuser", `cadm:no:${c.id}`),
    }
  );
});

contributeComposer.callbackQuery(/^cadm:ok:([\w-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Publication..." });
  const res = await approveContribution(ctx.api, ctx.match[1], ctx.from.id);
  await ctx.reply(res.ok ? `✅ ${res.published} élément(s) publié(s).` : `⚠️ ${res.error}`);
});

contributeComposer.callbackQuery(/^cadm:no:([\w-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const res = await rejectContribution(ctx.api, ctx.match[1], ctx.from.id);
  await ctx.reply(res.ok ? "❌ Refusé. Le membre a été avisé." : `⚠️ ${res.error}`);
});
