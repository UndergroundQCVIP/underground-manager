/** Amateur access is explicitly granted by admins; its directory is never public. */
import { API_CONSTANTS, Composer, Context, InlineKeyboard } from "grammy";
import { bindPrivateChat, chatBindingCollision, migratePrivateChatBinding, type ChatRole } from "../../db/chat_bindings.ts";
import { getConfig, isAdministrator } from "../../config.ts";
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
import { getOrCreateJoinLink } from "../../access/links.ts";
import { removeMemberFromSpace } from "../../access/sync.ts";
import { getMembershipMode } from "../../membership/mode.ts";
import type { MessageEntity } from "@grammyjs/types";

export const amateurComposer = new Composer();
// Anonymous group admins cannot prove which configured bot administrator they are.
amateurComposer.use(async (ctx, next) => {
  if (ctx.hasCommand(["setup_amateur", "setup_amateur_chat", "setup_admin_review"]) && ctx.message?.sender_chat && !isAdministrator(ctx.from?.id ?? 0)) {
    await ctx.reply("Envoyez cette commande avec votre profil personnel d’administrateur, sans le mode anonyme, ou en privé au bot avec l’identifiant du groupe."); return;
  }
  await next();
});
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

function setupMigrationId(error: unknown): number | undefined {
  const migrated = (error as { parameters?: { migrate_to_chat_id?: number } })?.parameters?.migrate_to_chat_id;
  return Number.isSafeInteger(migrated) && migrated! < 0 ? migrated : undefined;
}

async function setupPrivateChat(ctx: Context, role: ChatRole, migratedTarget?: number) {
  if (!ctx.from || !ctx.chat) return;
  const reply = (text: string) => migratedTarget && ctx.chat?.type !== "private"
    ? ctx.api.sendMessage(migratedTarget, text) : ctx.reply(text);
  const command = role === "amateur_chat" ? "/setup_amateur_chat" : "/setup_admin_review";
  const argument = typeof ctx.match === "string" ? ctx.match.trim() : "";
  if (!migratedTarget && ctx.chat.type === "private" && !/^-\d+$/.test(argument)) {
    await reply(`Envoyez ${command} dans le groupe privé à connecter, ou ${command} -IDENTIFIANT_DU_GROUPE ici. Ajoutez d’abord le bot comme administrateur du groupe.`); return;
  }
  const target = migratedTarget ?? (ctx.chat.type === "private" ? Number(argument) : ctx.chat.id);
  let stage = "lecture du groupe";
  let configured = false;
  try {
    if (!Number.isSafeInteger(target) || target >= 0) throw new Error("Identifiant de groupe invalide.");
    const chat = await ctx.api.getChat(target);
    if ((chat.type !== "group" && chat.type !== "supergroup") || ("username" in chat && chat.username) || ("linked_chat_id" in chat && chat.linked_chat_id)) {
      await reply("Utilisez un groupe de discussion privé, sans lien avec un canal public."); return;
    }
    if (chatBindingCollision(chat.id, role)) {
      await reply("Ce groupe est déjà utilisé pour une collection, un canal ou un autre clavardage. Choisissez un groupe de discussion privé distinct du forum Amateur."); return;
    }
    const current = role === "amateur_chat" ? getConfig().TELEGRAM_AMATEUR_CHAT_ID : getConfig().TELEGRAM_ADMIN_REVIEW_CHAT_ID;
    if (current && current !== chat.id) { await reply("Un autre groupe est déjà configuré pour ce rôle. Sa liaison ne sera pas remplacée automatiquement."); return; }
    stage = "vérification des droits du bot";
    const bot = await ctx.api.getChatMember(chat.id, ctx.me.id);
    if (bot.status !== "administrator" || !bot.can_invite_users || !bot.can_restrict_members) {
      await reply("Le bot doit être administrateur du groupe avec les droits « Inviter des utilisateurs » et « Bannir/restreindre des membres ». Activez ces droits puis relancez la commande."); return;
    }
    // Without the full existing permissions, changing defaults could silence the chat.
    if (!chat.permissions) throw new Error("Les permissions actuelles du groupe sont indisponibles. Vérifiez les droits du bot puis réessayez.");
    stage = "activation des demandes d’adhésion";
    const webhook = await ctx.api.getWebhookInfo();
    if (webhook.url) await ctx.api.setWebhook(webhook.url, {
      secret_token: getConfig().WEBHOOK_SECRET,
      allowed_updates: webhook.allowed_updates?.length
        ? [...new Set([...webhook.allowed_updates, "chat_member" as const, "chat_join_request" as const])]
        : [...API_CONSTANTS.ALL_UPDATE_TYPES],
    });
    stage = "protection des invitations";
    await ctx.api.setChatPermissions(chat.id, { ...chat.permissions, can_invite_users: false });
    stage = "enregistrement du groupe";
    await bindPrivateChat(role, chat.id, ctx.from.id);
    configured = true;
    if (role === "amateur_chat") {
      stage = "création du lien d’accès";
      await getOrCreateJoinLink(ctx.api, "amateur_chat");
    }
    await reply(role === "amateur_chat"
      ? `✅ Clavardage Amateur configuré : ${chat.title}. Les autorisations Amateur existantes et futures donnent accès à ce groupe depuis le bouton Amateur ou Mes canaux. Les demandes d’entrée sont vérifiées par le bot.`
      : `✅ Groupe de modération configuré : ${chat.title}. Les nouvelles contributions et leurs décisions seront visibles ici. Seuls les administrateurs déclarés dans ADMIN_USER_IDS peuvent approuver, refuser et accorder une récompense. Réservez ce groupe à votre équipe.`);
  } catch (error) {
    const migration = setupMigrationId(error);
    if (migration && !migratedTarget) {
      try {
        const migratedChat = await ctx.api.getChat(migration);
        if (migratedChat.type !== "supergroup" || migratedChat.username || migratedChat.linked_chat_id) throw new Error("Le groupe migré doit rester privé et distinct des canaux publics.");
        await migratePrivateChatBinding(target, migration);
      }
      catch (migrationError) { await reply(`⚠️ ${migrationError instanceof Error ? migrationError.message : String(migrationError)}`); return; }
      await setupPrivateChat(ctx, role, migration); return;
    }
    await reply(`⚠️ ${configured ? "Groupe enregistré, mais étape incomplète" : "Configuration impossible"} (${stage}) : ${error instanceof Error ? error.message : String(error)}. Réessayez la commande une fois le problème corrigé.`);
  }
}
amateurComposer.command("setup_amateur_chat", ctx => setupPrivateChat(ctx, "amateur_chat"));
amateurComposer.command("setup_admin_review", ctx => setupPrivateChat(ctx, "admin_review"));

// Preserve a configured chat when Telegram upgrades a basic group to a supergroup.
amateurComposer.on(["message:migrate_to_chat_id", "message:migrate_from_chat_id"], async (ctx, next) => {
  const oldId = ctx.message.migrate_from_chat_id ?? ctx.chat.id;
  const newId = ctx.message.migrate_to_chat_id ?? ctx.chat.id;
  if (![getConfig().TELEGRAM_AMATEUR_CHAT_ID, getConfig().TELEGRAM_ADMIN_REVIEW_CHAT_ID].includes(oldId)) return next();
  const chat = await ctx.api.getChat(newId);
  if (chat.type !== "supergroup" || chat.username || chat.linked_chat_id) return;
  await migratePrivateChatBinding(oldId, newId);
});
