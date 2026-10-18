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
