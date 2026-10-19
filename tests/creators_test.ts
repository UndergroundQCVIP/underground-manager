/**
 * LA CONFRÉRIE — UG-02 Pre-Publish Test Suite: CREATORS & FORUM TOPICS
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import { setupTestEnvironment } from "./test_helpers.ts";
import {
  handleForumTopicCreated,
  handleForumTopicEdited,
  handleMediaUpload,
  registerOrRepairTopic,
} from "../src/creators/service.ts";
import {
  getCreator,
  getCreatorByName,
  getCreatorByTopic,
  listCreators,
} from "../src/db/creators.ts";
import { createWantedCandidate, getWantedCandidate } from "../src/db/wanted.ts";

Deno.test("CREATORS — New topic detection registers creator without public availability until media added", async () => {
  const kv = await setupTestEnvironment();
  try {
    const forumChatId = -1001001;
    const threadId = 101;

    // 1. Admin creates a topic named "Aria"
    const creator = await handleForumTopicCreated(forumChatId, threadId, "Aria");
    assertNotEquals(creator, null);
    assertEquals(creator?.name, "Aria");
    assertEquals(creator?.topicId, threadId);
    assertEquals(creator?.chatId, forumChatId);
    assertEquals(creator?.hasContent, false); // Initially empty!

    // Empty creator should NOT be returned when filtering for public directory (hasContentOnly)
    const publicCreators = await listCreators({ status: "active", hasContentOnly: true });
    assertEquals(publicCreators.length, 0);

    // But should be visible in internal database
    const all = await listCreators();
    assertEquals(all.length, 1);
  } finally {
    await kv.close();
  }
});

Deno.test("CREATORS — Excludes General and system topics from registration", async () => {
  const kv = await setupTestEnvironment();
  try {
    const forumChatId = -1001001;

    const generalTopic = await handleForumTopicCreated(forumChatId, 1, "General");
    assertEquals(generalTopic, null);

    const announcements = await handleForumTopicCreated(forumChatId, 2, "Announcements");
    assertEquals(announcements, null);

    const adminTopic = await handleForumTopicCreated(forumChatId, 3, "Admin");
    assertEquals(adminTopic, null);

    const all = await listCreators();
    assertEquals(all.length, 0);
  } finally {
    await kv.close();
  }
});

Deno.test("CREATORS — Topic rename updates display name without creating duplicate record", async () => {
  const kv = await setupTestEnvironment();
  try {
    const forumChatId = -1001001;
    const threadId = 102;

    await handleForumTopicCreated(forumChatId, threadId, "Sophie VIP");
    let creator = await getCreatorByTopic(forumChatId, threadId);
    assertEquals(creator?.name, "Sophie VIP");

    // Admin renames topic to "Sophie"
    await handleForumTopicEdited(forumChatId, threadId, "Sophie");

    creator = await getCreatorByTopic(forumChatId, threadId);
    assertEquals(creator?.name, "Sophie");

    // Ensure only 1 record exists in database
    const all = await listCreators();
    assertEquals(all.length, 1);

    // Old name index should resolve to null or updated
    const byOld = await getCreatorByName("Sophie VIP");
    assertEquals(byOld, null);

    const byNew = await getCreatorByName("Sophie");
    assertEquals(byNew?.id, creator?.id);
  } finally {
    await kv.close();
  }
});

Deno.test("CREATORS — Authorized media upload activates content availability", async () => {
  const kv = await setupTestEnvironment();
  try {
    const forumChatId = -1001001;
    const threadId = 103;
    const adminUserId = 111111;
    const unauthorizedUserId = 999999;

    await handleForumTopicCreated(forumChatId, threadId, "Maya");

    // 1. Non-admin uploads media -> ignored
    const nonAdminResult = await handleMediaUpload(forumChatId, threadId, unauthorizedUserId);
    assertEquals(nonAdminResult, null);

    let creator = await getCreatorByTopic(forumChatId, threadId);
    assertEquals(creator?.hasContent, false);

    // 2. Admin uploads media -> activates content availability and sets timestamp
    const adminResult = await handleMediaUpload(forumChatId, threadId, adminUserId);
    assertNotEquals(adminResult, null);
    assertEquals(adminResult?.hasContent, true);
    assertNotEquals(adminResult?.lastContentUpdatedAt, undefined);

    // Now creator should be available for public directory
    const publicCreators = await listCreators({ status: "active", hasContentOnly: true });
    assertEquals(publicCreators.length, 1);
    assertEquals(publicCreators[0].name, "Maya");
  } finally {
    await kv.close();
  }
});

Deno.test("CREATORS — Connecting Wanted candidate when topic created with matching name", async () => {
  const kv = await setupTestEnvironment();
  try {
    const forumChatId = -1001001;
    const threadId = 104;

    // Create a Wanted candidate named "Lena"
    const wanted = await createWantedCandidate({
      name: "Lena",
      normalizedName: "lena",
      status: "selected",
      suggestedBy: 5001,
      supportCount: 15,
    });

    // Admin creates "Lena" topic in forum
    const creator = await handleForumTopicCreated(forumChatId, threadId, "Lena");
    assertEquals(creator?.wantedListId, wanted.id);

    // Wanted candidate should now automatically be marked 'available'
    const updatedWanted = await getWantedCandidate(wanted.id);
    assertEquals(updatedWanted?.status, "available");
    assertEquals(updatedWanted?.creatorId, creator?.id);
  } finally {
    await kv.close();
  }
});

Deno.test("CREATORS — Manual administrator topic registration and repair", async () => {
  const kv = await setupTestEnvironment();
  try {
    const forumChatId = -1001001;
    const threadId = 105;
    const adminId = 111111;

    // Admin executes /register_creator 105 Chloe
    const creator = await registerOrRepairTopic(adminId, forumChatId, threadId, "Chloe");
    assertEquals(creator.name, "Chloe");
    assertEquals(creator.topicId, threadId);
    assertEquals(creator.hasContent, true);

    const fetched = await getCreator(creator.id);
    assertEquals(fetched?.name, "Chloe");
  } finally {
    await kv.close();
  }
});
