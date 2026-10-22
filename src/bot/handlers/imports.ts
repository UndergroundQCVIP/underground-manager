/**
 * LA CONFRÉRIE — Legacy range import UI (UG-06)
 *
 *   In the destination topic:   /import <link to first message> <link to last message>
 *   The forum (Regular/Retro) and the topic are known from where the command is typed;
 *   a topic not yet registered becomes a NEW creator, a registered one is UPDATED.
 */

import { Api, Composer, Context, InlineKeyboard } from "grammy";
import { collectionLabel } from "../../creators/admin.ts";
import { isAdministrator } from "../../config.ts";
import { adminRouteGuard } from "../middleware/auth.ts";
import { collectionForChat, handleForumTopicCreated } from "../../creators/service.ts";
import { creatorCollection, getCreator, getCreatorByTopic, listCreators } from "../../db/creators.ts";
import { requestAdminInput } from "../../db/admin_input.ts";
import type { Creator } from "../../types.ts";
import { getImportJob, listImportJobs } from "../../db/imports.ts";
import {
  cancelImport,
  importProgress,
  kickImport,
  waitText,
  prepareImport,
  resumeImport,
  startImport,
  undoImport,
} from "../../imports/service.ts";

export const importsComposer = new Composer();

const mdEsc = (t: string) => t.replace(/([_*`\[])/g, "\\$1");

/**
 * Prepare an import (dry run), send the private preview + confirmation to the administrator.
 * Shared by the in-topic command and the private-chat flow.
 */
export async function presentImport(
  api: Api,
  params: { adminId: number; creator: Creator; isNewCreator: boolean; link1: string; link2: string; forum: "Retro" | "Regular" | "Amateur" }
): Promise<{ ok: false; error: string } | { ok: true; blocked: boolean; dmSent: boolean; jobId: string }> {
  const { adminId, creator, isNewCreator, forum } = params;
  const res = await prepareImport(api, { adminId, creatorId: creator.id, link1: params.link1, link2: params.link2, isNewCreator });
  if (!res.ok || !res.job) return { ok: false, error: res.error ?? "Import impossible." };
  const job = res.job;
  const total = job.toId - job.fromId + 1;

  const summary =
    `📥 *IMPORT — ${mdEsc(creator.name)}*\n` +
    `*Destination :* forum ${forum}, sujet \`${creator.topicId}\` — ${isNewCreator ? "✨ nouveau créateur" : "🔄 mise à jour d'un créateur existant"}\n` +
    `*Source :* ${mdEsc(job.sourceTitle ?? String(job.sourceChat))}\n` +
    `*Bloc :* messages ${job.fromId} → ${job.toId} (${total} identifiant${total > 1 ? "s" : ""})\n\n`;

  const kb = new InlineKeyboard();
  let dm: string;
  if (job.status === "blocked") {
    dm = summary + `🚫 *Bloqué :* ${job.note}`;
    kb.text("↩️ Fermer", `imp:no:${job.id}`);
  } else {
    dm =
      summary +
      `👁 *Aperçu :* ${res.samplesSent ?? 0} message(s) répartis dans le bloc viennent de vous être envoyés ci-dessus. ` +
      `Vérifiez qu'ils appartiennent bien à *${mdEsc(creator.name)}* (le premier et le dernier doivent être les bornes de son contenu).\n\n` +
      `⚠️ Le robot ne peut pas distinguer les commentaires de différents créateurs : tout ce qui se trouve entre les deux liens sera copié. ` +
      `Vous pourrez annuler l'import ensuite.\n\n` +
      `Confirmez-vous que le club détient les droits de publication et de distribution de ce contenu ?`;
    kb.text("✅ Je confirme — lancer l'import", `imp:go:${job.id}`).row().text("❌ Annuler", `imp:no:${job.id}`);
  }

  try {
    await api.sendMessage(adminId, dm, { parse_mode: "Markdown", reply_markup: kb, link_preview_options: { is_disabled: true } });
    return { ok: true, blocked: job.status === "blocked", dmSent: true, jobId: job.id };
  } catch {
    await cancelImport(job.id, adminId);
    return { ok: true, blocked: false, dmSent: false, jobId: job.id };
  }
}

const IMPORT_HELP =
  "📥 *IMPORT D'UN BLOC DE MESSAGES*\n\n" +
  "*Dans le sujet du créateur* (forum Regular ou Retro) :\n`/import <lien du 1er message> <lien du dernier message>`\n" +
  "Le forum et le sujet sont reconnus automatiquement; un sujet non inscrit devient un nouveau créateur.\n\n" +
  "*Ou ici, en privé :* choisissez le créateur existant dans la liste, puis collez les deux liens.\n\n" +
  "Pour obtenir un lien : dans le groupe source, clic droit sur un message → « Copier le lien du message ».";

const PICK_PAGE = 8;

async function showCreatorPicker(ctx: Context, page: number) {
  const creators = (await listCreators({ status: "active" })).filter((c) => !c.retiredAt);
  const slice = creators.slice(page * PICK_PAGE, page * PICK_PAGE + PICK_PAGE);
  const kb = new InlineKeyboard();
  for (const c of slice) kb.text(`${c.name} (${creatorCollection(c) === "retro" ? "Retro" : "Regular"})`.slice(0, 60), `imp:pick:${c.id}`).row();
  if (page > 0) kb.text("◀️ Préc.", `imp:pg:${page - 1}`);
  if ((page + 1) * PICK_PAGE < creators.length) kb.text("Suiv. ▶️", `imp:pg:${page + 1}`);
  const text = `${IMPORT_HELP}\n\n*Pour quel créateur importer ?*` + (creators.length === 0 ? "\n_Aucun créateur inscrit._" : "");
  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: kb });
  } else {
    await ctx.reply(text, { parse_mode: "Markdown", reply_markup: kb });
  }
}

importsComposer.command("import", async (ctx, next) => {
  const adminId = ctx.from?.id;

  // Private chat: never silent. Admins get the guided flow, others nothing.
  if (ctx.chat.type === "private") {
    if (!adminId || !isAdministrator(adminId)) return next();
    await showCreatorPicker(ctx, 0);
    return;
  }

  if (ctx.chat.type !== "supergroup") return next();
  if (!collectionForChat(ctx.chat.id)) {
    // An administrator typing it in some other group gets a clear answer instead of silence.
    if (adminId && isAdministrator(adminId)) {
      await ctx.reply(
        "ℹ️ Ce groupe n'est pas un forum de créateurs géré par le robot. Tapez /import dans le sujet d'un créateur du forum Regular ou Retro, ou en privé avec le robot.",
        { message_thread_id: ctx.msg.message_thread_id }
      );
      return;
    }
    return next();
  }
  const topicId = ctx.msg.message_thread_id;

  if (!adminId || !isAdministrator(adminId)) {
    // Anonymous admins cannot be identified (and so cannot receive the private preview).
    if (ctx.msg.sender_chat?.id === ctx.chat.id) {
      await ctx.reply("Tapez /import avec votre propre compte (pas en anonyme) : l'aperçu et la confirmation vous sont envoyés en privé.", {
        message_thread_id: topicId,
      });
    }
    return;
  }
  if (!topicId) {
    await ctx.reply("Tapez /import à l'intérieur du sujet du créateur (pas dans « Général »).");
    return;
  }

  const [link1, link2] = (ctx.match ?? "").trim().split(/\s+/);
  if (!link1 || !link2) {
    await ctx.reply(
      "Utilisation (dans le sujet du créateur) : `/import <lien du 1er message> <lien du dernier message>`\n" +
        "Faites un clic droit sur le premier puis sur le dernier commentaire du créateur → « Copier le lien du message ».",
      { parse_mode: "Markdown", message_thread_id: topicId }
    );
    return;
  }

  // New creator (unregistered topic) or update of an existing one.
  let creator = await getCreatorByTopic(ctx.chat.id, topicId);
  const isNewCreator = !creator;
  if (!creator) {
    const name = ctx.msg.reply_to_message?.forum_topic_created?.name;
    if (!name) {
      await ctx.reply("Je ne connais pas le nom de ce sujet : tapez d'abord /register_here Nom du créateur.", { message_thread_id: topicId });
      return;
    }
    creator = await handleForumTopicCreated(ctx.chat.id, topicId, name);
    if (!creator || creator.topicId !== topicId || creator.chatId !== ctx.chat.id) {
      await ctx.reply(
        `⚠️ « ${name} » existe déjà ailleurs dans le répertoire. Utilisez « Passer à Retro » (ou /relink_creator) pour éviter un doublon.`,
        { message_thread_id: topicId }
      );
      return;
    }
  }

  const forum = collectionLabel(creator) as "Retro" | "Regular" | "Amateur";
  const out = await presentImport(ctx.api, { adminId, creator, isNewCreator, link1, link2, forum });
  if (!out.ok) {
    await ctx.reply(`⚠️ ${out.error}`, { message_thread_id: topicId });
  } else if (!out.dmSent) {
    await ctx.reply("⚠️ Je ne peux pas vous écrire en privé : ouvrez d'abord le robot (/start) puis relancez /import.", { message_thread_id: topicId });
  } else {
    await ctx.reply(
      out.blocked
        ? "🚫 Import bloqué — voyez le message privé du robot."
        : `📥 Import préparé pour *${mdEsc(creator.name)}*. Poursuivez dans votre conversation privée avec le robot (aperçu + confirmation).`,
      { parse_mode: "Markdown", message_thread_id: topicId }
    );
  }
});

/** Private-chat flow: creator picked → the next message with two links starts the import. */
export async function handleImportLinks(
  ctx: Context,
  adminId: number,
  creatorId: string,
  rawText: string
): Promise<void> {
  const links = rawText.match(/https?:\/\/\S+|t\.me\/\S+/gi) ?? [];
  const creator = await getCreator(creatorId);
  if (!creator) {
    await ctx.reply("⚠️ Créateur introuvable. Relancez /import.");
    return;
  }
  if (links.length < 2) {
    await requestAdminInput(adminId, { type: "import_links", creatorId });
    await ctx.reply("⚠️ Il me faut *deux* liens (premier et dernier message du bloc), séparés par un espace ou un retour de ligne. Réessayez.", { parse_mode: "Markdown" });
    return;
  }
  const forum = creatorCollection(creator) === "retro" ? "Retro" : "Regular";
  const out = await presentImport(ctx.api, { adminId, creator, isNewCreator: false, link1: links[0]!, link2: links[1]!, forum });
  if (!out.ok) await ctx.reply(`⚠️ ${out.error}`);
}

importsComposer.callbackQuery(/^imp:pg:(\d+)$/, async (ctx, next) => {
  if (!isAdministrator(ctx.from.id)) return next();
  await showCreatorPicker(ctx, Number(ctx.match[1]));
});

importsComposer.callbackQuery(/^imp:pick:([\w-]+)$/, async (ctx, next) => {
  if (!isAdministrator(ctx.from.id)) return next();
  const creator = await getCreator(ctx.match[1]);
  await ctx.answerCallbackQuery();
  if (!creator) return;
  await requestAdminInput(ctx.from.id, { type: "import_links", creatorId: creator.id });
  await ctx.editMessageText(
    `📥 *Import pour ${mdEsc(creator.name)}* (${creatorCollection(creator) === "retro" ? "Retro" : "Regular"})\n\n` +
      `Envoyez maintenant, dans un seul message, les *deux liens* : celui du *premier* message du bloc et celui du *dernier*.\n` +
      `_Clic droit sur un message du groupe source → « Copier le lien du message »._`,
    { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("❌ Annuler", "imp:pg:0") }
  );
});

/** /imports — recent imports with a way to open, stop or undo each one (if the original message is lost). */
importsComposer.command("imports", async (ctx, next) => {
  if (ctx.chat.type !== "private") return next();
  if (!isAdministrator(ctx.from?.id ?? 0)) return;
  const jobs = (await listImportJobs()).slice(0, 8);
  const kb = new InlineKeyboard();
  let text = "📥 *IMPORTS RÉCENTS*\n\n";
  if (jobs.length === 0) text += "_Aucun import._";
  for (const j of jobs) {
    text += `• *${mdEsc(j.creatorName)}* — ${j.status} (${j.copied} copiés)\n`;
    kb.text(`${j.creatorName} · ${j.status}`.slice(0, 60), `imp:st:${j.id}`).row();
  }
  await ctx.reply(text, { parse_mode: "Markdown", reply_markup: kb });
});

// ---- Administrator callbacks (imp:*) ---------------------------------------------------------

importsComposer.use(adminRouteGuard({ callbackPrefixes: ["imp:"], commands: [] }));

/** Every state offers a way out: stop, resume, or undo what was already copied. */
function importKeyboard(j: NonNullable<Awaited<ReturnType<typeof getImportJob>>>): InlineKeyboard {
  const kb = new InlineKeyboard().text("🔄 Actualiser", `imp:st:${j.id}`);
  if (j.status === "failed" || j.status === "needs_review") kb.row().text("▶️ Reprendre", `imp:resume:${j.id}`);
  if (j.status === "prepared" || j.status === "blocked") kb.row().text("❌ Annuler cet import", `imp:no:${j.id}`);
  if (j.status === "running" && j.retryAfter && j.retryAfter > Date.now()) {
    kb.row().text("▶️ Réessayer maintenant", `imp:kick:${j.id}`);
  }
  if (["running", "failed", "needs_review"].includes(j.status)) {
    kb.row().text("⏹ Arrêter (garder ce qui est copié)", `imp:stop:${j.id}`);
  }
  if (["running", "failed", "needs_review", "done"].includes(j.status)) {
    kb.row().text("↩️ Annuler et supprimer les copies…", `imp:undo:${j.id}`);
  }
  return kb;
}

function statusText(j: NonNullable<Awaited<ReturnType<typeof getImportJob>>>): string {
  const label: Record<string, string> = {
    prepared: "en attente de confirmation", blocked: "bloqué", running: "en cours", needs_review: "à vérifier",
    failed: "arrêté (reprenable)", done: "terminé", cancelled: "annulé", undone: "annulé et copies supprimées",
  };
  const wait = waitText(j);
  return `📥 *Import — ${mdEsc(j.creatorName)}* : ${label[j.status] ?? j.status}\n${importProgress(j)}${wait ? `\n${wait}` : ""}${j.note ? `\n_${mdEsc(j.note)}_` : ""}`;
}

importsComposer.callbackQuery(/^imp:go:([\w-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Import lancé…" });
  const res = await startImport(ctx.api, ctx.match[1], ctx.from.id, true);
  if (!res.ok || !res.job) {
    await ctx.editMessageText(`⚠️ ${res.error}`);
    return;
  }
  const j = (await getImportJob(res.job.id))!;
  await ctx.editMessageText(
    statusText(j) +
      (j.status === "running"
        ? `\n\nLa copie se poursuit automatiquement (limites de débit de Telegram : environ 20 à 30 messages par minute). Vous serez averti à la fin.`
        : ""),
    {
      parse_mode: "Markdown",
      reply_markup: importKeyboard(j),
    }
  );
});

importsComposer.callbackQuery(/^imp:st:([\w-]+)$/, async (ctx) => {
  const j = await getImportJob(ctx.match[1]);
  await ctx.answerCallbackQuery();
  if (!j) return;
  await ctx.editMessageText(statusText(j), { parse_mode: "Markdown", reply_markup: importKeyboard(j) });
});

importsComposer.callbackQuery(/^imp:resume:([\w-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Reprise…" });
  await resumeImport(ctx.api, ctx.match[1]);
  const j = await getImportJob(ctx.match[1]);
  if (j) await ctx.editMessageText(statusText(j), { parse_mode: "Markdown", reply_markup: importKeyboard(j) });
});

importsComposer.callbackQuery(/^imp:kick:([\w-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Nouvelle tentative…" });
  await kickImport(ctx.api, ctx.match[1]);
  const j = await getImportJob(ctx.match[1]);
  if (j) await ctx.editMessageText(statusText(j), { parse_mode: "Markdown", reply_markup: importKeyboard(j) });
});

importsComposer.callbackQuery(/^imp:stop:([\w-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const ok = await cancelImport(ctx.match[1], ctx.from.id);
  const j = await getImportJob(ctx.match[1]);
  await ctx.editMessageText(
    ok && j
      ? `⏹ Import arrêté. Ce qui était déjà copié (${j.copied} message(s)) reste dans le sujet. Pour le supprimer aussi, utilisez « Annuler et supprimer les copies ».`
      : "Cet import ne peut plus être arrêté.",
    { reply_markup: j ? new InlineKeyboard().text("↩️ Annuler et supprimer les copies…", `imp:undo:${j.id}`) : undefined }
  );
});

importsComposer.callbackQuery(/^imp:no:([\w-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await cancelImport(ctx.match[1], ctx.from.id);
  await ctx.editMessageText("❌ Import annulé. Rien n'a été copié.");
});

importsComposer.callbackQuery(/^imp:undo:([\w-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    "↩️ *Annuler cet import ?*\nLe robot supprimera *uniquement les messages qu'il a copiés* dans le sujet. Le contenu source n'est pas touché.",
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard().text("Oui, supprimer les copies", `imp:undoyes:${ctx.match[1]}`).row().text("Non, garder", `imp:st:${ctx.match[1]}`),
    }
  );
});

importsComposer.callbackQuery(/^imp:undoyes:([\w-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Suppression…" });
  const res = await undoImport(ctx.api, ctx.match[1], ctx.from.id);
  await ctx.editMessageText(res.ok ? `↩️ Import annulé : ${res.deleted} message(s) supprimé(s).` : `⚠️ ${res.error} (${res.deleted} supprimé(s) avant l'erreur).`);
});
