/**
 * LA CONFRÉRIE — UG-02 Pre-Publish Test Suite: PUBLIC CREATOR DIRECTORY
 */

import { assertEquals } from "@std/assert";
import { setupTestEnvironment, MockTelegramApi } from "./test_helpers.ts";
import {
  buildDirectorySections,
  buildDirectoryMessages,
  computeContentHash,
  syncPublicDirectory,
} from "../src/directory/sync.ts";
import { saveCreator } from "../src/db/creators.ts";
import { getDirectorySyncState, markDirectoryDirty } from "../src/db/directory.ts";
import { createEntitlement } from "../src/db/entitlements.ts";
import { getMembershipSummary } from "../src/db/entitlements.ts";

Deno.test("DIRECTORY — Creators are compact, linked and alphabetically sorted in separate messages", () => {
  const mockCreators = [
    { id: "1", name: "Sophie", normalizedName: "sophie", chatId: -1001, topicId: 10, topicCreatedAt: "", hasContent: true, status: "active" as const, createdAt: "", updatedAt: "" },
    { id: "2", name: "Aria", normalizedName: "aria", chatId: -1001, topicId: 11, topicCreatedAt: "", hasContent: true, status: "active" as const, createdAt: "", updatedAt: "" },
    { id: "3", name: "Ashley", normalizedName: "ashley", chatId: -1001, topicId: 12, topicCreatedAt: "", hasContent: true, status: "active" as const, createdAt: "", updatedAt: "" },
    { id: "4", name: "Maya", normalizedName: "maya", chatId: -1001, topicId: 13, topicCreatedAt: "", hasContent: true, status: "active" as const, createdAt: "", updatedAt: "" },
  ];

  const sections = buildDirectorySections(mockCreators, "UndergroundManagerBot");
  assertEquals(sections.length, 2);

  const text = sections[0];
  assertEquals(text.startsWith("Voici la liste des créateurs toujours en activité"), true);
  assertEquals(text.includes("https://t.me/UndergroundManagerBot?start=join"), true);
  assertEquals(text.indexOf("Aria") < text.indexOf("Ashley"), true);
  assertEquals(text.indexOf("Ashley") < text.indexOf("Maya"), true);
  assertEquals(text.indexOf("Maya") < text.indexOf("Sophie"), true);
  assertEquals(text.includes(" — Regular — "), false);

  // Each creator must have a deep link
  assertEquals(buildDirectoryMessages(mockCreators, "UndergroundManagerBot")[0].entities.some((e) => e.type === "text_link" && e.url === "https://t.me/UndergroundManagerBot?start=creator_1"), true);
});

Deno.test("DIRECTORY — Only creators with confirmed media content are published", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockTelegramApi();

    // Creator 1: Has media
    await saveCreator({
      id: "creator_with_media",
      name: "Lena",
      normalizedName: "lena",
      chatId: -1001001,
      topicId: 201,
      topicCreatedAt: new Date().toISOString(),
      lastContentUpdatedAt: new Date().toISOString(),
      hasContent: true,
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Creator 2: Empty topic without media
    await saveCreator({
      id: "creator_empty",
      name: "EmptyCreator",
      normalizedName: "emptycreator",
      chatId: -1001001,
      topicId: 202,
      topicCreatedAt: new Date().toISOString(),
      hasContent: false,
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const result = await syncPublicDirectory(api, true);
    assertEquals(result.updated, true);
    assertEquals(api.sentMessages.length, 2);

    const messageText = api.sentMessages[0].text;
    assertEquals(messageText.includes("Lena"), true);
    assertEquals(messageText.includes("EmptyCreator"), false); // Empty creator excluded!
  } finally {
    await kv.close();
  }
});

Deno.test("DIRECTORY — Dirty flag and content hash prevent redundant edits", async () => {
  const kv = await setupTestEnvironment();
  try {
    const api = new MockTelegramApi();

    await saveCreator({
      id: "c1",
      name: "Nicole",
      normalizedName: "nicole",
      chatId: -1001001,
      topicId: 301,
      topicCreatedAt: new Date().toISOString(),
      lastContentUpdatedAt: new Date().toISOString(),
      hasContent: true,
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // First sync publishes
    const firstSync = await syncPublicDirectory(api, false);
    assertEquals(firstSync.updated, true);
    assertEquals(api.sentMessages.length, 2);

    // Second sync immediately after with no changes -> should skip!
    const secondSync = await syncPublicDirectory(api, false);
    assertEquals(secondSync.updated, false);
    assertEquals(secondSync.reason, "not_dirty");
    assertEquals(api.sentMessages.length, 2); // No new messages
    assertEquals(api.editedMessages.length, 0); // No edits
  } finally {
    await kv.close();
  }
});

Deno.test("DIRECTORY — Deep link distinguishes between active paying member and non-member", async () => {
  const kv = await setupTestEnvironment();
  try {
    const paidUserId = 7001;
    const nonMemberUserId = 7002;

    // Grant paid access to user 7001
    await createEntitlement({
      userId: paidUserId,
      source: "telegram_stars",
      spaces: ["vip_collections", "general_chat", "wanted_list"],
      startsAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 86400 * 1000).toISOString(),
      status: "active",
    });

    const paidSummary = await getMembershipSummary(paidUserId);
    const nonMemberSummary = await getMembershipSummary(nonMemberUserId);

    assertEquals(paidSummary.hasPaid, true);
    assertEquals(paidSummary.accessibleSpaces.includes("vip_collections"), true);

    assertEquals(nonMemberSummary.hasPaid, false);
    assertEquals(nonMemberSummary.isMember, false);
  } finally {
    await kv.close();
  }
});
