import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { setupTestEnvironment, MOCK_CONFIG } from "./test_helpers.ts";
import { cb, makeBot, photo, text, Call } from "./ug05_harness.ts";
import { MockMigrationApi, seedCreator } from "./ug04_helpers.ts";
import { cleanRequestUrl, getWantedRequest, listWantedRequests, saveWantedRequest } from "../src/db/wanted_requests.ts";
import { peekAdminInput } from "../src/db/admin_input.ts";
import { getActiveContribution, getContribution } from "../src/db/contributions.ts";
import { createEntitlement, countEligibleParticipants, getMembershipSummary } from "../src/db/entitlements.ts";
import { createWantedCandidate, listWantedCandidates } from "../src/db/wanted.ts";
import { hasUserVoted } from "../src/db/voting.ts";
import { startWantedRequestContribution } from "../src/wanted/requests.ts";
import { addContributionItem, approveContribution, finishContribution, rejectContribution } from "../src/contributions/service.ts";
import { castVote, prepareMonthlyBallot } from "../src/voting/service.ts";
import { submitCreatorNomination, syncWantedListChannel } from "../src/wanted/service.ts";
import { WantedRequestClass } from "../src/types.ts";

const ADMIN = MOCK_CONFIG.ADMIN_USER_IDS[0];
const MEMBER = 750001;
type Button = { text: string; callback_data?: string; url?: string };
function buttons(calls: Call[]): Button[] {
  return calls.flatMap((c) => (c.payload.reply_markup as { inline_keyboard?: Button[][] } | undefined)?.inline_keyboard?.flat() ?? []);
}
function lastCallback(calls: Call[], prefix: string): string {
  const data = buttons(calls).reverse().find((b) => b.callback_data?.startsWith(prefix))?.callback_data;
  assert(data, `Missing button ${prefix}`);
  return data;
}
const texts = (calls: Call[]) => calls.map((c) => String(c.payload.text ?? "")).join("\n");
const request = (name = "Nova", category: WantedRequestClass = "creatrices") =>
  saveWantedRequest(ADMIN, { name, profileUrl: "https://www.instagram.com/nova/", category });

Deno.test("WANTED REQUESTS — writes are admin-only, classes/links validated, names unique and renames indexed", async () => {
  const kv = await setupTestEnvironment();
  try {
    await assertRejects(() => saveWantedRequest(MEMBER, { name: "Nova", profileUrl: "https://example.com/nova", category: "creatrices" }), Error, "administrateurs");
    await assertRejects(() => saveWantedRequest(ADMIN, { name: "Nova", profileUrl: "https://example.com/nova", category: "regular" as WantedRequestClass }), Error, "Créatrices ou Amateurs");
    await assertRejects(() => saveWantedRequest(ADMIN, { name: "Nova", profileUrl: "javascript:alert(1)", category: "amateurs" }), Error, "http(s)");
    await assertRejects(() => saveWantedRequest(ADMIN, { name: "Nova", profileUrl: "https://user:password@example.com", category: "amateurs" }), Error, "sans identifiants");
    assertEquals(cleanRequestUrl(" https://example.com/profile "), "https://example.com/profile");
    const results = await Promise.allSettled([request(" Nova "), request("nova")]);
    assertEquals(results.filter((r) => r.status === "fulfilled").length, 1);
    assertEquals((await listWantedRequests()).length, 1);
    const entry = (await listWantedRequests())[0];
    await saveWantedRequest(ADMIN, { name: "New Name", category: "amateurs" }, entry.id);
    await request("Nova"); // old name index released
    assertEquals((await listWantedRequests({ category: "amateurs" }))[0].name, "New Name");
    await assertRejects(() => saveWantedRequest(ADMIN, { name: "Nova" }, entry.id), Error, "déjà");
    assertEquals((await listWantedCandidates()).length, 0); // no voting candidates created
  } finally { await kv.close(); }
});

Deno.test("WANTED REQUESTS — private admin wizard, edit/remove/restore, stale buttons and live refresh", async () => {
  const kv = await setupTestEnvironment();
  try {
    const { bot, calls } = makeBot();
    await bot.handleUpdate(cb(MEMBER, "wreq:admin:add") as never);
    assertEquals(await peekAdminInput(MEMBER), null);
    assertStringIncludes(JSON.stringify(calls), "Accès refusé");
    await bot.handleUpdate(cb(ADMIN, "wreq:admin:add") as never);
    await bot.handleUpdate(text(ADMIN, "Anna_Lee") as never);
    await bot.handleUpdate(text(ADMIN, "not-a-link") as never);
    assertStringIncludes(texts(calls), "lien de profil valide");
    await bot.handleUpdate(text(ADMIN, "https://www.instagram.com/anna_lee/") as never);
    const classChoice = lastCallback(calls, "wreq:admin:class:");
    assert(new TextEncoder().encode(classChoice).length <= 64);
    await bot.handleUpdate(cb(ADMIN, classChoice) as never);
    const entry = (await listWantedRequests())[0];
    assertEquals(entry.name, "Anna_Lee");
    assertEquals(entry.category, "amateurs"); // last of the two explicit choices
    await bot.handleUpdate(cb(ADMIN, classChoice) as never);
    assertEquals((await listWantedRequests()).length, 1);
    assertStringIncludes(texts(calls), "Ce choix a expiré");
    calls.length = 0;
    await bot.handleUpdate(cb(MEMBER, "wreq:menu") as never);
    assertStringIncludes(texts(calls), "*Amateurs*");
    assertStringIncludes(texts(calls), "[Anna\\_Lee](https://www.instagram.com/anna_lee/)");
    assertStringIncludes(texts(calls), `?start=request_${entry.id}`);
    await bot.handleUpdate(cb(ADMIN, `wreq:admin:edit:${entry.id}:name`) as never);
    await bot.handleUpdate(text(ADMIN, "Anna Updated") as never);
    await bot.handleUpdate(cb(ADMIN, `wreq:admin:edit:${entry.id}:url`) as never);
    await bot.handleUpdate(text(ADMIN, "https://example.com/anna") as never);
    await bot.handleUpdate(cb(ADMIN, `wreq:admin:edit:${entry.id}:category`) as never);
    const newClass = buttons(calls).reverse().find((b) => b.text === "Créatrices")!.callback_data!;
    await bot.handleUpdate(cb(ADMIN, newClass) as never);
    calls.length = 0;
    await bot.handleUpdate(cb(MEMBER, "wreq:list:all:0") as never);
    assertStringIncludes(texts(calls), "*Créatrices*");
    assertStringIncludes(texts(calls), "[Anna Updated](https://example.com/anna)");
    assert(!texts(calls).includes("Anna\\_Lee"));
    await bot.handleUpdate(cb(ADMIN, `wreq:admin:status:${entry.id}:archived`) as never);
    assertEquals((await listWantedRequests()).length, 0);
    assertEquals((await startWantedRequestContribution(MEMBER, entry.id)).ok, false);
    await bot.handleUpdate(cb(ADMIN, `wreq:admin:status:${entry.id}:active`) as never);
    assertEquals((await getWantedRequest(entry.id))!.status, "active");
    assertEquals((await listWantedCandidates()).length, 0);
  } finally { await kv.close(); }
});

Deno.test("WANTED REQUESTS — all entries remain reachable through bounded pages and class filters", async () => {
  const kv = await setupTestEnvironment();
  try {
    const entries = [];
    for (let i = 0; i < 19; i++) entries.push(await saveWantedRequest(ADMIN, {
      name: `Name ${String(i).padStart(2, "0")} ${"[".repeat(45)}`,
      profileUrl: `https://example.com/${"(".repeat(170)}`,
      category: i % 2 ? "amateurs" : "creatrices",
    }));
    const { bot, calls } = makeBot();
    const visited: string[] = [];
    let data = "wreq:menu";
    for (let i = 0; i < 20; i++) {
      calls.length = 0;
      await bot.handleUpdate(cb(MEMBER, data) as never);
      const rendered = String(calls.find((c) => c.method === "editMessageText")!.payload.text);
      assert(rendered.length < 3500);
      visited.push(rendered);
      const next = buttons(calls).find((b) => b.text === "Suiv. ▶️")?.callback_data;
      if (!next) break;
      data = next;
    }
    assert(visited.length > 2);
    for (const entry of entries) assertEquals(visited.join("\n").split(`?start=request_${entry.id}`).length - 1, 1);
    calls.length = 0;
    await bot.handleUpdate(cb(MEMBER, "wreq:list:amateurs:0") as never);
    assertStringIncludes(texts(calls), "*Amateurs*");
    assert(!texts(calls).includes("*Créatrices*"));
  } finally { await kv.close(); }
});

Deno.test("WANTED REQUESTS — non-member submits from a link; admin publishes/rewards; contributor suggests and votes", async () => {
  const kv = await setupTestEnvironment();
  try {
    const entry = await request();
    const { bot, calls } = makeBot();
    await bot.handleUpdate(text(MEMBER, `/start request_${entry.id}`) as never);
    const collecting = (await getActiveContribution(MEMBER))!;
    assertEquals(collecting.step, "media");
    assertEquals(collecting.proposal!.name, entry.name);
    assertEquals(collecting.proposal!.profileUrl, entry.profileUrl);
    assertEquals(collecting.wantedRequest!.category, "creatrices");
    assertEquals(calls.filter((c) => c.method === "createForumTopic").length, 0);
    await bot.handleUpdate(photo(MEMBER, 501, "album1") as never);
    await bot.handleUpdate(photo(MEMBER, 502, "album1") as never);
    await bot.handleUpdate(cb(MEMBER, "contrib:finish") as never);
    assertEquals((await getContribution(collecting.id))!.status, "pending");
    assertEquals((await getMembershipSummary(MEMBER)).canParticipate, false);
    assert(calls.some((c) => c.method === "copyMessages" && c.payload.chat_id === ADMIN));
    assertStringIncludes(texts(calls), "Liste recherchée — Créatrices");
    await bot.handleUpdate(cb(ADMIN, `cadm:view:${collecting.id}`) as never);
    assertStringIncludes(texts(calls), "*Source :* Liste recherchée — Créatrices");
    await bot.handleUpdate(cb(ADMIN, `cadm:rt:${collecting.id}`) as never);
    await bot.handleUpdate(cb(ADMIN, `cadm:rw:${collecting.id}`) as never);
    await bot.handleUpdate(cb(ADMIN, `cadm:sc:${collecting.id}:rg`) as never);
    await bot.handleUpdate(cb(ADMIN, `cadm:du:${collecting.id}:15`) as never);
    await bot.handleUpdate(cb(ADMIN, `cadm:cf:${collecting.id}`) as never);
    assertEquals((await getContribution(collecting.id))!.status, "approved");
    const membership = await getMembershipSummary(MEMBER);
    assertEquals(membership.hasPaid, false);
    assertEquals(membership.canParticipate, true);
    assertEquals(membership.accessibleSpaces.includes("vip_collections"), true);
    const publishes = calls.filter((c) => c.method === "copyMessages" && c.payload.chat_id === MOCK_CONFIG.VIP_COLLECTIONS_CHAT_ID);
    assertEquals(publishes.length, 1);
    await bot.handleUpdate(cb(ADMIN, `cadm:cf:${collecting.id}`) as never);
    assertEquals((await getMembershipSummary(MEMBER)).effectiveExpiry, membership.effectiveExpiry);
    await bot.handleUpdate(text(MEMBER, "/suggest Future Creator") as never);
    assertEquals((await listWantedCandidates()).length, 1);
    await createWantedCandidate({ name: "Another Creator", normalizedName: "another creator", suggestedBy: MEMBER + 1, status: "requested", supportCount: 1 });
    const ballot = await prepareMonthlyBallot({ adminId: ADMIN });
    calls.length = 0;
    await bot.handleUpdate(cb(MEMBER, "vote:open") as never);
    const selection = lastCallback(calls, "vote:sel:");
    assert(new TextEncoder().encode(selection).length <= 64);
    await bot.handleUpdate(cb(MEMBER, selection) as never);
    const confirmation = lastCallback(calls, "vote:exec:");
    assert(new TextEncoder().encode(confirmation).length <= 64);
    await bot.handleUpdate(cb(MEMBER, confirmation) as never);
    assertEquals(await hasUserVoted(ballot.id, MEMBER), true);
    await bot.handleUpdate(cb(MEMBER, `vote:exec:${ballot.id}:9999`) as never);
    assertStringIncludes(JSON.stringify(calls), "Candidat introuvable");
    for (const button of buttons(calls)) if (button.callback_data) assert(new TextEncoder().encode(button.callback_data).length <= 64);
    await syncWantedListChannel(bot.api);
    assert(buttons(calls).some((b) => b.url === `https://t.me/${MOCK_CONFIG.BOT_USERNAME}?start=recherches`));
    await bot.handleUpdate(text(MEMBER, "/start recherches") as never);
    assertStringIncludes(texts(calls), "*LISTE RECHERCHÉE*");
  } finally { await kv.close(); }
});

Deno.test("WANTED REQUESTS — existing creators reuse their topic; no-reward/rejection never grants access", async () => {
  const kv = await setupTestEnvironment();
  try {
    const creator = await seedCreator({ name: "Aria", topicId: 10 });
    const entry = await request("Aria", "amateurs");
    const api = new MockMigrationApi();
    const started = await startWantedRequestContribution(MEMBER, entry.id);
    assertEquals(started.contribution!.kind, "existing");
    assertEquals(started.contribution!.creatorId, creator.id);
    await addContributionItem(MEMBER, { messageId: 100, kind: "photo" });
    const submitted = (await finishContribution(api, MEMBER)).contribution!;
    // Removing the request doesn't destroy an already submitted contribution or its source snapshot.
    await saveWantedRequest(ADMIN, { status: "archived" }, entry.id);
    assertEquals((await approveContribution(api, submitted.id, ADMIN, { type: "no_reward" })).ok, true);
    assertEquals((await getMembershipSummary(MEMBER)).isMember, false);
    assertEquals(api.createdTopics.length, 0);
    await saveWantedRequest(ADMIN, { status: "active" }, entry.id);
    await startWantedRequestContribution(MEMBER + 1, entry.id);
    await addContributionItem(MEMBER + 1, { messageId: 101, kind: "video" });
    const rejected = (await finishContribution(api, MEMBER + 1)).contribution!;
    assertEquals((await rejectContribution(api, rejected.id, ADMIN)).ok, true);
    assertEquals((await getMembershipSummary(MEMBER + 1)).isMember, false);
  } finally { await kv.close(); }
});

Deno.test("WANTED REQUESTS — active modern/legacy content-earned members may participate; expired/unrelated grants may not", async () => {
  const kv = await setupTestEnvironment();
  try {
    const now = Date.now();
    const entitlement = { spaces: ["vip_collections", "wanted_list"] as ("vip_collections" | "wanted_list")[], startsAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 86400_000).toISOString(), status: "active" as const };
    await createEntitlement({ ...entitlement, userId: 201, source: "contribution" });
    await createEntitlement({ ...entitlement, spaces: ["retro_collections"], userId: 202, source: "contribution" });
    await createEntitlement({ ...entitlement, userId: 203, source: "complimentary", metadata: { reason: "content_contribution" } });
    await createEntitlement({ ...entitlement, userId: 204, source: "complimentary", metadata: { reason: "admin_exception" } });
    await createEntitlement({ ...entitlement, userId: 205, source: "contribution", expiresAt: new Date(now - 1).toISOString() });
    await createEntitlement({ ...entitlement, userId: 206, source: "contribution", status: "revoked" });
    await createEntitlement({ ...entitlement, userId: 201, source: "telegram_stars" });
    await createEntitlement({ ...entitlement, userId: 207, source: "telegram_stars" });
    assertEquals(await countEligibleParticipants(), 4); // distinct people, not entitlements
    for (const userId of [201, 202, 203]) {
      assertEquals((await submitCreatorNomination({ userId, name: `Candidate ${userId}` })).success, true);
    }
    const ballot = await prepareMonthlyBallot({ adminId: ADMIN });
    for (const userId of [201, 202, 203]) {
      assertEquals((await castVote({ userId, ballotId: ballot.id, candidateId: ballot.candidates[0].candidateId })).success, true);
    }
    for (const userId of [204, 205, 206]) {
      assertEquals((await submitCreatorNomination({ userId, name: `Candidate ${userId}` })).success, false);
      assertEquals((await castVote({ userId, ballotId: ballot.id, candidateId: ballot.candidates[0].candidateId })).success, false);
    }
    assertEquals((await getMembershipSummary(203)).primaryType, "Contribution");
  } finally { await kv.close(); }
});
