/**
 * LA CONFRÉRIE — Member Wanted List Handlers
 */

import { getClubName } from "../../config.ts";
import { Composer, InlineKeyboard } from "grammy";
import {
  getCurrentMonthCycle,
  getUserSupportForCycle,
  getWantedCandidate,
  listWantedCandidates,
} from "../../db/wanted.ts";
import { getMembershipSummary } from "../../db/entitlements.ts";
import {
  submitCreatorNomination,
  supportExistingCandidate,
} from "../../wanted/service.ts";
import { getActiveBallot, listPastBallots } from "../../db/voting.ts";
import { WANTED_STATUS_LABELS } from "../../types.ts";

export const wantedComposer = new Composer();

export function wantedMenuKeyboard(hasActiveVote: boolean): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text("📋 View Wanted Creators", "wanted:view")
    .text("💡 Suggest a Creator", "wanted:suggest_prompt")
    .row()
    .text("👍 Support a Creator", "wanted:support_list");

  if (hasActiveVote) {
    kb.text("🗳️ Current Vote", "vote:open").row();
  } else {
    kb.row();
  }

  kb.text("📊 Previous Results", "wanted:results")
    .row()
    .text("⬅️ Main Menu", "member:home");

  return kb;
}

// Open Wanted Menu
wantedComposer.callbackQuery("wanted:menu", async (ctx) => {
  const activeBallot = await getActiveBallot();
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `🎯 *${getClubName()} | WANTED LIST*\n\n` +
    `Tell us which creators we should acquire next!\n\n` +
    `• *Suggest:* Submit new creator requests\n` +
    `• *Support:* Vote on existing community nominations\n` +
    `• *Rules:* 1 suggestion/support per paying member per monthly cycle\n\n` +
    `Select an option below:`,
    {
      parse_mode: "Markdown",
      reply_markup: wantedMenuKeyboard(activeBallot !== null),
    }
  );
});

// View Wanted Creators
wantedComposer.callbackQuery("wanted:view", async (ctx) => {
  const candidates = await listWantedCandidates();
  const active = candidates.filter(
    (c) => c.status !== "available" && c.status !== "rejected_unavailable"
  );

  let text = `🎯 *CURRENT WANTED CREATORS*\n\n`;

  if (active.length === 0) {
    text += `_No active requests on the Wanted List right now._\n`;
  } else {
    active.slice(0, 15).forEach((c, idx) => {
      const statusLabel = WANTED_STATUS_LABELS[c.status] || c.status;
      const countLabel = c.supportCount === 1 ? "1 supporter" : `${c.supportCount} supporters`;
      text += `${idx + 1}. *${c.name}* — ${countLabel} \`[${statusLabel}]\`\n`;
    });
  }

  const kb = new InlineKeyboard()
    .text("👍 Support a Creator", "wanted:support_list")
    .text("💡 Suggest a Creator", "wanted:suggest_prompt")
    .row()
    .text("⬅️ Wanted Menu", "wanted:menu");

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(text, {
    parse_mode: "Markdown",
    reply_markup: kb,
  });
});

// Suggest a Creator Prompt
wantedComposer.callbackQuery("wanted:suggest_prompt", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const summary = await getMembershipSummary(userId);
  if (!summary.hasPaid) {
    await ctx.answerCallbackQuery({
      text: "Voting & nominations are reserved for paid subscribers.",
      show_alert: true,
    });
    return;
  }

  const cycleId = getCurrentMonthCycle();
  const existingSupport = await getUserSupportForCycle(cycleId, userId);
  if (existingSupport) {
    await ctx.answerCallbackQuery({
      text: "You have already used your nomination or support for this month.",
      show_alert: true,
    });
    return;
  }

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `💡 *SUGGEST A CREATOR FOR ACQUISITION*\n\n` +
    `To submit a nomination, send the command:\n\n` +
    `\`/suggest <Creator Name> [Optional Profile URL]\`\n\n` +
    `*Examples:*\n` +
    `• \`/suggest Ashley\`\n` +
    `• \`/suggest Nicole https://onlyfans.com/...\`\n\n` +
    `⚠️ _Your suggestion automatically counts as your monthly support selection._`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard().text("⬅️ Wanted Menu", "wanted:menu"),
    }
  );
});

// /suggest command
wantedComposer.command("suggest", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const text = ctx.match?.trim();
  if (!text) {
    await ctx.reply("Usage: `/suggest <Creator Name> [Profile Link]`", {
      parse_mode: "Markdown",
    });
    return;
  }

  const parts = text.split(/\s+/);
  let profileUrl: string | undefined;
  let name = text;

  // Check if last token looks like a URL
  const lastPart = parts[parts.length - 1];
  if (lastPart.startsWith("http://") || lastPart.startsWith("https://")) {
    profileUrl = lastPart;
    name = parts.slice(0, -1).join(" ");
  }

  const result = await submitCreatorNomination({
    userId,
    name,
    profileUrl,
  });

  if (!result.success || !result.candidate) {
    await ctx.reply(`⚠️ ${result.error ?? "Could not record nomination."}`, {
      reply_markup: new InlineKeyboard().text("⬅️ Wanted Menu", "wanted:menu"),
    });
    return;
  }

  if (result.isExistingCandidate) {
    await ctx.reply(
      `✅ *${result.candidate.name}* is already on the Wanted List!\n\n` +
      `Your support has been added. Current supporters: *${result.candidate.supportCount}*.\n\n` +
      `Thank you for helping curate ${getClubName()}!`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("🎯 View Wanted List", "wanted:view"),
      }
    );
  } else {
    await ctx.reply(
      `🎉 *Nomination Submitted!*\n\n` +
      `*${result.candidate.name}* has been added to the Wanted List with 1 supporter.\n\n` +
      `The community can now support this creator for upcoming voting rounds.`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("🎯 View Wanted List", "wanted:view"),
      }
    );
  }
});

// Support Existing Creator List
wantedComposer.callbackQuery("wanted:support_list", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const summary = await getMembershipSummary(userId);
  if (!summary.hasPaid) {
    await ctx.answerCallbackQuery({
      text: "Only active paying subscribers can support creators.",
      show_alert: true,
    });
    return;
  }

  const cycleId = getCurrentMonthCycle();
  const existingSupport = await getUserSupportForCycle(cycleId, userId);
  if (existingSupport) {
    await ctx.answerCallbackQuery({
      text: "You have already used your support selection for this month.",
      show_alert: true,
    });
    return;
  }

  const candidates = await listWantedCandidates();
  const active = candidates.filter(
    (c) => c.status !== "available" && c.status !== "rejected_unavailable"
  );

  const kb = new InlineKeyboard();
  for (const c of active.slice(0, 10)) {
    kb.text(`👍 ${c.name} (${c.supportCount})`, `wanted:sup_confirm:${c.id}`).row();
  }
  kb.text("⬅️ Wanted Menu", "wanted:menu");

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `👍 *SUPPORT A CREATOR ON THE WANTED LIST*\n\n` +
    `Select a creator below to add your monthly support:`,
    {
      parse_mode: "Markdown",
      reply_markup: kb,
    }
  );
});

// Confirm Support Choice Dialog
wantedComposer.callbackQuery(/^wanted:sup_confirm:([a-f0-9-]+)$/, async (ctx) => {
  const candidateId = ctx.match[1];
  const candidate = await getWantedCandidate(candidateId);
  if (!candidate) {
    await ctx.answerCallbackQuery({ text: "Candidate not found." });
    return;
  }

  const kb = new InlineKeyboard()
    .text(`✅ Confirm Support: ${candidate.name}`, `wanted:sup_exec:${candidate.id}`)
    .row()
    .text("❌ Cancel", "wanted:menu");

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `👍 *CONFIRM YOUR SUPPORT*\n\n` +
    `Are you sure you want to support *${candidate.name}*?\n\n` +
    `⚠️ _Once confirmed, your support selection for this month is final and cannot be withdrawn or changed._`,
    {
      parse_mode: "Markdown",
      reply_markup: kb,
    }
  );
});

// Execute Confirmed Support
wantedComposer.callbackQuery(/^wanted:sup_exec:([a-f0-9-]+)$/, async (ctx) => {
  const userId = ctx.from?.id;
  const candidateId = ctx.match[1];
  if (!userId) return;

  const result = await supportExistingCandidate(userId, candidateId);
  if (!result.success || !result.candidate) {
    await ctx.answerCallbackQuery({
      text: result.error ?? "Could not register support.",
      show_alert: true,
    });
    return;
  }

  await ctx.answerCallbackQuery({ text: "Support registered!" });
  await ctx.editMessageText(
    `✅ *SUPPORT CONFIRMED!*\n\n` +
    `You have supported *${result.candidate.name}*.\n` +
    `Total supporters: *${result.candidate.supportCount}*.\n\n` +
    `Thank you for contributing to ${getClubName()} acquisitions!`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard().text("🎯 View Wanted List", "wanted:view"),
    }
  );
});

// Previous Voting Results
wantedComposer.callbackQuery("wanted:results", async (ctx) => {
  const past = await listPastBallots(5);

  let text = `📊 *PREVIOUS VOTING RESULTS*\n\n`;
  if (past.length === 0) {
    text += `_No completed voting ballots yet._\n`;
  } else {
    for (const b of past) {
      const winnerCandidate = b.winnerCandidateId
        ? b.candidates.find((c) => c.candidateId === b.winnerCandidateId)
        : undefined;
      const winnerName = winnerCandidate ? winnerCandidate.creatorName : (b.isTie ? "Tie / Runoff" : "Closed");
      text += `• *${b.title}*\n  Winner: *${winnerName}* | Votes: ${b.totalVotesCount ?? 0}\n`;
    }
  }

  const kb = new InlineKeyboard().text("⬅️ Wanted Menu", "wanted:menu");
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(text, {
    parse_mode: "Markdown",
    reply_markup: kb,
  });
});
