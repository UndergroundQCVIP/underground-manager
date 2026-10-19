/**
 * LA CONFRÉRIE — Administrator Migration Handlers (UG-04)
 * Regular → Retro creator migration, entirely inside Telegram.
 * All routes are guarded by adminRouteGuard (callback prefix "mig:" and the
 * commands listed in ADMIN_COMMANDS) via the admin composer's guard.
 */

import { Composer, InlineKeyboard } from "grammy";
import { getClubName } from "../../config.ts";
import { adminRouteGuard } from "../middleware/auth.ts";
import { creatorCollection, getCreator, listCreators } from "../../db/creators.ts";
import { listMediaIndex } from "../../db/media_index.ts";
import {
  getActiveMigrationForCreator,
  getMigrationJob,
  isTerminalMigration,
  listMigrationItems,
  listMigrationJobs,
} from "../../db/migrations.ts";
import {
  attestInventoryComplete,
  indexMediaFromLinks,
  relinkCreatorToRetroTopic,
  resolveCreator,
  setRetirement,
} from "../../creators/admin.ts";
import {
  cancelMigration,
  confirmSourceDeletion,
  estimateBatches,
  excludeUnresolvedItems,
  finalizeMigration,
  pauseMigration,
  prepareMigration,
  reevaluateMigration,
  requestSourceDeletion,
  runMigrationStep,
  startMigration,
  verifyMigration,
} from "../../migration/service.ts";
import { syncPublicDirectory } from "../../directory/sync.ts";
import { MigrationJob, MigrationStatus } from "../../types.ts";

export const migrationComposer = new Composer();

migrationComposer.use(
  adminRouteGuard({
    callbackPrefixes: ["mig:"],
    commands: ["index_media", "attest_inventory", "retire_creator", "move_to_retro", "relink_creator"],
  })
);

const STATUS_LABEL: Record<MigrationStatus, string> = {
  prepared: "🟡 Prepared (dry-run — nothing copied)",
  blocked: "🔴 Blocked",
  copying: "🔵 Copying",
  paused: "⏸ Paused",
  needs_review: "🟠 Needs review",
  ready_to_finalize: "🟢 Verified — awaiting your approval",
  finalized: "✅ Finalized (old Regular topic still exists)",
  source_deleted: "🗑 Completed — old topic removed",
  cancelled: "⚫ Cancelled",
};

export const PROTECTED_CONTENT_ALTERNATIVE =
  `*Administrator-controlled republishing alternative*\n` +
  `Telegram's Restrict Saving Content forbids copying this media, and the bot will not bypass or disable it.\n` +
  `1. Collect the creator's media from your authorized source files.\n` +
  `2. Create the creator's topic in RETRO | {club} and upload the files yourself.\n` +
  `3. Link it to the existing creator record (same internal ID, no duplicate):\n` +
  `   \`/relink_creator <creator name> <retro topic id>\``;

function mdSafe(t: string): string {
  return t.replace(/([_*`\[])/g, "\\$1");
}

async function renderJob(job: MigrationJob): Promise<{ text: string; kb: InlineKeyboard }> {
  const items = await listMigrationItems(job.id);
  const t = job.totals;
  const kb = new InlineKeyboard();

  let text =
    `🚚 *MIGRATION — ${mdSafe(job.creatorName)}*\n` +
    `*Status:* ${STATUS_LABEL[job.status]}\n\n` +
    `*Source:* Regular forum \`${job.source.chatId}\` / topic \`${job.source.topicId}\`\n` +
    `*Destination:* RETRO | ${getClubName()} \`${job.destination.chatId}\` / topic ${job.destination.topicId ? `\`${job.destination.topicId}\`` : "_not created yet_"}\n\n` +
    `*Inventory:* ${t.items} message(s), ${t.albums} album(s)\n` +
    `✔ copied ${t.copied} · ⏳ pending ${t.pending} · ✖ failed ${t.failed} · ❓ ambiguous ${t.ambiguous} · 🚫 excluded ${t.excluded}\n`;

  if (job.status === "prepared") {
    text += `\n*Dry-run:* ${estimateBatches(items)} batch(es) would be copied. No Telegram content has been changed.\n`;
  }

  if (job.preflight && job.preflight.blockers.length) {
    text += `\n*Blockers:*\n` + job.preflight.blockers.map((b) => `• ${mdSafe(b.detail)}`).join("\n") + "\n";
  }
  if (job.preflight?.warnings.length) {
    text += `\n*Warnings:*\n` + job.preflight.warnings.map((w) => `• ${mdSafe(w)}`).join("\n") + "\n";
  }
  if (job.blockedReason === "protected_content") {
    text += `\n${PROTECTED_CONTENT_ALTERNATIVE.replace("{club}", getClubName())}\n`;
  }
  if (job.notes.length) {
    text += `\n*Notes:*\n` + job.notes.slice(-4).map((n) => `• ${mdSafe(n).slice(0, 300)}`).join("\n") + "\n";
  }
  if (["prepared", "copying", "paused", "needs_review", "ready_to_finalize"].includes(job.status)) {
    text +=
      `\n⚠️ _Until the old Regular topic is removed, Regular members can still open the original collection — exclusive Retro access is not achieved yet._`;
  }

  switch (job.status) {
    case "prepared":
      kb.text("▶️ Start copying", `mig:start:${job.id}`).row();
      break;
    case "blocked":
      kb.text("🔄 Re-check", `mig:start:${job.id}`).row();
      break;
    case "copying":
      kb.text("⏩ Copy next batches", `mig:run:${job.id}`).text("⏸ Pause", `mig:pause:${job.id}`).row();
      break;
    case "paused":
      kb.text("▶️ Resume", `mig:start:${job.id}`).row();
      break;
    case "needs_review":
      kb.text("🔁 Retry failed", `mig:start:${job.id}`).text("🔍 Re-verify", `mig:verify:${job.id}`).row();
      if (t.failed + t.ambiguous > 0) kb.text("🚫 Exclude unresolved…", `mig:excl:${job.id}`).row();
      break;
    case "ready_to_finalize":
      kb.text("✅ Review & approve finalization", `mig:fin:${job.id}`).row();
      break;
    case "finalized":
      kb.text("🗑 Remove old Regular topic…", `mig:del:${job.id}`).row();
      break;
  }
  if (!isTerminalMigration(job.status) && !["finalized"].includes(job.status)) {
    kb.text("❌ Cancel migration", `mig:cancel:${job.id}`).row();
  }
  kb.text("🔃 Refresh", `mig:view:${job.id}`).text("⬅️ Migrations", "mig:list");
  return { text, kb };
}

async function showJob(ctx: { editMessageText: (t: string, o: object) => Promise<unknown> }, jobId: string) {
  const job = await getMigrationJob(jobId);
  if (!job) {
    await ctx.editMessageText("⚠️ Migration job not found.", {
      reply_markup: new InlineKeyboard().text("⬅️ Admin Menu", "admin:menu"),
    });
    return;
  }
  const { text, kb } = await renderJob(job);
  await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: kb });
}

// ---- Pick a Regular creator -------------------------------------------------

migrationComposer.callbackQuery("mig:pick", async (ctx) => {
  const regular = (await listCreators({ status: "active" })).filter((c) => creatorCollection(c) === "regular");
  await ctx.answerCallbackQuery();
  const kb = new InlineKeyboard();
  for (const c of regular.slice(0, 30)) kb.text(c.name, `mig:sel:${c.id}`).row();
  kb.text("⬅️ Admin Menu", "admin:menu");
  await ctx.editMessageText(
    `🎞️ *MOVE TO RETRO*\n\nSelect a Regular creator to prepare for migration. Nothing is moved until you review the dry-run and start the copy.` +
    (regular.length === 0 ? `\n\n_No Regular creators registered._` : ""),
    { parse_mode: "Markdown", reply_markup: kb }
  );
});

migrationComposer.command("move_to_retro", async (ctx) => {
  const creator = await resolveCreator(ctx.match ?? "");
  if (!creator) {
    await ctx.reply("Usage: `/move_to_retro <creator name or id>`", { parse_mode: "Markdown" });
    return;
  }
  await ctx.reply(`Open the migration for *${mdSafe(creator.name)}*:`, {
    parse_mode: "Markdown",
    reply_markup: new InlineKeyboard().text("🎞️ Continue", `mig:sel:${creator.id}`),
  });
});

migrationComposer.callbackQuery(/^mig:sel:([\w-]+)$/, async (ctx) => {
  const creator = await getCreator(ctx.match[1]);
  await ctx.answerCallbackQuery();
  if (!creator) {
    await ctx.editMessageText("⚠️ Creator not found.", { reply_markup: new InlineKeyboard().text("⬅️ Back", "mig:pick") });
    return;
  }
  const existing = await getActiveMigrationForCreator(creator.id);
  if (existing && !["prepared", "blocked"].includes(existing.status)) {
    await showJob(ctx, existing.id);
    return;
  }
  const indexed = (await listMediaIndex(creator.id, { chatId: creator.chatId, topicId: creator.topicId })).length;
  await ctx.editMessageText(
    `🎞️ *MOVE ${mdSafe(creator.name)} TO RETRO*\n\n` +
    `Indexed media messages: *${indexed}* (${creator.inventoryStatus === "complete" ? "inventory complete" : "⚠️ inventory not confirmed complete"})\n\n` +
    `This prepares a *dry-run only*: the bot checks the source mapping, the Retro forum, permissions and content protection, and counts what can be copied. Nothing is copied or deleted.\n\n` +
    `Please confirm the club retains the publication/distribution rights for this collection:`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text("✅ I confirm the rights — prepare dry-run", `mig:rts:${creator.id}`)
        .row()
        .text("❌ Cancel", "mig:pick"),
    }
  );
});

migrationComposer.callbackQuery(/^mig:rts:([\w-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Preparing dry-run..." });
  const res = await prepareMigration(ctx.api, {
    creatorId: ctx.match[1],
    adminId: ctx.from!.id,
    rightsConfirmed: true,
  });
  if (!res.ok || !res.job) {
    await ctx.editMessageText(`⚠️ ${res.error ?? "Could not prepare migration."}`, {
      reply_markup: new InlineKeyboard().text("⬅️ Back", "mig:pick"),
    });
    return;
  }
  await showJob(ctx, res.job.id);
});

// ---- Status list / job view ---------------------------------------------------

migrationComposer.callbackQuery("mig:list", async (ctx) => {
  const jobs = (await listMigrationJobs()).slice(0, 12);
  await ctx.answerCallbackQuery();
  const kb = new InlineKeyboard();
  let text = `🚚 *MIGRATION STATUS*\n\n`;
  if (jobs.length === 0) text += `_No migrations yet._`;
  for (const j of jobs) {
    text += `• *${mdSafe(j.creatorName)}* — ${STATUS_LABEL[j.status]} (${j.totals.copied}/${j.totals.items})\n`;
    kb.text(j.creatorName, `mig:view:${j.id}`).row();
  }
  kb.text("🎞️ Move a creator", "mig:pick").row().text("⬅️ Admin Menu", "admin:menu");
  await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: kb });
});

migrationComposer.callbackQuery(/^mig:view:([\w-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await showJob(ctx, ctx.match[1]);
});

// ---- Execution controls ---------------------------------------------------------

migrationComposer.callbackQuery(/^mig:start:([\w-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Starting..." });
  const res = await startMigration(ctx.api, ctx.match[1], ctx.from!.id);
  if (!res.ok && res.error) await ctx.reply(`⚠️ ${res.error}`);
  if (res.ok) {
    // Copy the first batches right away; the cron worker continues the rest.
    await runMigrationStep(ctx.api, ctx.match[1], { maxBatches: 3, timeBudgetMs: 15_000 });
  }
  await showJob(ctx, ctx.match[1]);
});

migrationComposer.callbackQuery(/^mig:run:([\w-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Copying..." });
  const r = await runMigrationStep(ctx.api, ctx.match[1], { maxBatches: 5, timeBudgetMs: 20_000 });
  if (r.reason === "locked") await ctx.reply("ℹ️ Another worker is already running this migration.");
  if (r.reason === "rate_limited") await ctx.reply("ℹ️ Telegram asked us to slow down; the worker will resume automatically.");
  await showJob(ctx, ctx.match[1]);
});

migrationComposer.callbackQuery(/^mig:pause:([\w-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await pauseMigration(ctx.match[1], ctx.from!.id);
  await showJob(ctx, ctx.match[1]);
});

migrationComposer.callbackQuery(/^mig:verify:([\w-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Verifying..." });
  const job = await reevaluateMigration(ctx.api, ctx.match[1]);
  const v = await verifyMigration(ctx.api, ctx.match[1]);
  if (!v.ok) await ctx.reply(`🔍 Verification:\n${v.problems.map((p) => `• ${p}`).join("\n")}`);
  await showJob(ctx, job.id);
});

migrationComposer.callbackQuery(/^mig:excl:([\w-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `🚫 *EXCLUDE UNRESOLVED ITEMS*\n\n` +
    `Only do this if you confirmed these messages no longer exist or must not be moved (for example deleted in the source topic). ` +
    `Excluded items are recorded as administrator-accepted gaps in the audit log; they are *not* copied.`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text("🚫 Exclude failed & ambiguous items", `mig:exclcfm:${ctx.match[1]}`)
        .row()
        .text("⬅️ Back", `mig:view:${ctx.match[1]}`),
    }
  );
});

migrationComposer.callbackQuery(/^mig:exclcfm:([\w-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const n = await excludeUnresolvedItems(ctx.match[1], ctx.from!.id, "Accepted by administrator as non-transferable");
  await reevaluateMigration(ctx.api, ctx.match[1]);
  await ctx.reply(`🚫 Excluded ${n} item(s).`);
  await showJob(ctx, ctx.match[1]);
});

migrationComposer.callbackQuery(/^mig:cancel:([\w-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const res = await cancelMigration(ctx.match[1], ctx.from!.id);
  await ctx.editMessageText(
    res.ok
      ? `⚫ Migration cancelled. The original topic and the creator record were not changed.`
      : `⚠️ ${res.error}`,
    { reply_markup: new InlineKeyboard().text("⬅️ Migrations", "mig:list") }
  );
});

// ---- Finalization -----------------------------------------------------------------

migrationComposer.callbackQuery(/^mig:fin:([\w-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const report = await verifyMigration(ctx.api, ctx.match[1]);
  const job = await getMigrationJob(ctx.match[1]);
  await ctx.editMessageText(
    `✅ *APPROVE FINALIZATION — ${mdSafe(job?.creatorName ?? "")}*\n\n` +
    report.checks.map((c) => `• ${mdSafe(c)}`).join("\n") + "\n\n" +
    (report.ok
      ? `Approving points the existing creator record (same internal ID) at the Retro topic and updates the directory. *Nothing is deleted.*`
      : `⚠️ Discrepancies:\n${report.problems.map((p) => `• ${mdSafe(p)}`).join("\n")}`),
    {
      parse_mode: "Markdown",
      reply_markup: report.ok
        ? new InlineKeyboard().text("✅ Approve & finalize", `mig:fincfm:${ctx.match[1]}`).row().text("⬅️ Back", `mig:view:${ctx.match[1]}`)
        : new InlineKeyboard().text("⬅️ Back", `mig:view:${ctx.match[1]}`),
    }
  );
});

migrationComposer.callbackQuery(/^mig:fincfm:([\w-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Finalizing..." });
  const res = await finalizeMigration(ctx.api, ctx.match[1], ctx.from!.id);
  if (!res.ok) {
    await ctx.reply(`⚠️ ${res.error}`);
  } else {
    await syncPublicDirectory(ctx.api, true).catch(() => {});
  }
  await showJob(ctx, ctx.match[1]);
});

// ---- Source topic deletion (separate destructive confirmation) --------------------

migrationComposer.callbackQuery(/^mig:del:([\w-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const job = await getMigrationJob(ctx.match[1]);
  if (!job) return;
  await ctx.editMessageText(
    `🗑 *REMOVE OLD REGULAR TOPIC — STEP 1/2*\n\n` +
    `*Creator:* ${mdSafe(job.creatorName)}\n` +
    `*Source forum:* \`${job.source.chatId}\`\n` +
    `*Source topic:* \`${job.source.topicId}\` ("${mdSafe(job.creatorName)}")\n` +
    `*Migration result:* ${job.totals.copied} copied · ${job.totals.excluded} excluded · ${job.totals.failed + job.totals.ambiguous + job.totals.pending} unresolved\n\n` +
    `Deleting a topic permanently removes all its messages. Open the Retro topic and check it yourself first.`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text("✅ I manually reviewed the Retro destination", `mig:delrev:${job.id}`)
        .row()
        .text("❌ Keep the old topic", `mig:view:${job.id}`),
    }
  );
});

migrationComposer.callbackQuery(/^mig:delrev:([\w-]+)$/, async (ctx) => {
  const res = await requestSourceDeletion(ctx.match[1], ctx.from!.id, true);
  await ctx.answerCallbackQuery();
  if (!res.ok || !res.summary) {
    await ctx.editMessageText(`⚠️ ${res.error}`, {
      reply_markup: new InlineKeyboard().text("⬅️ Back", `mig:view:${ctx.match[1]}`),
    });
    return;
  }
  const s = res.summary;
  await ctx.editMessageText(
    `🗑 *REMOVE OLD REGULAR TOPIC — STEP 2/2 (IRREVERSIBLE)*\n\n` +
    `You are about to permanently delete topic \`${s.sourceTopicId}\` (${mdSafe(s.creatorName)}) from forum \`${s.sourceChatId}\` ` +
    `with all its messages. ${s.copied} message(s) were copied to Retro topic \`${s.destinationTopicId}\`.\n\n` +
    `This confirmation expires in 10 minutes.`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text("🗑 DELETE the old Regular topic", `mig:delcfm:${ctx.match[1]}`)
        .row()
        .text("❌ Keep it", `mig:view:${ctx.match[1]}`),
    }
  );
});

migrationComposer.callbackQuery(/^mig:delcfm:([\w-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const res = await confirmSourceDeletion(ctx.api, ctx.match[1], ctx.from!.id);
  if (!res.ok) await ctx.reply(`⚠️ ${res.error}`);
  await showJob(ctx, ctx.match[1]);
});

// ---- Inventory commands ----------------------------------------------------------------

migrationComposer.command("index_media", async (ctx) => {
  const parts = (ctx.match ?? "").trim().split(/\s+/);
  // Creator name may contain spaces: links start at the first token that looks like a link.
  const firstLink = parts.findIndex((p) => /t\.me\//i.test(p));
  if (firstLink <= 0) {
    await ctx.reply(
      "Usage: `/index_media <creator name or id> <https://t.me/c/…/topic/message> …`\n" +
      "Right-click a message → Copy link. The topic in each link must be the creator's topic.",
      { parse_mode: "Markdown" }
    );
    return;
  }
  const creator = await resolveCreator(parts.slice(0, firstLink).join(" "));
  if (!creator) {
    await ctx.reply("⚠️ Creator not found.");
    return;
  }
  const res = await indexMediaFromLinks(ctx.from!.id, creator, parts.slice(firstLink));
  await ctx.reply(
    `🗂 *${mdSafe(creator.name)}* — indexed ${res.added}, already known ${res.alreadyIndexed}, rejected ${res.rejected.length}.` +
    (res.rejected.length ? `\n${res.rejected.slice(0, 5).map((r) => `• ${mdSafe(r.reason)}`).join("\n")}` : "") +
    `\n\nWhen every media message is indexed, run \`/attest_inventory ${mdSafe(creator.name)}\`.`,
    { parse_mode: "Markdown" }
  );
});

migrationComposer.command("attest_inventory", async (ctx) => {
  const creator = await resolveCreator(ctx.match ?? "");
  if (!creator) {
    await ctx.reply("Usage: `/attest_inventory <creator name or id>`", { parse_mode: "Markdown" });
    return;
  }
  const updated = await attestInventoryComplete(ctx.from!.id, creator);
  await ctx.reply(
    updated
      ? `✅ Inventory for *${mdSafe(creator.name)}* marked complete by you. Migration will treat the indexed messages as the full collection.`
      : `⚠️ No indexed media for ${creator.name}; index it first with /index_media.`,
    { parse_mode: "Markdown" }
  );
});

migrationComposer.command("retire_creator", async (ctx) => {
  const parts = (ctx.match ?? "").trim().split(/\s+/);
  const when = parts.pop() ?? "";
  const creator = await resolveCreator(parts.join(" "));
  if (!creator || !when) {
    await ctx.reply("Usage: `/retire_creator <creator name> <YYYY-MM-DD|clear>`", { parse_mode: "Markdown" });
    return;
  }
  const updated = await setRetirement(creator, when);
  await ctx.reply(updated ? `✅ Updated retirement for ${creator.name}.` : "⚠️ Invalid date.");
});

migrationComposer.command("relink_creator", async (ctx) => {
  const parts = (ctx.match ?? "").trim().split(/\s+/);
  const topicId = Number(parts.pop());
  const creator = await resolveCreator(parts.join(" "));
  if (!creator || !Number.isInteger(topicId) || topicId <= 0) {
    await ctx.reply("Usage: `/relink_creator <creator name or id> <retro topic id>`", { parse_mode: "Markdown" });
    return;
  }
  const res = await relinkCreatorToRetroTopic(ctx.from!.id, creator, topicId);
  if (res.ok) await syncPublicDirectory(ctx.api, true).catch(() => {});
  await ctx.reply(
    res.ok
      ? `✅ ${creator.name} now points to Retro topic ${topicId}. The old Regular topic was not touched.`
      : `⚠️ ${res.error}`
  );
});
