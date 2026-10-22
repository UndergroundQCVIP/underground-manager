import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { MOCK_CONFIG, setupTestEnvironment } from "./test_helpers.ts";
import { MockMigrationApi } from "./ug04_helpers.ts";
import {
  callback,
  chatJoinRequest,
  createFakeTelegram,
  groupMessage,
  privateMessage,
} from "./bot_harness.ts";
import { cb, photo, text } from "./ug05_harness.ts";
import { getConfig, setConfigForTesting } from "../src/config.ts";
import { bindPrivateChat } from "../src/db/chat_bindings.ts";
import { refreshAmateurConfiguration } from "../src/db/amateur.ts";
import {
  createEntitlement,
  getMembershipSummary,
  getUserEntitlements,
  hasAccessToSpace,
  mutateEntitlement,
} from "../src/db/entitlements.ts";
import { COMPLIMENTARY_SPACES } from "../src/types.ts";
import { handleForumTopicCreated } from "../src/creators/service.ts";
import {
  getActiveContribution,
  getContribution,
  getModeratorRewardDraft,
  saveContribution,
} from "../src/db/contributions.ts";
import { listCreators } from "../src/db/creators.ts";
import {
  addContributionItem,
  adminUpdateProposal,
  approveContribution,
  finishContribution,
  rejectContribution,
  startNewCreatorContribution,
  submitProposalName,
  submitProposalUrl,
  switchToExistingCreator,
} from "../src/contributions/service.ts";
import { flushContributionReviews } from "../src/contributions/review.ts";
import { grantContributionReward } from "../src/contributions/rewards.ts";
import { listBonuses, saveAttribution } from "../src/db/referrals.ts";

const AMATEUR = -1002008, CHAT = -1002009, REVIEW = -1002010;
const ADMIN = MOCK_CONFIG.ADMIN_USER_IDS[0],
  SECOND = MOCK_CONFIG.ADMIN_USER_IDS[1],
  MEMBER = 987654;
function configure() {
  setConfigForTesting({
    ...MOCK_CONFIG,
    TELEGRAM_AMATEUR_FORUM_CHAT_ID: AMATEUR,
    TELEGRAM_AMATEUR_CHAT_ID: CHAT,
    TELEGRAM_ADMIN_REVIEW_CHAT_ID: REVIEW,
  });
}
async function submission(
  api: MockMigrationApi,
  name = "Marie Tremblay",
  member = MEMBER,
) {
  await startNewCreatorContribution(member, "amateur");
  assert((await submitProposalName(member, name)).ok);
  assert((await submitProposalUrl(member, null)).ok);
  await addContributionItem(member, { messageId: 10, kind: "photo" });
  await addContributionItem(member, { messageId: 11, kind: "video" });
  const result = await finishContribution(api, member);
  assert(result.ok);
  return result.contribution!;
}
function inGroup(adminId: number, data: string) {
  const update = callback(adminId, data);
  update.callback_query.message.chat = {
    id: REVIEW,
    type: "supergroup",
    title: "Équipe",
  } as never;
  return update;
}

Deno.test("AMATEUR BUNDLE — legacy approvals gain six spaces at their original expiry; paid/full never gain Amateur", async () => {
  const kv = await setupTestEnvironment();
  try {
    configure();
    const expiry = new Date(Date.now() + 5 * 86400000).toISOString();
    const grant = await createEntitlement({
      userId: MEMBER,
      source: "complimentary",
      spaces: ["amateur_collections"],
      startsAt: new Date().toISOString(),
      expiresAt: expiry,
      status: "active",
      metadata: { accessLevel: "amateur", grantedBy: ADMIN },
    });
    const summary = await getMembershipSummary(MEMBER);
    assertEquals(
      new Set(summary.accessibleSpaces),
      new Set(COMPLIMENTARY_SPACES.amateur),
    );
    assertEquals(summary.canParticipate, true);
    assertEquals((await getUserEntitlements(MEMBER))[0].expiresAt, expiry);
    const tg = await createFakeTelegram();
    for (
      const chat of [
        CHAT,
        AMATEUR,
        MOCK_CONFIG.VIP_COLLECTIONS_CHAT_ID,
        MOCK_CONFIG.TELEGRAM_RETRO_FORUM_CHAT_ID,
        MOCK_CONFIG.WANTED_LIST_CHAT_ID,
        MOCK_CONFIG.GENERAL_CHAT_ID,
      ]
    ) await tg.send(chatJoinRequest(chat, MEMBER));
    assertEquals(tg.callsOf("approveChatJoinRequest").length, 6);
    await tg.send(callback(MEMBER, "member:amateur"));
    assert(
      tg.callsOf("createChatInviteLink").some((c) =>
        c.payload.chat_id === CHAT
      ),
    );
    await mutateEntitlement(
      grant.id,
      (e) => ({ ...e, expiresAt: new Date(Date.now() - 1000).toISOString() }),
    );
    for (const space of COMPLIMENTARY_SPACES.amateur) {
      assertEquals(await hasAccessToSpace(MEMBER, space), false);
    }
  } finally {
    await kv.close();
  }
});

Deno.test("AMATEUR SUBMISSION — full name, optional profile, content and admin rights; one video is enough to submit", async () => {
  const kv = await setupTestEnvironment();
  try {
    configure();
    const api = new MockMigrationApi();
    await startNewCreatorContribution(MEMBER, "amateur");
    assertEquals((await submitProposalName(MEMBER, "Alias")).ok, false);
    assert((await submitProposalName(MEMBER, "Marie Tremblay")).ok);
    assertEquals((await getActiveContribution(MEMBER))!.step, "url");
    assertEquals((await submitProposalUrl(MEMBER, "not a link")).ok, false);
    assert((await submitProposalUrl(MEMBER, null)).ok);
    assertEquals((await getActiveContribution(MEMBER))!.step, "media");
    assertEquals((await finishContribution(api, MEMBER)).ok, false);
    assert(
      (await addContributionItem(MEMBER, { messageId: 9, kind: "video" }))
        .added,
    );
    const result = await finishContribution(api, MEMBER);
    assert(result.ok);
    const id = result.contribution!.id;
    assertEquals(api.createdTopics.length, 0);
    assertEquals(api.copyCalls.map((c) => c.to), [REVIEW]);
    assertEquals(api.copyCalls[0].ids, [9]);
    assertEquals((await approveContribution(api, id, ADMIN)).ok, false);
    await adminUpdateProposal(id, { identityRightsConfirmed: true });
    assertEquals((await approveContribution(api, id, MEMBER)).ok, false);
    assert((await approveContribution(api, id, SECOND)).ok);
    assertEquals(api.createdTopics.length, 1);
    assertEquals(api.createdTopics[0].chatId, AMATEUR);
    assertEquals(api.copyCalls.find((c) => c.to === AMATEUR)!.ids, [9]);
    assertEquals((await listCreators()).length, 0);
    assertEquals((await listCreators({ collection: "amateur" })).length, 1);
    assertEquals(await hasAccessToSpace(MEMBER, "amateur_collections"), false);
    assert(
      api.editedMessages.some((c) =>
        c.chatId === REVIEW && c.text.includes("✅ Approuvée") &&
        c.text.includes(`administrateur ${SECOND}`)
      ),
    );
    assertEquals((await getContribution(id))!.rewardStatus, "none");
  } finally {
    await kv.close();
  }
});

Deno.test("AMATEUR SUBMISSION — existing topics are reused privately; reward requires explicit admin selection and grants no Amateur referral", async () => {
  const kv = await setupTestEnvironment();
  try {
    configure();
    const api = new MockMigrationApi();
    const existing =
      (await handleForumTopicCreated(AMATEUR, 42, "Marie Tremblay"))!;
    // Generic creator selection cannot bypass the required Amateur proof flow.
    await startNewCreatorContribution(MEMBER, "amateur");
    assertEquals(
      (await switchToExistingCreator(MEMBER, existing.id)).ok,
      false,
    );
    const sub = await submission(api);
    assertEquals(sub.proposal!.duplicateCandidateIds.length, 0);
    await saveAttribution({
      refereeId: MEMBER,
      referrerId: 1234567,
      code: "test",
      at: new Date().toISOString(),
    });
    await adminUpdateProposal(sub.id, { identityRightsConfirmed: true });
    const decision = {
      type: "reward" as const,
      scopes: ["amateur" as const],
      days: 30,
    };
    assert((await approveContribution(api, sub.id, ADMIN, decision)).ok);
    assertEquals(api.createdTopics.length, 0);
    assertEquals(api.copyCalls.find((c) => c.to === AMATEUR)!.thread, 42);
    assertEquals((await getContribution(sub.id))!.creatorId, existing.id);
    for (const space of COMPLIMENTARY_SPACES.amateur) {
      assert(await hasAccessToSpace(MEMBER, space));
    }
    assertEquals((await listBonuses()).length, 0);
    const grants = await getUserEntitlements(MEMBER);
    assertEquals(grants.length, 1);
    assertEquals(grants[0].metadata!.grantedBy, ADMIN);
    assertEquals(
      (await approveContribution(api, sub.id, SECOND, decision)).ok,
      false,
    );
    assertEquals(
      (await getUserEntitlements(MEMBER))[0].expiresAt,
      grants[0].expiresAt,
    );
    await assertRejects(() =>
      grantContributionReward({
        contributionId: "forged",
        userId: MEMBER,
        adminId: MEMBER,
        scopes: ["amateur"],
        days: 30,
      })
    );
  } finally {
    await kv.close();
  }
});

Deno.test("TEAM REVIEW — setup persists private group IDs, rejects collisions and permits only configured admins", async () => {
  const kv = await setupTestEnvironment();
  try {
    const tg = await createFakeTelegram();
    tg.bot.api.config.use((prev, method, payload, signal) => {
      if (method === "getChat") {
        return Promise.resolve(
          {
            ok: true,
            result: {
              id: Number((payload as { chat_id: number }).chat_id),
              type: "supergroup",
              title: "Private",
              permissions: { can_send_messages: true, can_invite_users: true },
            },
          } as never,
        );
      }
      if (method === "getWebhookInfo") {
        return Promise.resolve(
          {
            ok: true,
            result: {
              url: "https://example.com/webhook",
              allowed_updates: [
                "message",
                "callback_query",
                "chat_join_request",
              ],
            },
          } as never,
        );
      }
      return prev(method, payload, signal);
    });
    for (
      const [chat, command] of [[CHAT, "/setup_amateur_chat"], [
        REVIEW,
        "/setup_admin_review",
      ]] as const
    ) {
      const msg = groupMessage(chat, ADMIN, command).message;
      await tg.send({
        message: {
          ...msg,
          entities: [{
            type: "bot_command",
            offset: 0,
            length: command.length,
          }],
        },
      });
    }
    assertEquals(getConfig().TELEGRAM_AMATEUR_CHAT_ID, CHAT);
    assertEquals(getConfig().TELEGRAM_ADMIN_REVIEW_CHAT_ID, REVIEW);
    setConfigForTesting({ ...MOCK_CONFIG });
    await refreshAmateurConfiguration();
    assertEquals(getConfig().TELEGRAM_AMATEUR_CHAT_ID, CHAT);
    assertEquals(getConfig().TELEGRAM_ADMIN_REVIEW_CHAT_ID, REVIEW);
    assertEquals(tg.callsOf("setChatPermissions").length, 2);
    await assertRejects(() => bindPrivateChat("admin_review", CHAT, ADMIN));
    await assertRejects(() =>
      bindPrivateChat("amateur_chat", -1002222, MEMBER)
    );
    const api = new MockMigrationApi();
    configure();
    const sub = await submission(api);
    tg.reset();
    await tg.send(inGroup(MEMBER, `cadm:nr:${sub.id}`));
    assertEquals((await getContribution(sub.id))!.status, "pending");
    assertStringIncludes(JSON.stringify(tg.calls), "Accès refusé");
  } finally {
    await kv.close();
  }
});

Deno.test("TEAM REVIEW — moderators have separate reward drafts and cannot confirm stale or another admin's choices", async () => {
  const kv = await setupTestEnvironment();
  try {
    configure();
    const api = new MockMigrationApi();
    const sub = await submission(api);
    await adminUpdateProposal(sub.id, { identityRightsConfirmed: true });
    const tg = await createFakeTelegram();
    tg.bot.api.config.use((prev, method, payload, signal) =>
      method === "createForumTopic"
        ? Promise.resolve(
          {
            ok: true,
            result: { message_thread_id: 77, name: "Marie Tremblay" },
          } as never,
        )
        : method === "copyMessages"
        ? Promise.resolve(
          {
            ok: true,
            result: (payload as { message_ids: number[] }).message_ids.map((
              _,
              i,
            ) => ({ message_id: 900 + i })),
          } as never,
        )
        : prev(method, payload, signal)
    );
    await tg.send(inGroup(ADMIN, `cadm:sc:${sub.id}:am`));
    const old = (await getModeratorRewardDraft(sub.id, ADMIN))!;
    await tg.send(inGroup(ADMIN, `cadm:du:${sub.id}:15`));
    await tg.send(inGroup(SECOND, `cadm:sc:${sub.id}:rg`));
    const second = (await getModeratorRewardDraft(sub.id, SECOND))!;
    await tg.send(inGroup(SECOND, `cadm:cf:${sub.id}:${old.nonce}`));
    await tg.send(inGroup(ADMIN, `cadm:cf:${sub.id}:${old.nonce}`));
    assertEquals((await getContribution(sub.id))!.status, "pending");
    await tg.send(inGroup(SECOND, `cadm:duc:${sub.id}`));
    // Private text must not answer a group-bound prompt.
    await tg.send(privateMessage(SECOND, "99"));
    assertEquals(
      (await getModeratorRewardDraft(sub.id, SECOND))!.days,
      second.days,
    );
    await tg.send(groupMessage(REVIEW, SECOND, "7"));
    assertEquals((await getModeratorRewardDraft(sub.id, SECOND))!.days, 7);
    const current = (await getModeratorRewardDraft(sub.id, ADMIN))!;
    await tg.send(inGroup(ADMIN, `cadm:cf:${sub.id}:${current.nonce}`));
    assertEquals((await getContribution(sub.id))!.status, "approved");
    assertEquals((await getContribution(sub.id))!.decision, {
      type: "reward",
      scopes: ["amateur"],
      days: 15,
    });
    assertEquals(
      (await getContribution(sub.id))!.publishedMessageIds!.length,
      2,
    );
  } finally {
    await kv.close();
  }
});

Deno.test("TEAM REVIEW — failed notifications/cards retry and rejection records the moderator for the team", async () => {
  const kv = await setupTestEnvironment();
  try {
    configure();
    const api = new MockMigrationApi();
    const sub = await submission(api);
    const edit = api.editMessageText.bind(api);
    let offline = true;
    api.editMessageText = (...args) =>
      offline ? Promise.reject(new Error("temporary failure")) : edit(...args);
    assert(
      (await rejectContribution(api, sub.id, SECOND, "Profil incomplet")).ok,
    );
    assert((await kv.get(["contribution_review_dirty", sub.id])).value);
    offline = false;
    await flushContributionReviews(api);
    const card = api.editedMessages.at(-1)!;
    assertEquals(card.chatId, REVIEW);
    assertStringIncludes(card.text, "❌ Refusée");
    assertStringIncludes(card.text, `administrateur ${SECOND}`);
    assertStringIncludes(card.text, "Profil incomplet");
    assert(!JSON.stringify(card.options).includes("cadm:nr:"));
    assertEquals(
      (await kv.get(["contribution_review_dirty", sub.id])).value,
      null,
    );
    assertEquals((await getContribution(sub.id))!.items, []);
  } finally {
    await kv.close();
  }
});

Deno.test("AMATEUR UI — a non-member skips the profile link, sees Finish immediately and submits only when finished", async () => {
  const kv = await setupTestEnvironment();
  try {
    configure();
    const tg = await createFakeTelegram();
    await tg.send(callback(MEMBER, "contrib:start"));
    assertStringIncludes(JSON.stringify(tg.calls), "contrib:amateur");
    await tg.send(callback(MEMBER, "contrib:amateur"));
    await tg.send(text(MEMBER, "Marie Tremblay"));
    assertEquals(
      (await getActiveContribution(MEMBER))!.step,
      "url",
    );
    assertStringIncludes(
      JSON.stringify(tg.callsOf("sendMessage").at(-1)),
      "contrib:urlskip",
    );
    await tg.send(callback(MEMBER, "contrib:urlskip"));
    assertEquals((await getActiveContribution(MEMBER))!.step, "media");
    assertStringIncludes(
      JSON.stringify(tg.callsOf("sendMessage").at(-1)),
      "contrib:finish",
    );
    await tg.send(photo(MEMBER, 10));
    await tg.send(photo(MEMBER, 11));
    assertEquals(tg.callsOf("copyMessages").length, 0);
    await tg.send(callback(MEMBER, "contrib:finish"));
    assertEquals(tg.callsOf("copyMessages").at(-1)!.payload.chat_id, REVIEW);
    assertEquals(tg.callsOf("copyMessages").at(-1)!.payload.message_ids, [
      10,
      11,
    ]);
    assertEquals((await getUserEntitlements(MEMBER)).length, 0);
  } finally {
    await kv.close();
  }
});

Deno.test("AMATEUR ALBUM — concurrent content preserves every item without requiring or assigning a screenshot", async () => {
  const kv = await setupTestEnvironment();
  try {
    configure();
    await startNewCreatorContribution(MEMBER, "amateur");
    await submitProposalName(MEMBER, "Marie Tremblay");
    await submitProposalUrl(MEMBER, null);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        addContributionItem(MEMBER, {
          messageId: 100 + i,
          kind: "photo",
          mediaGroupId: "album",
        })),
    );
    assertEquals(results.filter((r) => r.added).length, 10);
    const contribution = (await getActiveContribution(MEMBER))!;
    assertEquals(contribution.items.length, 10);
    assertEquals(
      contribution.items.filter((i) => i.purpose === "profile_screenshot")
        .length,
      0,
    );
    assertEquals(new Set(contribution.items.map((i) => i.messageId)).size, 10);
  } finally {
    await kv.close();
  }
});

Deno.test("AMATEUR UI — a supplied profile link goes straight to content; old screenshot sessions can skip to content", async () => {
  const kv = await setupTestEnvironment();
  try {
    configure();
    const tg = await createFakeTelegram();
    await tg.send(callback(MEMBER, "contrib:amateur"));
    await tg.send(text(MEMBER, "Marie Tremblay"));
    await tg.send(text(MEMBER, "https://instagram.com/marie.tremblay"));
    let active = (await getActiveContribution(MEMBER))!;
    assertEquals(active.step, "media");
    assertEquals(
      active.proposal!.profileUrl,
      "https://instagram.com/marie.tremblay",
    );
    assertStringIncludes(
      JSON.stringify(tg.callsOf("sendMessage").at(-1)),
      "contrib:finish",
    );
    assert(!JSON.stringify(tg.calls).includes("contrib:col:"));
    active = { ...active, step: "profile_screenshot" };
    await saveContribution(active);
    await tg.send(photo(MEMBER, 99));
    assertStringIncludes(
      JSON.stringify(tg.callsOf("sendMessage").at(-1)),
      "contrib:urlskip",
    );
    await tg.send(callback(MEMBER, "contrib:urlskip"));
    assertEquals((await getActiveContribution(MEMBER))!.step, "media");
    await tg.send(photo(MEMBER, 100));
    await tg.send(callback(MEMBER, "contrib:finish"));
    assertEquals((await getContribution(active.id))!.status, "pending");
  } finally {
    await kv.close();
  }
});
