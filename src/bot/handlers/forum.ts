/**
 * LA CONFRÉRIE — Forum Topics Event Handlers
 * Detects creator topic creation, renames, and authorized media uploads in the Regular and Retro forums.
 */

import { Composer } from "grammy";
import {
  handleForumTopicCreated,
  handleForumTopicEdited,
  handleMediaUpload,
} from "../../creators/service.ts";

export const forumComposer = new Composer();

// Detect new forum topics created
forumComposer.on("message:forum_topic_created", async (ctx) => {
  const threadId = ctx.message.message_thread_id;
  const topicName = ctx.message.forum_topic_created.name;

  if (threadId && topicName) {
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

  if (threadId && newName) {
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
      await handleMediaUpload(ctx.chat.id, threadId, senderId, {
        messageId: msg.message_id,
        kind: msg.photo ? "photo" : "video",
        mediaGroupId: msg.media_group_id,
        hasCaption: !!msg.caption,
      });
    } catch (err) {
      console.error("Error handling creator media upload:", err);
    }
  }
});
