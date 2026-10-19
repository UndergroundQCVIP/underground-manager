/**
 * Underground Manager — Forum Topics Event Handlers
 * Detects creator topic creation, renames, and authorized media uploads in TOKEBEC VIP COLLECTIONS.
 */

import { Composer, Context } from "grammy";
import { isAdministrator } from "../../config.ts";
import {
  handleForumTopicCreated,
  handleForumTopicEdited,
  handleMediaUpload,
} from "../../creators/service.ts";

export const forumComposer = new Composer();

/**
 * Topic creation/rename changes the PUBLIC directory, so only administrators (or
 * the bot itself) may drive it — a member with "manage topics" rights must not be
 * able to publish arbitrary names.
 */
function isTopicAuthority(ctx: Context): boolean {
  const id = ctx.from?.id;
  return id !== undefined && (isAdministrator(id) || id === ctx.me.id);
}

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
      await handleMediaUpload(ctx.chat.id, threadId, senderId, ctx.message.date);
    } catch (err) {
      console.error("Error handling creator media upload:", err);
    }
  }
});
