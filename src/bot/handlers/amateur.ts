/** Amateur access is explicitly granted by admins; its directory is never public. */
import { API_CONSTANTS, Composer, Context, InlineKeyboard } from "grammy";
import { bindPrivateChat, chatBindingCollision, type ChatRole } from "../../db/chat_bindings.ts";
import { getConfig } from "../../config.ts";
import { adminRouteGuard } from "../middleware/auth.ts";
import { amateurChatCollision, bindAmateurForum } from "../../db/amateur.ts";
import { listCreators } from "../../db/creators.ts";
import { directoryContentCounts, isRetired } from "../../directory/sync.ts";
import { getKv } from "../../db/kv.ts";
import { withJobLease } from "../../ops/locks.ts";
import { isMessageGone, isMessageNotModified } from "../../wanted/service.ts";
import { renderNavPage } from "../public_pages.ts";
import { getMembershipSummary } from "../../db/entitlements.ts";
import { hasAccessToSpace } from "../../db/entitlements.ts";
import { recordSyncState } from "../../db/sync.ts";
import { removeMemberFromSpace } from "../../access/sync.ts";
import { getMembershipMode } from "../../membership/mode.ts";
import type { MessageEntity } from "@grammyjs/types";

export const amateurComposer = new Composer();
amateurComposer.use(adminRouteGuard({ callbackPrefixes: ["amateur:"], commands: ["setup_amateur", "setup_amateur_chat", "setup_admin_review"] }));

amateurComposer.callbackQuery("member:amateur", async (ctx) => {
  await ctx.answerCallbackQuery();
  const page = await renderNavPage("amateur", ctx.api, await getMembershipSummary(ctx.from.id), await getMembershipMode());
  await ctx.editMessageText(page.text, { parse_mode: "Markdown", reply_markup: page.kb });
});

function privateAdmin(ctx: Context): boolean { return ctx.chat?.type === "private"; }

amateurComposer.callbackQuery("amateur:admin", async (ctx) => {
  if (!privateAdmin(ctx)) { await ctx.answerCallbackQuery({ text: "Ouvrez le bot en privé pour administrer Amateur.", show_alert: true }); return; }
  await ctx.answerCallbackQuery();
  const configured = !!getConfig().TELEGRAM_AMATEUR_FORUM_CHAT_ID;
  await ctx.editMessageText("🔒 AMATEUR — ADMINISTRATION\n\n" +
    `Forum : ${configured ? "configuré" : "pas encore configuré"}.\n` +
    "L'accès Amateur est accordé explicitement par un administrateur. Il comprend Amateur, son clavardage, les collections en activité et Retro, le clavardage commun et Wanted. Les abonnements et récompenses Regular/Retro ne débloquent pas Amateur.\n\n" +
    "Pour le configurer : créez un groupe privé avec les sujets activés, ajoutez le bot comme administrateur (inviter et restreindre les membres), puis envoyez /setup_amateur dans ce groupe.\n" +
    "Dans le clavardage Amateur privé : /setup_amateur_chat. Dans le groupe privé des administrateurs : /setup_admin_review.\n" +
    "Inscrivez les créateurs avec /register_here Nom dans chaque sujet, ou avec une publication administrateur.\n\n" +
    "Le répertoire Amateur reste dans votre conversation privée avec le bot. Son actualisation ne publie rien dans le canal du répertoire.", {
      reply_markup: new InlineKeyboard().text("📋 Répertoire Amateur (privé)", "amateur:directory").row()
        .text("🔐 Accorder un accès Amateur", "admin:grant_wizard").row().text("⬅️ Administration", "admin:menu"),
    });
});

amateurComposer.command("setup_amateur", async (ctx) => {
  if (!ctx.from) return;
  const chat = await ctx.api.getChat(ctx.chat.id);
  if (chat.type !== "supergroup" || !chat.is_forum || chat.username || chat.linked_chat_id) {
    await ctx.reply("Exécutez /setup_amateur dans le groupe Amateur privé, avec les sujets activés."); return;
  }
  if (amateurChatCollision(chat.id)) { await ctx.reply("⚠️ Utilisez un nouveau forum privé distinct des collections et canaux publics existants."); return; }
  const configured = getConfig().TELEGRAM_AMATEUR_FORUM_CHAT_ID;
  if (configured && configured !== chat.id) { await ctx.reply("Un autre forum Amateur est déjà configuré."); return; }
  const bot = await ctx.api.getChatMember(chat.id, ctx.me.id);
  if (bot.status !== "administrator" || !bot.can_invite_users || !bot.can_restrict_members) {
    await ctx.reply("⚠️ Le bot doit être administrateur avec les droits d'inviter et de restreindre les membres."); return;
  }
  try {
    const webhook = await ctx.api.getWebhookInfo();
    if (webhook.url) {
      await ctx.api.setWebhook(webhook.url, {
        secret_token: getConfig().WEBHOOK_SECRET,
        allowed_updates: webhook.allowed_updates?.length
          ? [...new Set([...webhook.allowed_updates, "chat_member" as const])]
          : [...API_CONSTANTS.ALL_UPDATE_TYPES],
      });
    }
    // Preserve other permissions; prevent members from adding people around the grant gate.
    await ctx.api.setChatPermissions(chat.id, { ...chat.permissions, can_invite_users: false });
    await bindAmateurForum(chat.id, ctx.from.id);
    await ctx.reply("✅ Forum Amateur configuré. Accès fermé par défaut : seul un accès Amateur accordé séparément par un administrateur permet d'entrer. Répertoire disponible dans Administration → Amateur, en privé.");
  } catch (error) { await ctx.reply(`⚠️ ${error instanceof Error ? error.message : String(error)}`); }
});

// Even a person added through another invite must have the explicit admin grant.
amateurComposer.on("chat_member", async (ctx, next) => {
  const update = ctx.chatMember;
  const config = getConfig();
  const space = update.chat.id === config.TELEGRAM_AMATEUR_FORUM_CHAT_ID ? "amateur_collections" :
    config.TELEGRAM_AMATEUR_CHAT_ID && update.chat.id === config.TELEGRAM_AMATEUR_CHAT_ID ? "amateur_chat" : null;
  if (!space) return next();
  const member = update.new_chat_member;
  const inside = member.status === "member" || member.status === "creator" || member.status === "administrator" ||
    (member.status === "restricted" && member.is_member);
  if (!inside || member.user.id === ctx.me.id) return;
  const userId = member.user.id;
  await recordSyncState({ userId, spaceId: space, chatId: update.chat.id, status: "admitted", lastSyncAt: new Date().toISOString() });
  if (!await hasAccessToSpace(userId, space)) {
    await removeMemberFromSpace(ctx.api, space, userId, {
      stillIneligible: async () => !await hasAccessToSpace(userId, space),
    });
  }
});

amateurComposer.callbackQuery("amateur:directory", async (ctx) => {
  if (!privateAdmin(ctx)) { await ctx.answerCallbackQuery({ text: "Le répertoire Amateur est réservé aux administrateurs en conversation privée.", show_alert: true }); return; }
  await ctx.answerCallbackQuery();
  const root = ctx.callbackQuery.message?.message_id;
  if (!root) return;
  await withJobLease(`amateur_directory:${ctx.from.id}:${root}`, 60_000, async () => {
    const creators = (await listCreators({ collection: "amateur", status: "active", hasContentOnly: true })).filter((c) => !isRetired(c));
    const counts = await directoryContentCounts(creators);
    const header = "🔒 RÉPERTOIRE AMATEUR — PRIVÉ\nAccès sur autorisation administrative uniquement.\n(? = inventaire inconnu ; + = inventaire partiel)\n\n";
    const chunks: { text: string; entities: MessageEntity[] }[] = [];
    let chunk = { text: header, entities: [] as MessageEntity[] };
    for (const creator of creators) {
      const name = creator.name.replace(/\s+/g, " ").trim();
      const count = counts.get(creator.id) ?? 0;
      const total = !count && creator.inventoryStatus !== "complete" ? "?" : `${count}${creator.inventoryStatus === "complete" ? "" : "+"}`;
      const line = `${name} (${total})\n`;
      if (chunk.text.length + line.length > 3500 || chunk.entities.length >= 80) { chunks.push(chunk); chunk = { text: header, entities: [] }; }
      chunk.entities.push({ type: "text_link", offset: chunk.text.length, length: name.length,
        url: `https://t.me/c/${String(creator.chatId).slice(4)}/${creator.topicId}` });
      chunk.text += line;
    }
    if (!creators.length) chunk.text += "Aucun créateur Amateur inscrit avec du contenu pour le moment.";
    chunks.push(chunk);
    const kv = await getKv();
    const key = ["amateur_directory_view", ctx.from.id, root];
    const previous = (await kv.get<number[]>(key)).value ?? [];
    const ids: number[] = [];
    for (const [index, message] of chunks.entries()) {
      const options = { entities: message.entities, link_preview_options: { is_disabled: true },
        reply_markup: index === 0 ? new InlineKeyboard().text("🔄 Actualiser la liste privée", "amateur:directory").row()
          .text("⬅️ Amateur", "amateur:admin") : undefined };
      if (index === 0) {
        try { await ctx.editMessageText(message.text, options); } catch (error) { if (!isMessageNotModified(error)) throw error; }
      } else {
        let id = previous[index - 1];
        if (id) {
          try { await ctx.api.editMessageText(ctx.from.id, id, message.text, options); }
          catch (error) { if (isMessageGone(error)) id = (await ctx.reply(message.text, options)).message_id; else if (!isMessageNotModified(error)) throw error; }
        } else id = (await ctx.reply(message.text, options)).message_id;
        ids.push(id);
        await kv.set(key, [...ids, ...previous.slice(ids.length)]);
      }
    }
    for (const id of previous.slice(ids.length)) await ctx.api.deleteMessage(ctx.from.id, id).catch(() => {});
    await kv.set(key, ids);
  });
});

async function setupPrivateChat(ctx: Context, role: ChatRole) {
  if (!ctx.from || !ctx.chat) return;
  const chat = await ctx.api.getChat(ctx.chat.id);
  if (chat.type !== "supergroup" || chat.username || chat.linked_chat_id || chatBindingCollision(chat.id, role)) {
    await ctx.reply("Utilisez un nouveau supergroupe privé distinct des collections, canaux et autres groupes."); return;
  }
  const current = role === "amateur_chat" ? getConfig().TELEGRAM_AMATEUR_CHAT_ID : getConfig().TELEGRAM_ADMIN_REVIEW_CHAT_ID;
  if (current && current !== chat.id) { await ctx.reply("Un autre groupe est déjà configuré pour ce rôle."); return; }
  const bot = await ctx.api.getChatMember(chat.id, ctx.me.id);
  if (bot.status !== "administrator" || !bot.can_invite_users || !bot.can_restrict_members) {
    await ctx.reply("Le bot doit être administrateur avec les droits d'inviter et de restreindre les membres."); return;
  }
  try {
    const webhook = await ctx.api.getWebhookInfo();
    if (webhook.url) await ctx.api.setWebhook(webhook.url, {
      secret_token: getConfig().WEBHOOK_SECRET,
      allowed_updates: webhook.allowed_updates?.length ? [...new Set([...webhook.allowed_updates, "chat_member" as const])] : [...API_CONSTANTS.ALL_UPDATE_TYPES],
    });
    await ctx.api.setChatPermissions(chat.id, { ...chat.permissions, can_invite_users: false });
    await bindPrivateChat(role, chat.id, ctx.from.id);
    await ctx.reply(role === "amateur_chat"
      ? "✅ Clavardage Amateur configuré. Les autorisations Amateur existantes et futures donnent accès à ce groupe. Les demandes d'entrée sont vérifiées par le bot."
      : "✅ Groupe de modération configuré. Les nouvelles contributions et leurs décisions seront visibles ici. Seuls les administrateurs déclarés dans ADMIN_USER_IDS peuvent approuver, refuser et accorder une récompense. Réservez ce groupe à votre équipe.");
  } catch (error) { await ctx.reply(`⚠️ ${error instanceof Error ? error.message : String(error)}`); }
}
amateurComposer.command("setup_amateur_chat", ctx => setupPrivateChat(ctx, "amateur_chat"));
amateurComposer.command("setup_admin_review", ctx => setupPrivateChat(ctx, "admin_review"));
