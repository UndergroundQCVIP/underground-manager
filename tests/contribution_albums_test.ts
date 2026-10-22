import { assertEquals, assertStringIncludes } from "@std/assert";
import { setupTestEnvironment } from "./test_helpers.ts";
import { REGULAR_CHAT, seedCreator } from "./ug04_helpers.ts";
import { cb, makeBot, photo } from "./ug05_harness.ts";
import { startContribution } from "../src/contributions/service.ts";
import { getContribution } from "../src/db/contributions.ts";

const MEMBER = 998877, ADMIN = 111111;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

Deno.test("ALBUM — Finish waits for all four items delivered after the first photo, then approval copies all four", async () => {
  const kv = await setupTestEnvironment();
  try {
    const creator = await seedCreator({ name: "Album Creator", topicId: 42 });
    const { contribution } = await startContribution(MEMBER, creator.id);
    const { bot, calls } = makeBot();
    await bot.handleUpdate(photo(MEMBER, 101, "four-photos") as never);
    const finishing = bot.handleUpdate(cb(MEMBER, "contrib:finish") as never);
    await delay(40);
    for (const messageId of [102, 103, 104]) {
      await bot.handleUpdate(photo(MEMBER, messageId, "four-photos") as never);
    }
    await finishing;
    const submitted = (await getContribution(contribution!.id))!;
    assertEquals(submitted.status, "pending");
    assertEquals(submitted.items.map((item) => item.messageId).sort(), [
      101,
      102,
      103,
      104,
    ]);
    assertStringIncludes(
      calls.filter((c) => c.method === "sendMessage").map((c) => c.payload.text)
        .join("\n"),
      "Vos 4 élément",
    );
    await bot.handleUpdate(cb(ADMIN, `cadm:nr:${submitted.id}`) as never);
    const copies = calls.filter((c) =>
      c.method === "copyMessages" && c.payload.chat_id === REGULAR_CHAT
    );
    assertEquals(copies.length, 1);
    assertEquals(copies[0].payload.message_ids, [101, 102, 103, 104]);
  } finally {
    await kv.close();
  }
});

Deno.test("ALBUM — the compact receipt updates to the complete album count without one reply per photo", async () => {
  const kv = await setupTestEnvironment();
  try {
    const creator = await seedCreator();
    await startContribution(MEMBER, creator.id);
    const { bot, calls } = makeBot();
    await Promise.all(
      [1, 2, 3, 4].map((id) =>
        bot.handleUpdate(photo(MEMBER, id, "concurrent") as never)
      ),
    );
    assertEquals(
      calls.filter((c) =>
        c.method === "sendMessage" && c.payload.chat_id === MEMBER
      ).length,
      1,
    );
    assertStringIncludes(
      String(
        calls.filter((c) =>
          (c.method === "editMessageText" || c.method === "sendMessage") &&
          c.payload.chat_id === MEMBER
        ).at(-1)!.payload
          .text,
      ),
      "4 élément",
    );
  } finally {
    await kv.close();
  }
});

Deno.test("ALBUM — very late members update the pending submission, receipts and every admin preview after an isolate restart", async () => {
  const kv = await setupTestEnvironment();
  try {
    const creator = await seedCreator();
    const { contribution } = await startContribution(MEMBER, creator.id);
    const first = makeBot();
    await first.bot.handleUpdate(photo(MEMBER, 101, "late") as never);
    await first.bot.handleUpdate(cb(MEMBER, "contrib:finish") as never);
    const restarted = makeBot();
    for (const id of [102, 103, 104]) {
      await restarted.bot.handleUpdate(photo(MEMBER, id, "late") as never);
    }
    const updated = (await getContribution(contribution!.id))!;
    assertEquals(updated.status, "pending");
    assertEquals(updated.items.length, 4);
    assertStringIncludes(
      String(
        restarted.calls.filter((c) =>
          c.method === "editMessageText" && c.payload.chat_id === MEMBER
        ).at(-1)!.payload.text,
      ),
      "4 élément",
    );
    for (const admin of [111111, 222222]) {
      assertEquals(
        restarted.calls.filter((c) =>
          c.method === "copyMessages" && c.payload.chat_id === admin
        ).flatMap((c) => c.payload.message_ids as number[]),
        [102, 103, 104],
      );
    }
    await restarted.bot.handleUpdate(
      cb(ADMIN, `cadm:nr:${updated.id}`) as never,
    );
    assertEquals(
      restarted.calls.filter((c) =>
        c.method === "copyMessages" && c.payload.chat_id === REGULAR_CHAT
      ).at(-1)!.payload.message_ids,
      [101, 102, 103, 104],
    );
  } finally {
    await kv.close();
  }
});

Deno.test("ALBUM — a late old album never enters or erases a newer collecting session", async () => {
  const kv = await setupTestEnvironment();
  try {
    const { addContributionItem, finishContribution, approveContribution } =
      await import("../src/contributions/service.ts");
    const { getActiveContribution } = await import(
      "../src/db/contributions.ts"
    );
    const { MockMigrationApi } = await import("./ug04_helpers.ts");
    const api = new MockMigrationApi(), creator = await seedCreator();
    const first = (await startContribution(MEMBER, creator.id)).contribution!;
    await addContributionItem(MEMBER, {
      messageId: 101,
      kind: "photo",
      mediaGroupId: "old",
    });
    await finishContribution(api, MEMBER);
    const next = (await startContribution(MEMBER, creator.id)).contribution!;
    await addContributionItem(MEMBER, {
      messageId: 102,
      kind: "video",
      mediaGroupId: "old",
    });
    assertEquals((await getActiveContribution(MEMBER))!.id, next.id);
    assertEquals((await getContribution(first.id))!.items.length, 2);
    assertEquals((await getContribution(next.id))!.items.length, 0);
    assertEquals((await approveContribution(api, first.id, ADMIN)).ok, true);
    assertEquals((await getActiveContribution(MEMBER))!.id, next.id);
    await addContributionItem(MEMBER, { messageId: 200, kind: "photo" });
    assertEquals(
      (await getContribution(next.id))!.items.map((i) => i.messageId),
      [200],
    );
  } finally {
    await kv.close();
  }
});

Deno.test("ALBUM — duplicates are counted once and late items after publication produce a clear warning", async () => {
  const kv = await setupTestEnvironment();
  try {
    const creator = await seedCreator();
    const { contribution } = await startContribution(MEMBER, creator.id);
    const { bot, calls } = makeBot();
    const original = photo(MEMBER, 101, "duplicate");
    await bot.handleUpdate(original as never);
    await bot.handleUpdate(original as never);
    await bot.handleUpdate(photo(MEMBER, 101, "duplicate") as never);
    assertEquals((await getContribution(contribution!.id))!.items.length, 1);
    await bot.handleUpdate(cb(MEMBER, "contrib:finish") as never);
    await bot.handleUpdate(cb(ADMIN, `cadm:nr:${contribution!.id}`) as never);
    await bot.handleUpdate(photo(MEMBER, 102, "duplicate") as never);
    assertStringIncludes(
      String(
        calls.filter((c) => c.method === "sendMessage").at(-1)!.payload.text,
      ),
      "nouvelle contribution",
    );
    assertEquals((await getContribution(contribution!.id))!.items.length, 1);
    assertEquals(
      calls.filter((c) =>
        c.method === "copyMessages" && c.payload.chat_id === REGULAR_CHAT
      ).length,
      1,
    );
  } finally {
    await kv.close();
  }
});

Deno.test("ALBUM — a single photo's different resolutions still count as one photo", async () => {
  const kv = await setupTestEnvironment();
  try {
    const creator = await seedCreator();
    const { contribution } = await startContribution(MEMBER, creator.id);
    const { bot } = makeBot();
    const update = photo(MEMBER, 101);
    update.message.photo = [1, 2, 3, 4].map((i) => ({
      file_id: `size${i}`,
      file_unique_id: `u${i}`,
      width: i * 100,
      height: i * 100,
    }));
    await bot.handleUpdate(update as never);
    await bot.handleUpdate(cb(MEMBER, "contrib:finish") as never);
    assertEquals((await getContribution(contribution!.id))!.items.length, 1);
  } finally {
    await kv.close();
  }
});

for (const collection of ["retro", "amateur"] as const) {
  Deno.test(`ALBUM — four mixed items publish together in ${collection} after Finish races the remaining deliveries`, async () => {
    const kv = await setupTestEnvironment();
    try {
      const {
        startNewCreatorContribution,
        submitProposalName,
        submitProposalUrl,
        adminUpdateProposal,
      } = await import("../src/contributions/service.ts");
      const { getConfig } = await import("../src/config.ts");
      const { getActiveContribution } = await import(
        "../src/db/contributions.ts"
      );
      if (collection === "amateur") {
        getConfig().TELEGRAM_AMATEUR_FORUM_CHAT_ID = -1002008;
        await startNewCreatorContribution(MEMBER, "amateur");
        await submitProposalName(MEMBER, "Marie Tremblay");
        await submitProposalUrl(MEMBER, null);
      } else {
        const creator = await seedCreator({ collection: "retro" });
        await startContribution(MEMBER, creator.id);
      }
      const contribution = (await getActiveContribution(MEMBER))!;
      const { bot, calls } = makeBot();
      await bot.handleUpdate(photo(MEMBER, 101, "mixed") as never);
      const finish = bot.handleUpdate(cb(MEMBER, "contrib:finish") as never);
      await delay(40);
      for (const id of [103, 102, 104]) {
        const update = photo(MEMBER, id, "mixed");
        const message = id === 103
          ? {
            ...update.message,
            photo: undefined,
            video: {
              file_id: "video",
              file_unique_id: "video",
              width: 1,
              height: 1,
              duration: 1,
            },
          }
          : update.message;
        await bot.handleUpdate({ ...update, message } as never);
      }
      await finish;
      assertEquals((await getContribution(contribution.id))!.items.length, 4);
      if (collection === "amateur") {
        await adminUpdateProposal(contribution.id, {
          identityRightsConfirmed: true,
        });
      }
      await bot.handleUpdate(cb(ADMIN, `cadm:nr:${contribution.id}`) as never);
      const target = collection === "amateur"
        ? -1002008
        : getConfig().TELEGRAM_RETRO_FORUM_CHAT_ID;
      assertEquals(
        calls.filter((c) =>
          c.method === "copyMessages" && c.payload.chat_id === target
        ).at(-1)!.payload.message_ids,
        [101, 102, 103, 104],
      );
      assertEquals(
        (await getContribution(contribution.id))!.publishedMessageIds!.length,
        4,
      );
    } finally {
      await kv.close();
    }
  });
}

Deno.test("ALBUM — a failed counter edit retries from durable state without losing received media", async () => {
  const kv = await setupTestEnvironment();
  try {
    const { addContributionItem } = await import(
      "../src/contributions/service.ts"
    );
    const { syncContributionReceipt, flushContributionReceipts } = await import(
      "../src/contributions/intake.ts"
    );
    const { MockMigrationApi } = await import("./ug04_helpers.ts");
    const creator = await seedCreator(), api = new MockMigrationApi();
    const contribution = (await startContribution(MEMBER, creator.id))
      .contribution!;
    await addContributionItem(MEMBER, {
      messageId: 101,
      kind: "photo",
      mediaGroupId: "retry",
    });
    await syncContributionReceipt(api, contribution.id);
    for (const id of [102, 103, 104]) {
      await addContributionItem(MEMBER, {
        messageId: id,
        kind: "photo",
        mediaGroupId: "retry",
      });
    }
    const edit = api.editMessageText.bind(api);
    api.editMessageText = () =>
      Promise.reject(new Error("Telegram temporarily unavailable"));
    const { assertRejects } = await import("@std/assert");
    await assertRejects(() => syncContributionReceipt(api, contribution.id));
    assertEquals((await getContribution(contribution.id))!.items.length, 4);
    api.editMessageText = edit;
    await flushContributionReceipts(api);
    assertStringIncludes(api.editedMessages.at(-1)!.text, "4 élément");
    assertEquals(
      (await kv.get(["contribution_receipt_dirty", contribution.id])).value,
      null,
    );
  } finally {
    await kv.close();
  }
});

Deno.test("ALBUM — late admin previews retry without duplicating successful preview batches", async () => {
  const kv = await setupTestEnvironment();
  try {
    const { addContributionItem, finishContribution, rejectContribution } =
      await import(
        "../src/contributions/service.ts"
      );
    const { syncContributionReview, flushContributionReviews } = await import(
      "../src/contributions/review.ts"
    );
    const { MockMigrationApi } = await import("./ug04_helpers.ts");
    const creator = await seedCreator(), api = new MockMigrationApi();
    const contribution = (await startContribution(MEMBER, creator.id))
      .contribution!;
    await addContributionItem(MEMBER, {
      messageId: 101,
      kind: "photo",
      mediaGroupId: "preview",
    });
    await finishContribution(api, MEMBER);
    for (const id of [102, 103, 104]) {
      await addContributionItem(MEMBER, {
        messageId: id,
        kind: "photo",
        mediaGroupId: "preview",
      });
    }
    api.failNextCopies = {
      count: 1,
      error: new Error("Telegram temporarily unavailable"),
    };
    const { assertRejects } = await import("@std/assert");
    await assertRejects(() => syncContributionReview(api, contribution.id));
    await flushContributionReviews(api);
    assertStringIncludes(api.editedMessages.at(-1)!.text, "Éléments : 4");
    const before = api.copyCalls.length;
    await syncContributionReview(api, contribution.id);
    assertEquals(api.copyCalls.length, before);
    assertEquals((await getContribution(contribution.id))!.items.length, 4);
    await rejectContribution(api, contribution.id, ADMIN);
    const rejected = (await getContribution(contribution.id))!;
    assertEquals(rejected.items, []);
    assertEquals(rejected.lateAlbumMessageIds, undefined);
    for (const ref of rejected.reviewMessages ?? []) {
      assertEquals(ref.previewMessageIds, undefined);
      assertEquals(
        (await kv.get([
          "contribution_review_preview",
          contribution.id,
          ref.chatId,
          ref.messageId,
        ])).value,
        null,
      );
    }
  } finally {
    await kv.close();
  }
});
