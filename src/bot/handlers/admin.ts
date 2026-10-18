/**
 * Underground Manager — Administrator Handlers & Controls
 */

import { Composer, InlineKeyboard } from "grammy";
import { adminOnlyMiddleware } from "../middleware/auth.ts";
import {
  adminMenuKeyboard,
  grantConfirmKeyboard,
  grantDurationKeyboard,
  grantReasonKeyboard,
  grantSpacesKeyboard,
  memberManageKeyboard,
} from "../keyboards.ts";
import { messages } from "../messages.ts";
import {
  countMembers,
  getMember,
  getMemberByUsername,
  listMembers,
} from "../../db/members.ts";
import {
  getActiveUserEntitlements,
  getMembershipSummary,
  getUserEntitlements,
  listAllEntitlements,
} from "../../db/entitlements.ts";
import { listPayments } from "../../db/payments.ts";
import { checkBotPermissions, reconcileAllMembers } from "../../access/sync.ts";
import {
  extendComplimentaryAccess,
  grantComplimentaryAccess,
  revokeComplimentaryAccess,
} from "../../complimentary/service.ts";
import {
  ComplimentaryAccessLevel,
  ComplimentaryReason,
  SPACE_IDS,
} from "../../types.ts";
import { getSpaceTitle } from "../../access/spaces.ts";

export const adminComposer = new Composer();

// Apply admin authentication to all routes in this composer
adminComposer.use(adminOnlyMiddleware);

// Admin Main Menu
adminComposer.command("admin", async (ctx) => {
  await ctx.reply(messages.adminMenu(), {
    parse_mode: "Markdown",
    reply_markup: adminMenuKeyboard(),
  });
});

adminComposer.callbackQuery("admin:menu", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(messages.adminMenu(), {
    parse_mode: "Markdown",
    reply_markup: adminMenuKeyboard(),
  });
});

// Member List
adminComposer.callbackQuery("admin:members_list", async (ctx) => {
  const members = await listMembers(15);
  const total = await countMembers();

  let text = `👥 *REGISTERED MEMBERS* (Total: ${total})\n\n`;

  const kb = new InlineKeyboard();
  if (members.length === 0) {
    text += "_No members recorded yet._\n";
  } else {
    for (const m of members) {
      const name = m.username ? `@${m.username}` : m.firstName;
      text += `• \`${m.userId}\` — ${name}\n`;
      kb.text(`Manage ${name}`, `admin:manage:${m.userId}`).row();
    }
  }

  kb.text("⬅️ Admin Menu", "admin:menu");

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(text, {
    parse_mode: "Markdown",
    reply_markup: kb,
  });
});

// Member Lookup Prompt
adminComposer.callbackQuery("admin:lookup_prompt", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `🔍 *MEMBER LOOKUP*\n\n` +
    `To look up a member, send the command with their numeric Telegram ID or @username:\n\n` +
    `Example:\n` +
    `\`/lookup 123456789\`\n` +
    `\`/lookup @username\``,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard().text("⬅️ Admin Menu", "admin:menu"),
    }
  );
});

// /lookup command
adminComposer.command("lookup", async (ctx) => {
  const input = ctx.match?.trim();
  if (!input) {
    await ctx.reply("Please specify a user ID or @username: `/lookup 123456789`", {
      parse_mode: "Markdown",
    });
    return;
  }

  let member = null;
  if (/^\d+$/.test(input)) {
    member = await getMember(Number(input));
  } else {
    member = await getMemberByUsername(input);
  }

  if (!member) {
    await ctx.reply(`❌ Member \`${input}\` not found in database.`, {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard().text("⬅️ Admin Menu", "admin:menu"),
    });
    return;
  }

  const summary = await getMembershipSummary(member.userId);
  const allEntitlements = await getUserEntitlements(member.userId);

  let text =
    `👤 *MEMBER DETAILS*\n\n` +
    `*User ID:* \`${member.userId}\`\n` +
    `*Name:* ${member.firstName} ${member.lastName || ""}\n` +
    `*Username:* ${member.username ? `@${member.username}` : "None"}\n` +
    `*First Seen:* ${new Date(member.firstSeenAt).toLocaleString()}\n` +
    `*Membership:* ${summary.primaryType}\n` +
    `*Active Spaces:* ${summary.accessibleSpaces.join(", ") || "None"}\n` +
    `*Expires:* ${summary.effectiveExpiry ? new Date(summary.effectiveExpiry).toLocaleString() : "N/A"}\n\n` +
    `*Entitlements History:*\n`;

  if (allEntitlements.length === 0) {
    text += "_No entitlement records found._\n";
  } else {
    for (const ent of allEntitlements.slice(0, 5)) {
      const statusIcon = ent.status === "active" ? "🟢" : "⚪";
      text += `${statusIcon} *${ent.source}* (${ent.status})\n  Expires: ${new Date(ent.expiresAt).toLocaleDateString()}\n`;
    }
  }

  const activeComplimentary = summary.activeEntitlements.find(
    (e) => e.source === "complimentary"
  );

  await ctx.reply(text, {
    parse_mode: "Markdown",
    reply_markup: memberManageKeyboard(member.userId, activeComplimentary?.id),
  });
});

// Manage Specific Member Callback
adminComposer.callbackQuery(/^admin:manage:(\d+)$/, async (ctx) => {
  const userId = Number(ctx.match[1]);
  const member = await getMember(userId);
  if (!member) {
    await ctx.answerCallbackQuery({ text: "Member not found" });
    return;
  }

  const summary = await getMembershipSummary(userId);
  const activeComp = summary.activeEntitlements.find(
    (e) => e.source === "complimentary"
  );

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `👤 *MANAGE MEMBER: \`${userId}\`*\n\n` +
    `*Name:* ${member.firstName}\n` +
    `*Username:* ${member.username ? `@${member.username}` : "None"}\n` +
    `*Membership:* ${summary.primaryType}\n` +
    `*Expires:* ${summary.effectiveExpiry ? new Date(summary.effectiveExpiry).toLocaleDateString() : "None"}`,
    {
      parse_mode: "Markdown",
      reply_markup: memberManageKeyboard(userId, activeComp?.id),
    }
  );
});

// Grant Complimentary Wizard Entry
adminComposer.callbackQuery("admin:grant_wizard", async (ctx) => {
  const members = await listMembers(10);
  const kb = new InlineKeyboard();

  for (const m of members) {
    const label = m.username ? `@${m.username}` : `${m.firstName} (${m.userId})`;
    kb.text(label, `admin:grant_dur:${m.userId}:30`).row();
  }
  kb.text("⬅️ Admin Menu", "admin:menu");

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `🎁 *GRANT COMPLIMENTARY ACCESS — STEP 1*\n\n` +
    `Select a registered member below, or send command:\n\n` +
    `\`/grant <userId> [days]\`\n` +
    `Example: \`/grant 123456789 30\``,
    {
      parse_mode: "Markdown",
      reply_markup: kb,
    }
  );
});

// /grant command shorthand
adminComposer.command("grant", async (ctx) => {
  const args = ctx.match?.trim().split(/\s+/) || [];
  const targetId = Number(args[0]);
  const days = args[1] ? Number(args[1]) : 30;

  if (!targetId || isNaN(targetId)) {
    await ctx.reply("Usage: `/grant <numeric_user_id> [days]`\nExample: `/grant 123456789 30`", {
      parse_mode: "Markdown",
    });
    return;
  }

  await ctx.reply(
    `🎁 *GRANT COMPLIMENTARY ACCESS*\n\nTarget User ID: \`${targetId}\`\nSelect duration:`,
    {
      parse_mode: "Markdown",
      reply_markup: grantDurationKeyboard(targetId),
    }
  );
});

// Grant Step: Choose Duration
adminComposer.callbackQuery(/^admin:grant_dur:(\d+):(\d+)$/, async (ctx) => {
  const userId = Number(ctx.match[1]);
  const duration = Number(ctx.match[2]);

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `🎁 *GRANT COMPLIMENTARY ACCESS — STEP 2*\n\n` +
    `*Target Member:* \`${userId}\`\n` +
    `*Duration:* ${duration} Days\n\n` +
    `Select the reason for this grant:`,
    {
      parse_mode: "Markdown",
      reply_markup: grantReasonKeyboard(userId, duration),
    }
  );
});

// Grant Step: Choose Reason
adminComposer.callbackQuery(/^admin:grant_rsn:(\d+):(\d+):([a-z_]+)$/, async (ctx) => {
  const userId = Number(ctx.match[1]);
  const duration = Number(ctx.match[2]);
  const reason = ctx.match[3] as ComplimentaryReason;

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `🎁 *GRANT COMPLIMENTARY ACCESS — STEP 3*\n\n` +
    `*Target Member:* \`${userId}\`\n` +
    `*Duration:* ${duration} Days\n` +
    `*Reason:* ${reason}\n\n` +
    `Select authorized spaces:`,
    {
      parse_mode: "Markdown",
      reply_markup: grantSpacesKeyboard(userId, duration, reason),
    }
  );
});

// Grant Step: Choose Spaces
adminComposer.callbackQuery(
  /^admin:grant_spc:(\d+):(\d+):([a-z_]+):([a-z_]+)$/,
  async (ctx) => {
    const userId = Number(ctx.match[1]);
    const duration = Number(ctx.match[2]);
    const reason = ctx.match[3] as ComplimentaryReason;
    const level = ctx.match[4] as ComplimentaryAccessLevel;

    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `🎁 *CONFIRM COMPLIMENTARY GRANT*\n\n` +
      `*Target Member:* \`${userId}\`\n` +
      `*Duration:* ${duration} Days\n` +
      `*Reason:* ${reason}\n` +
      `*Access Level:* ${level}\n\n` +
      `Please confirm to activate access immediately:`,
      {
        parse_mode: "Markdown",
        reply_markup: grantConfirmKeyboard(userId, duration, reason, level),
      }
    );
  }
);

// Grant Step: Confirm & Execute Grant
adminComposer.callbackQuery(
  /^admin:grant_cfm:(\d+):(\d+):([a-z_]+):([a-z_]+)$/,
  async (ctx) => {
    const adminId = ctx.from!.id;
    const userId = Number(ctx.match[1]);
    const duration = Number(ctx.match[2]);
    const reason = ctx.match[3] as ComplimentaryReason;
    const level = ctx.match[4] as ComplimentaryAccessLevel;

    const result = await grantComplimentaryAccess({
      adminId,
      userId,
      durationDays: duration,
      reason,
      level,
    });

    if (!result.success || !result.entitlement) {
      await ctx.answerCallbackQuery({
        text: `Error: ${result.error ?? "Failed to grant"}`,
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Complimentary access granted!" });
    await ctx.editMessageText(
      `✅ *COMPLIMENTARY ACCESS ACTIVATED*\n\n` +
      `*Member:* \`${userId}\`\n` +
      `*Duration:* ${duration} Days\n` +
      `*Expires:* ${new Date(result.entitlement.expiresAt).toLocaleDateString()}\n` +
      `*Spaces:* ${result.entitlement.spaces.join(", ")}`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("⬅️ Admin Menu", "admin:menu"),
      }
    );

    // Notify the member directly
    try {
      await ctx.api.sendMessage(
        userId,
        `🎁 *You have been granted complimentary VIP access!*\n\n` +
        `Access is active for *${duration} days* (until ${new Date(
          result.entitlement.expiresAt
        ).toLocaleDateString()}).\n\n` +
        `Tap below to join your spaces:`,
        {
          parse_mode: "Markdown",
          reply_markup: new InlineKeyboard().text(
            "🔓 Access My Channels",
            "member:channels"
          ),
        }
      );
    } catch {
      // Member might not have started bot yet
    }
  }
);

// Extend Entitlement
adminComposer.callbackQuery(/^admin:extend_ent:(\d+):([^:]+):(\d+)$/, async (ctx) => {
  const adminId = ctx.from!.id;
  const entitlementId = ctx.match[2];
  const days = Number(ctx.match[3]);

  const result = await extendComplimentaryAccess(adminId, entitlementId, days);
  if (!result.success || !result.entitlement) {
    await ctx.answerCallbackQuery({ text: `Failed: ${result.error}` });
    return;
  }

  await ctx.answerCallbackQuery({ text: `Extended by ${days} days!` });
  await ctx.reply(
    `✅ Entitlement extended by ${days} days.\nNew expiry: ${new Date(
      result.entitlement.expiresAt
    ).toLocaleString()}`,
    {
      reply_markup: new InlineKeyboard().text("⬅️ Admin Menu", "admin:menu"),
    }
  );
});

// Revoke Entitlement
adminComposer.callbackQuery(/^admin:revoke_ent:(\d+):([^:]+)$/, async (ctx) => {
  const adminId = ctx.from!.id;
  const entitlementId = ctx.match[2];

  const result = await revokeComplimentaryAccess(
    adminId,
    entitlementId,
    "Revoked via admin dashboard"
  );
  if (!result.success) {
    await ctx.answerCallbackQuery({ text: `Failed: ${result.error}` });
    return;
  }

  await ctx.answerCallbackQuery({ text: "Access revoked!" });
  await ctx.reply(`⛔ Entitlement revoked successfully.`, {
    reply_markup: new InlineKeyboard().text("⬅️ Admin Menu", "admin:menu"),
  });
});

// Subscription Overview
adminComposer.callbackQuery("admin:subs_overview", async (ctx) => {
  const payments = await listPayments(100);
  const entitlements = await listAllEntitlements();
  const totalMembers = await countMembers();

  const totalPaidRevenue = payments
    .filter((p) => p.status === "completed")
    .reduce((sum, p) => sum + p.amount, 0);

  const activePaid = entitlements.filter(
    (e) =>
      e.source === "telegram_stars" &&
      e.status === "active" &&
      new Date(e.expiresAt).getTime() > Date.now()
  ).length;

  const activeComp = entitlements.filter(
    (e) =>
      e.source === "complimentary" &&
      e.status === "active" &&
      new Date(e.expiresAt).getTime() > Date.now()
  ).length;

  const text =
    `📊 *SUBSCRIPTION & REVENUE OVERVIEW*\n\n` +
    `*Total Registered Users:* ${totalMembers}\n` +
    `*Active Paid Subscribers:* ${activePaid}\n` +
    `*Active Complimentary:* ${activeComp}\n` +
    `*Confirmed Stars Transactions:* ${payments.length}\n` +
    `*Total Stars Revenue:* ⭐️ ${totalPaidRevenue}\n\n` +
    `_Full financial treasury and payout controls will be handled in UG-03._`;

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(text, {
    parse_mode: "Markdown",
    reply_markup: new InlineKeyboard().text("⬅️ Admin Menu", "admin:menu"),
  });
});

// System Status & Permissions Check
adminComposer.callbackQuery("admin:status", async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Checking space permissions..." });

  let text = `⚙️ *SYSTEM STATUS & BOT PERMISSIONS*\n\n`;

  for (const spaceId of SPACE_IDS) {
    const perm = await checkBotPermissions(ctx.api, spaceId);
    const title = getSpaceTitle(spaceId);
    if (perm.ok) {
      text += `🟢 *${title}:* OK (Admin permissions verified)\n`;
    } else {
      text += `🔴 *${title}:* Missing [${perm.missingPermissions.join(", ")}]\n`;
    }
  }

  text += `\n*Database:* Deno KV (Connected)\n` +
    `*Reconciliation:* Hourly via Deno Cron\n` +
    `*Payment Mode:* Official Telegram Stars (XTR)`;

  await ctx.editMessageText(text, {
    parse_mode: "Markdown",
    reply_markup: new InlineKeyboard()
      .text("🔄 Trigger Safe Resync", "admin:resync")
      .row()
      .text("⬅️ Admin Menu", "admin:menu"),
  });
});

// Trigger Safe Resynchronization
adminComposer.callbackQuery("admin:resync", async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Running access reconciliation..." });

  try {
    const result = await reconcileAllMembers(ctx.api);

    await ctx.reply(
      `🔄 *ACCESS RECONCILIATION COMPLETE*\n\n` +
      `*Checked Members:* ${result.checkedUsers}\n` +
      `*Expired Members Removed:* ${result.removedCount}\n` +
      `*Errors Encountered:* ${result.errors.length}\n` +
      (result.errors.length > 0
        ? `\n_Errors:_\n${result.errors.slice(0, 3).join("\n")}`
        : ""),
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("⬅️ Admin Menu", "admin:menu"),
      }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.reply(`⚠️ Reconciliation error: ${msg}`);
  }
});

// ==============================================================================
// UG-02 Administrator Controls: Creators, Directory, Wanted List & Voting
// ==============================================================================

// Creator Management Menu
adminComposer.callbackQuery("admin:creators_menu", async (ctx) => {
  const { listCreators } = await import("../../db/creators.ts");
  const creators = await listCreators();
  const withContent = creators.filter((c) => c.hasContent).length;

  let text =
    `👩‍🎤 *CREATOR DIRECTORY MANAGEMENT*\n\n` +
    `*Total Registered Creators:* ${creators.length}\n` +
    `*Available in Directory (with media):* ${withContent}\n\n` +
    `*Recent Creators:*\n`;

  if (creators.length === 0) {
    text += `_No creators registered yet. Topics created in TOKEBEC VIP COLLECTIONS will appear here._\n\n`;
  } else {
    for (const c of creators.slice(0, 10)) {
      const statusIcon = c.status === "archived" ? "📦" : (c.hasContent ? "🟢" : "⚪");
      text += `${statusIcon} *${c.name}* (Thread: \`${c.topicId}\`)\n`;
    }
    text += "\n";
  }

  text += `💡 _To manually pair an existing topic:_ \`/register_creator <thread_id> <name>\``;

  const kb = new InlineKeyboard()
    .text("🔄 Sync Public Directory Now", "admin:sync_dir")
    .row()
    .text("⬅️ Admin Menu", "admin:menu");

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(text, {
    parse_mode: "Markdown",
    reply_markup: kb,
  });
});

// Trigger Public Directory Sync
adminComposer.callbackQuery("admin:sync_dir", async (ctx) => {
  const { syncPublicDirectory } = await import("../../directory/sync.ts");
  await ctx.answerCallbackQuery({ text: "Synchronizing Public Creator Directory..." });

  const result = await syncPublicDirectory(ctx.api, true);
  if (result.updated) {
    await ctx.reply(`✅ *Public Directory Synchronized!*\nPublished/updated ${result.publishedCount} message(s).`, {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard().text("⬅️ Creators Menu", "admin:creators_menu"),
    });
  } else {
    await ctx.reply(`ℹ️ Directory sync completed: ${result.reason || result.error || "No updates needed."}`, {
      reply_markup: new InlineKeyboard().text("⬅️ Creators Menu", "admin:creators_menu"),
    });
  }
});

// /register_creator command
adminComposer.command("register_creator", async (ctx) => {
  const args = ctx.match?.trim().split(/\s+/);
  if (!args || args.length < 2) {
    await ctx.reply("Usage: `/register_creator <numeric_topic_id> <Creator Name>`\nExample: `/register_creator 42 Aria`", {
      parse_mode: "Markdown",
    });
    return;
  }

  const topicId = Number(args[0]);
  const creatorName = args.slice(1).join(" ");
  const config = (await import("../../config.ts")).getConfig();

  if (isNaN(topicId) || topicId <= 0) {
    await ctx.reply("Invalid topic ID. Must be a positive numeric thread ID.");
    return;
  }

  const { registerOrRepairTopic } = await import("../../creators/service.ts");
  const creator = await registerOrRepairTopic(
    ctx.from!.id,
    config.VIP_COLLECTIONS_CHAT_ID,
    topicId,
    creatorName
  );

  await ctx.reply(
    `✅ *Creator Registered!*\n\n` +
    `• *Name:* ${creator.name}\n` +
    `• *Topic ID:* \`${creator.topicId}\`\n` +
    `• *Chat ID:* \`${creator.chatId}\`\n` +
    `• *Status:* Active`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard().text("👩‍🎤 Creators Menu", "admin:creators_menu"),
    }
  );
});

// Wanted List Admin Menu
adminComposer.callbackQuery("admin:wanted_menu", async (ctx) => {
  const { listWantedCandidates } = await import("../../db/wanted.ts");
  const { WANTED_STATUS_LABELS } = await import("../../types.ts");

  const candidates = await listWantedCandidates();
  const pendingReview = candidates.filter((c) => c.status === "requested" || c.status === "pricing_review");

  let text =
    `🎯 *WANTED LIST ADMINISTRATION*\n\n` +
    `*Total Candidates:* ${candidates.length}\n` +
    `*Pending Review:* ${pendingReview.length}\n\n` +
    `*Top Community Nominations:*\n`;

  const kb = new InlineKeyboard();
  if (candidates.length === 0) {
    text += `_No candidates on Wanted List yet._\n\n`;
  } else {
    for (const c of candidates.slice(0, 8)) {
      const statusLabel = WANTED_STATUS_LABELS[c.status] || c.status;
      text += `• *${c.name}* — ${c.supportCount} supporters \`[${statusLabel}]\`\n`;
      kb.text(`Manage ${c.name}`, `admin:manage_cand:${c.id}`).row();
    }
    text += "\n";
  }

  kb.text("🔄 Sync Wanted Channel", "admin:sync_wanted_channel")
    .row()
    .text("⬅️ Admin Menu", "admin:menu");

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(text, {
    parse_mode: "Markdown",
    reply_markup: kb,
  });
});

// Manage Specific Candidate
adminComposer.callbackQuery(/^admin:manage_cand:([a-f0-9-]+)$/, async (ctx) => {
  const candidateId = ctx.match[1];
  const { getWantedCandidate } = await import("../../db/wanted.ts");
  const { WANTED_STATUS_LABELS } = await import("../../types.ts");

  const candidate = await getWantedCandidate(candidateId);
  if (!candidate) {
    await ctx.answerCallbackQuery({ text: "Candidate not found." });
    return;
  }

  const statusLabel = WANTED_STATUS_LABELS[candidate.status] || candidate.status;
  const text =
    `🎯 *MANAGE CANDIDATE: ${candidate.name}*\n\n` +
    `*Supporters:* ${candidate.supportCount}\n` +
    `*Current Status:* \`${statusLabel}\`\n` +
    `*Profile URL:* ${candidate.profileUrl || "None"}\n` +
    `*Suggested Date:* ${new Date(candidate.createdAt).toLocaleDateString()}\n\n` +
    `Update status:`;

  const kb = new InlineKeyboard()
    .text("✅ Approve for Voting", `admin:set_stat:${candidate.id}:eligible_for_voting`)
    .text("💰 Pricing Review", `admin:set_stat:${candidate.id}:pricing_review`)
    .row()
    .text("🎉 Mark Acquired", `admin:set_stat:${candidate.id}:acquired`)
    .text("🟢 Mark Available", `admin:set_stat:${candidate.id}:available`)
    .row()
    .text("⛔ Reject / Unavailable", `admin:set_stat:${candidate.id}:rejected_unavailable`)
    .row()
    .text("⬅️ Wanted Admin", "admin:wanted_menu");

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(text, {
    parse_mode: "Markdown",
    reply_markup: kb,
  });
});

// Set Candidate Status
adminComposer.callbackQuery(/^admin:set_stat:([a-f0-9-]+):([a-z_]+)$/, async (ctx) => {
  const candidateId = ctx.match[1];
  const newStatus = ctx.match[2] as any;
  const { updateWantedStatus } = await import("../../db/wanted.ts");

  const updated = await updateWantedStatus(candidateId, newStatus, `Updated by admin ${ctx.from!.id}`);
  if (!updated) {
    await ctx.answerCallbackQuery({ text: "Failed to update status." });
    return;
  }

  await ctx.answerCallbackQuery({ text: `Status updated to ${newStatus}` });
  await ctx.reply(`✅ Candidate *${updated.name}* status updated to \`${newStatus}\`.`, {
    parse_mode: "Markdown",
    reply_markup: new InlineKeyboard().text("🎯 Wanted Admin", "admin:wanted_menu"),
  });
});

// Sync Wanted List Channel
adminComposer.callbackQuery("admin:sync_wanted_channel", async (ctx) => {
  const { syncWantedListChannel } = await import("../../wanted/service.ts");
  await ctx.answerCallbackQuery({ text: "Syncing Wanted List channel..." });

  const result = await syncWantedListChannel(ctx.api);
  if (result.success) {
    await ctx.reply("✅ Wanted List channel synchronized successfully!", {
      reply_markup: new InlineKeyboard().text("🎯 Wanted Admin", "admin:wanted_menu"),
    });
  } else {
    await ctx.reply(`⚠️ Failed to sync Wanted List channel: ${result.error}`, {
      reply_markup: new InlineKeyboard().text("🎯 Wanted Admin", "admin:wanted_menu"),
    });
  }
});

// Voting Administration Menu
adminComposer.callbackQuery("admin:voting_menu", async (ctx) => {
  const { getActiveBallot, listPastBallots, tallyBallot } = await import("../../db/voting.ts");
  const activeBallot = await getActiveBallot();
  const past = await listPastBallots(3);

  let text = `🗳️ *ACQUISITION VOTING ADMINISTRATION*\n\n`;

  const kb = new InlineKeyboard();

  if (activeBallot) {
    const summary = await tallyBallot(activeBallot.id);
    const closesStr = new Date(activeBallot.closesAt).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

    text +=
      `🟢 *ACTIVE BALLOT: ${activeBallot.title}*\n` +
      `*Closes:* ${closesStr}\n` +
      `*Votes Cast So Far:* ${summary.totalVotes}\n` +
      `*Candidates:* ${activeBallot.candidates.map((c) => c.creatorName).join(", ")}\n\n`;

    kb.text("🛑 Close Ballot Early & Tally", `admin:close_ballot:${activeBallot.id}`).row();
  } else {
    text += `⚪ _No active voting ballot in progress._\n\n`;
    kb.text("📝 Prepare Monthly Ballot", "admin:prepare_ballot").row();
  }

  if (past.length > 0) {
    text += `*Past Ballots:*\n`;
    for (const b of past) {
      text += `• ${b.title} (${b.status})\n`;
    }
  }

  kb.text("⬅️ Admin Menu", "admin:menu");

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(text, {
    parse_mode: "Markdown",
    reply_markup: kb,
  });
});

// Prepare Ballot Prompt
adminComposer.callbackQuery("admin:prepare_ballot", async (ctx) => {
  const { listWantedCandidates } = await import("../../db/wanted.ts");
  const candidates = await listWantedCandidates();
  const eligible = candidates.filter(
    (c) =>
      (c.status === "eligible_for_voting" || c.status === "requested") &&
      c.supportCount > 0
  );

  if (eligible.length < 2) {
    await ctx.answerCallbackQuery({
      text: "Need at least 2 candidates with supporters to create a ballot.",
      show_alert: true,
    });
    return;
  }

  const kb = new InlineKeyboard()
    .text("🚀 Open Ballot Now (Top 5 Candidates)", "admin:launch_ballot")
    .row()
    .text("❌ Cancel", "admin:voting_menu");

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `🗳️ *PREPARE MONTHLY CREATOR BALLOT*\n\n` +
    `*Eligible Candidates for Shortlist:*\n` +
    eligible.slice(0, 5).map((c, i) => `${i + 1}. *${c.name}* (${c.supportCount} supporters)`).join("\n") +
    `\n\nVoting will run for 5 days. Confirm to launch:`,
    {
      parse_mode: "Markdown",
      reply_markup: kb,
    }
  );
});

// Launch Ballot Execution
adminComposer.callbackQuery("admin:launch_ballot", async (ctx) => {
  const { prepareMonthlyBallot } = await import("../../voting/service.ts");

  try {
    const ballot = await prepareMonthlyBallot({
      adminId: ctx.from!.id,
    });

    await ctx.answerCallbackQuery({ text: "Ballot published!" });
    await ctx.reply(
      `🎉 *BALLOT SUCCESSFULLY OPENED!*\n\n` +
      `*Title:* ${ballot.title}\n` +
      `*Candidates:* ${ballot.candidates.map((c) => c.creatorName).join(", ")}\n` +
      `*Closes:* ${new Date(ballot.closesAt).toLocaleString()}`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("🗳️ Voting Admin", "admin:voting_menu"),
      }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.answerCallbackQuery({ text: `Failed: ${msg}`, show_alert: true });
  }
});

// Close Ballot Early
adminComposer.callbackQuery(/^admin:close_ballot:([a-f0-9-]+)$/, async (ctx) => {
  const ballotId = ctx.match[1];
  const { closeAndFinalizeBallot } = await import("../../voting/service.ts");

  await ctx.answerCallbackQuery({ text: "Closing ballot and computing tallies..." });

  try {
    const summary = await closeAndFinalizeBallot(ballotId, ctx.api);

    await ctx.reply(
      `📊 *BALLOT CLOSED!*\n\n` +
      `*Total Votes Cast:* ${summary.totalVotes}\n` +
      `*Turnout:* ${summary.eligibleTurnoutPct}%\n` +
      `*Outcome:* ${summary.isTie ? "TIE (Runoff Scheduled)" : (summary.winner ? `Winner: *${summary.winner.creatorName}*` : "No votes cast")}\n\n` +
      `*Candidate Tallies:*\n` +
      summary.tally.map((t) => `• ${t.name}: ${t.votes} votes`).join("\n"),
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("🗳️ Voting Admin", "admin:voting_menu"),
      }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.reply(`⚠️ Failed closing ballot: ${msg}`);
  }
});

