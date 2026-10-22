/**
 * LA CONFRÉRIE — Forum Topics Event Handlers
 * Detects creator topic creation, renames, and authorized media uploads in the Regular and Retro forums.
 */

import { Composer, Context } from "grammy";
import { isAdministrator } from "../../config.ts";
import {
  collectionForChat,
  handleForumTopicCreated,
  handleForumTopicEdited,
  handleMediaUpload,
  registerOrRepairTopic,
} from "../../creators/service.ts";
import { collectionLabel } from "../../creators/admin.ts";
import { getKv } from "../../db/kv.ts";

export const forumComposer = new Composer();

/**
 * Topic creation/rename changes the PUBLIC directory, so only administrators (or
 * the bot itself) may drive it — a member with "manage topics" rights must not be
 * able to publish arbitrary names.
 */
function isTopicAuthority(ctx: Context): boolean {
  const id = ctx.from?.id;
  return (id !== undefined && (isAdministrator(id) || id === ctx.me.id)) || isAnonymousGroupAdmin(ctx);
}

/**
 * An administrator posting "as the group" (anonymous admin): Telegram sets sender_chat to the
 * group itself, which only real group administrators can do.
 */
function isAnonymousGroupAdmin(ctx: Context): boolean {
  const msg = ctx.msg;
  return !!msg && msg.sender_chat !== undefined && msg.sender_chat.id === ctx.chat?.id;
}

/** Tell administrators at most once a day per place, so a misconfiguration is visible but quiet. */
async function hintOncePerDay(ctx: Context, key: (string | number)[], message: string): Promise<void> {
  const kv = await getKv();
  const flagKey = ["forum_hint", ...key];
  if ((await kv.get(flagKey)).value) return;
  await kv.set(flagKey, true, { expireIn: 24 * 3600 * 1000 });
  await ctx.reply(message, { message_thread_id: ctx.msg?.message_thread_id }).catch(() => {});
}

/**
 * /register_here [name] — typed by an administrator INSIDE a creator topic.
 * The Bot API cannot list a forum's existing topics, so this is how a topic that
 * existed before the bot is registered (Regular or Retro, decided by the forum).
 */
forumComposer.command("register_here", async (ctx) => {
  if (ctx.chat.type !== "supergroup" || !isTopicAuthority(ctx)) return;
  const collection = collectionForChat(ctx.chat.id);
  if (!collection) {
    await ctx.reply(
      `⚠️ Ce forum n'est pas géré par le robot. Vérifiez que son identifiant (${ctx.chat.id}) correspond à VIP_COLLECTIONS_CHAT_ID, TELEGRAM_RETRO_FORUM_CHAT_ID ou TELEGRAM_AMATEUR_FORUM_CHAT_ID dans l'environnement du robot (Deno Deploy), puis redéployez.`,
      { message_thread_id: ctx.msg.message_thread_id }
    );
    return;
  }
  const threadId = ctx.msg.message_thread_id;
  if (!threadId) {
    await ctx.reply("Tapez cette commande à l'intérieur du sujet du créateur (pas dans « Général »).");
    return;
  }
  const name = (ctx.match?.trim() || ctx.msg.reply_to_message?.forum_topic_created?.name || "").trim();
  if (!name) {
    await ctx.reply("Je ne connais pas le nom de ce sujet. Précisez-le : /register_here Nom du créateur", {
      message_thread_id: threadId,
    });
    return;
  }
  try {
    const creator = await registerOrRepairTopic(ctx.from?.id ?? 0, ctx.chat.id, threadId, name);
    await ctx.reply(
      `✅ « ${creator.name} » est inscrit (${collectionLabel(creator)}). ${collection === "amateur" ? "Son répertoire reste privé, dans Administration → Amateur." : "Il apparaît dans le répertoire à la prochaine synchronisation."}`,
      { message_thread_id: threadId }
    );
  } catch (err) {
    await ctx.reply(`⚠️ ${err instanceof Error ? err.message : String(err)}`, { message_thread_id: threadId });
  }
});

// Detect new forum topics created
forumComposer.on("message:forum_topic_created", async (ctx) => {
  const threadId = ctx.message.message_thread_id;
  const topicName = ctx.message.forum_topic_created.name;

  if (threadId && topicName && isTopicAuthority(ctx)) {
    try {
      await handleForumTopicCreated(ctx.chat.id, threadId, topicName);
    } catch (err) {
      console.error("Error handling forum_topic_created:", err);
    }
  }
});

// Detect topic renames
forumComposer.on("message:forum_topic_edited", async (ctx) => {
  const threadId = ctx.message.message_thread_id;
  const newName = ctx.message.forum_topic_edited.name;

  if (threadId && newName && isTopicAuthority(ctx)) {
    try {
      await handleForumTopicEdited(ctx.chat.id, threadId, newName);
    } catch (err) {
      console.error("Error handling forum_topic_edited:", err);
    }
  }
});

// Detect photos and videos inside creator topics
forumComposer.on(["message:photo", "message:video"], async (ctx) => {
  const threadId = ctx.message.message_thread_id;
  const senderId = ctx.from?.id;

  if (threadId && senderId) {
    try {
      const msg = ctx.message;
      const media = {
        messageId: msg.message_id,
        kind: (msg.photo ? "photo" : "video") as "photo" | "video",
        mediaGroupId: msg.media_group_id,
        hasCaption: !!msg.caption,
      };
      const anonymousAdmin = isAnonymousGroupAdmin(ctx);
      const opts = { trustedAnonymousAdmin: anonymousAdmin };
      let creator = await handleMediaUpload(ctx.chat.id, threadId, senderId, msg.date, media, opts);
      const isAdminSender = isAdministrator(senderId) || anonymousAdmin;

      // A topic that existed before the bot was in the forum was never registered. Telegram
      // includes the topic's own name on messages posted inside it, so an ADMINISTRATOR's
      // first upload registers it (Regular or Retro) and is then counted — no manual step.
      if (!creator && (isAdministrator(senderId) || anonymousAdmin)) {
        const topicName = msg.reply_to_message?.forum_topic_created?.name;
        if (topicName) {
          const registered = await handleForumTopicCreated(ctx.chat.id, threadId, topicName);
          if (registered) {
            creator = await handleMediaUpload(ctx.chat.id, threadId, senderId, msg.date, media, opts);
          }
        }
      }

      // Still nothing registered although an administrator uploaded media: say why, once a day.
      if (!creator && isAdminSender) {
        if (!collectionForChat(ctx.chat.id)) {
          await hintOncePerDay(ctx, [ctx.chat.id], `⚠️ Ce forum n'est pas géré par le robot : son identifiant (${ctx.chat.id}) ne correspond ni à VIP_COLLECTIONS_CHAT_ID ni à TELEGRAM_RETRO_FORUM_CHAT_ID ni à TELEGRAM_AMATEUR_FORUM_CHAT_ID dans l'environnement du robot. Corrigez la configuration puis redéployez.`);
        } else {
          await hintOncePerDay(ctx, [ctx.chat.id, threadId], "ℹ️ Ce sujet n'est pas encore inscrit au répertoire. Tapez /register_here ici pour l'inscrire.");
        }
      }
    } catch (err) {
      console.error("Error handling creator media upload:", err);
    }
  }
});
