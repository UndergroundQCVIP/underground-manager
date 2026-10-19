/**
 * LA CONFRÉRIE — Administrator Handlers & Controls
 */

import { Composer, InlineKeyboard } from "grammy";
import { getClubName } from "../../config.ts";
import { adminRouteGuard } from "../middleware/auth.ts";
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
import { getChatId, getSpaceTitle } from "../../access/spaces.ts";

export const adminComposer = new Composer();

// Apply admin authentication to administrator routes only, so ordinary members'
// updates keep flowing to the Wanted List / Voting handlers registered after this composer.
export const ADMIN_COMMANDS = [
  "admin", "lookup", "grant", "register_creator",
  "index_media", "attest_inventory", "retire_creator", "move_to_retro", "relink_creator",
];
adminComposer.use(
  adminRouteGuard({ callbackPrefixes: ["admin:", "mig:"], commands: ADMIN_COMMANDS })
);

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
    const title = getSpaceTitle(spaceId);
    if (!getChatId(spaceId)) {
      text += `⚪ *${title}:* not configured\n`;
      continue;
    }
    const perm = await checkBotPermissions(ctx.api, spaceId);
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
  const { listCreators, creatorCollection } = await import("../../db/creators.ts");
  const creators = await listCreators();
  const withContent = creators.filter((c) => c.hasContent).length;
  const retro = creators.filter((c) => creatorCollection(c) === "retro").length;

  const text =
    `👩‍🎤 *CREATORS — ${getClubName()}*\n\n` +
    `*Total Registered Creators:* ${creators.length} (Regular ${creators.length - retro} · Retro ${retro})\n` +
    `*Listed in Directory (with media):* ${withContent}\n\n` +
    `💡 _Pair an existing topic:_ \`/register_creator <thread_id> <name>\`\n` +
    `💡 _Retire/unretire:_ \`/retire_creator <name> <YYYY-MM-DD|clear>\``;

  const kb = new InlineKeyboard()
    .text("👀 View Creators", "admin:creators_list:0")
    .text("📝 Register Creator", "admin:creator_register_help")
    .row()
    .text("✏️ Edit Creator", "admin:creator_edit_help")
    .text("🎞️ Move to Retro", "mig:pick")
    .row()
    .text("🚚 Migration Status", "mig:list")
    .text("🛠️ Repair Directory", "admin:repair_dir")
    .row()
    .text("⬅️ Admin Menu", "admin:menu");

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: kb });
});

// View Creators (paged, with collection labels)
adminComposer.callbackQuery(/^admin:creators_list:(\d+)$/, async (ctx) => {
  const { listCreators, creatorCollection } = await import("../../db/creators.ts");
  const page = Number(ctx.match[1]);
  const pageSize = 8;
  const creators = await listCreators();
  const slice = creators.slice(page * pageSize, page * pageSize + pageSize);

  let text = `👀 *CREATORS* (page ${page + 1}/${Math.max(1, Math.ceil(creators.length / pageSize))})\n\n`;
  const kb = new InlineKeyboard();
  if (slice.length === 0) text += "_No creators registered yet._\n";
  for (const c of slice) {
    const icon = c.status === "archived" ? "📦" : c.hasContent ? "🟢" : "⚪";
    const label = creatorCollection(c) === "retro" ? "Retro" : "Regular";
    text += `${icon} *${c.name}* — ${label}\n`;
    kb.text(`${c.name} (${label})`, `admin:creator_view:${c.id}`).row();
  }
  if (page > 0) kb.text("◀️ Prev", `admin:creators_list:${page - 1}`);
  if ((page + 1) * pageSize < creators.length) kb.text("Next ▶️", `admin:creators_list:${page + 1}`);
  kb.row().text("⬅️ Creators", "admin:creators_menu");

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: kb });
});

adminComposer.callbackQuery(/^admin:creator_view:([a-zA-Z0-9-]+)$/, async (ctx) => {
  const { getCreator, creatorCollection } = await import("../../db/creators.ts");
  const { listMediaIndex } = await import("../../db/media_index.ts");
  const { getActiveMigrationForCreator } = await import("../../db/migrations.ts");
  const creator = await getCreator(ctx.match[1]);
  await ctx.answerCallbackQuery();
  if (!creator) {
    await ctx.editMessageText("⚠️ Creator not found.", {
      reply_markup: new InlineKeyboard().text("⬅️ Creators", "admin:creators_menu"),
    });
    return;
  }
  const collection = creatorCollection(creator);
  const indexed = (await listMediaIndex(creator.id, { chatId: creator.chatId, topicId: creator.topicId })).length;
  const job = await getActiveMigrationForCreator(creator.id);
  const text =
    `👩‍🎤 *${creator.name}*\n\n` +
    `*Collection:* ${collection === "retro" ? "Retro" : "Regular"}\n` +
    `*Forum / Topic:* \`${creator.chatId}\` / \`${creator.topicId}\`\n` +
    `*Last content update:* ${creator.lastContentUpdatedAt ? new Date(creator.lastContentUpdatedAt).toLocaleDateString("en-US") : "—"}\n` +
    `*Publication rights:* ${creator.rightsStatus === "verified" ? "✅ verified" : "⚠️ unverified"}\n` +
    `*Indexed media messages:* ${indexed} (${creator.inventoryStatus === "complete" ? "inventory complete" : "inventory NOT confirmed complete"})\n` +
    (creator.retiredAt ? `*Retirement:* ${new Date(creator.retiredAt).toLocaleDateString("en-US")}\n` : "") +
    (job ? `*Migration:* ${job.status.replace(/_/g, " ")}\n` : "");
  const kb = new InlineKeyboard();
  if (collection === "regular") kb.text("🎞️ Move to Retro", `mig:sel:${creator.id}`).row();
  if (job) kb.text("🚚 Open Migration", `mig:view:${job.id}`).row();
  kb.text("⬅️ Creators", "admin:creators_list:0");
  await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: kb });
});

adminComposer.callbackQuery("admin:creator_register_help", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `📝 *REGISTER CREATOR*\n\n` +
    `New topics created in the Regular or Retro forum register automatically.\n` +
    `To pair an existing topic in the Regular forum:\n\`/register_creator <thread_id> <name>\``,
    { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("⬅️ Creators", "admin:creators_menu") }
  );
});

adminComposer.callbackQuery("admin:creator_edit_help", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `✏️ *EDIT CREATOR*\n\n` +
    `• *Rename:* rename the forum topic in Telegram — the bot follows it.\n` +
    `• *Retire:* \`/retire_creator <name> <YYYY-MM-DD>\` (or \`clear\`)\n` +
    `• *Index older media:* \`/index_media <name> <topic message links…>\`\n` +
    `• *Attest inventory complete:* \`/attest_inventory <name>\`\n\n` +
    `The internal creator ID never changes.`,
    { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("⬅️ Creators", "admin:creators_menu") }
  );
});

adminComposer.callbackQuery("admin:repair_dir", async (ctx) => {
  const { repairDirectory } = await import("../../creators/admin.ts");
  const { syncPublicDirectory } = await import("../../directory/sync.ts");
  await ctx.answerCallbackQuery({ text: "Repairing directory..." });
  const report = await repairDirectory();
  const sync = await syncPublicDirectory(ctx.api, true);
  await ctx.editMessageText(
    `🛠️ *DIRECTORY REPAIRED*\n\n` +
    `• Creators checked: ${report.checked}\n` +
    `• Lookup indexes repaired: ${report.indexesRepaired}\n` +
    `• Duplicate names: ${report.duplicateNames.length ? report.duplicateNames.join(", ") : "none"}\n` +
    `• Public directory: ${sync.updated ? `republished (${sync.publishedCount} message(s))` : sync.reason ?? sync.error ?? "unchanged"}`,
    { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("⬅️ Creators", "admin:creators_menu") }
  );
});

// Directory menu
adminComposer.callbackQuery("admin:sync_dir_menu", async (ctx) => {
  const { getDirectorySyncState } = await import("../../db/directory.ts");
  const { listCreators, creatorCollection } = await import("../../db/creators.ts");
  const state = await getDirectorySyncState();
  const listed = await listCreators({ status: "active", hasContentOnly: true });
  const retro = listed.filter((c) => creatorCollection(c) === "retro").length;
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `📚 *DIRECTORY*\n\n` +
    `• Listed creators: ${listed.length} (Regular ${listed.length - retro} · Retro ${retro})\n` +
    `• Last sync: ${state.lastSyncAt ? new Date(state.lastSyncAt).toLocaleString() : "never"}\n` +
    `• Pending changes: ${state.isDirty ? "yes" : "no"}`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text("🔄 Sync Public Directory Now", "admin:sync_dir")
        .row()
        .text("🛠️ Repair Directory", "admin:repair_dir")
        .row()
        .text("⬅️ Admin Menu", "admin:menu"),
    }
  );
});

// Membership Plans (admin overview; prices are configured via environment, never hardcoded)
adminComposer.callbackQuery("admin:plans", async (ctx) => {
  const { getPlan } = await import("../../plans/plans.ts");
  const { computeTierRevenue, formatTierRevenueLines } = await import("../../treasury/tiers.ts");
  const regular = getPlan("regular");
  const retro = getPlan("retro_plus");
  const tiers = await computeTierRevenue();
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `💎 *MEMBERSHIP PLANS*\n\n` +
    `*Regular:* ${regular.priceStars} Stars / 30 days — ${regular.enabled ? "🟢 on sale" : "🔴 disabled"}\n` +
    `*Retro Plus:* ${retro.priceStars > 0 ? `${retro.priceStars} Stars / 30 days` : "price not configured"} — ${retro.enabled ? "🟢 on sale" : "🔴 billing disabled"}\n\n` +
    `*Revenue by tier (this month):*\n${formatTierRevenueLines(tiers)}\n` +
    `_Prices are set with STARS_PRICE_AMOUNT and RETRO_PLUS_STARS_PRICE_AMOUNT. Retro Plus stays disabled while its price is 0 or the Retro forum is unset._`,
    { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("⬅️ Admin Menu", "admin:menu") }
  );
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

