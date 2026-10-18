/**
 * Underground Manager — Member Acquisition Voting Handlers
 */

import { Composer, InlineKeyboard } from "grammy";
import { formatTorontoDate } from "../../util/time.ts";
import { escapeMd } from "../../util/markdown.ts";
import { getActiveBallot, getBallot, hasUserVoted } from "../../db/voting.ts";
import { getMembershipSummary } from "../../db/entitlements.ts";
import { castVote } from "../../voting/service.ts";
import { subscribeKeyboard } from "../keyboards.ts";

export const votingComposer = new Composer();

function shuffleArray<T>(array: T[]): T[] {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// Handler for opening current vote
export async function handleOpenVote(ctx: any) {
  const userId = ctx.from?.id;
  if (!userId) return;

  const summary = await getMembershipSummary(userId);

  // 1. Eligibility Check
  if (!summary.hasPaid) {
    const text =
      `🔒 *MONTHLY CREATOR VOTING*\n\n` +
      `Creator acquisition voting is an exclusive benefit reserved for active paying subscribers.\n\n` +
      `Subscribe with Telegram Stars below to participate in choosing our next creator additions:`;

    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(text, {
        parse_mode: "Markdown",
        reply_markup: subscribeKeyboard(),
      });
    } else {
      await ctx.reply(text, {
        parse_mode: "Markdown",
        reply_markup: subscribeKeyboard(),
      });
    }
    return;
  }

  // 2. Check for active ballot
  const ballot = await getActiveBallot();
  if (!ballot) {
    const text =
      `🗳️ *NO ACTIVE VOTING ROUND*\n\n` +
      `There is currently no active acquisition vote in progress.\n\n` +
      `Monthly creator votes open after community nominations on the Wanted List. Check back soon!`;

    const kb = new InlineKeyboard()
      .text("🎯 View Wanted List", "wanted:view")
      .row()
      .text("⬅️ Main Menu", "member:home");

    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(text, {
        parse_mode: "Markdown",
        reply_markup: kb,
      });
    } else {
      await ctx.reply(text, {
        parse_mode: "Markdown",
        reply_markup: kb,
      });
    }
    return;
  }

  // 3. Check if user already voted
  const alreadyVoted = await hasUserVoted(ballot.id, userId);
  if (alreadyVoted) {
    const closesDate = formatTorontoDate(ballot.closesAt, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

    const text =
      `✅ *VOTE ALREADY RECORDED*\n\n` +
      `You have already cast your vote in *${escapeMd(ballot.title)}*.\n\n` +
      `🔒 In accordance with Underground voting rules, votes are final, unchangeable, and confidential.\n` +
      `📅 Results will be announced on *${closesDate}*.`;

    const kb = new InlineKeyboard()
      .text("🎯 Wanted List", "wanted:view")
      .row()
      .text("⬅️ Main Menu", "member:home");

    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(text, {
        parse_mode: "Markdown",
        reply_markup: kb,
      });
    } else {
      await ctx.reply(text, {
        parse_mode: "Markdown",
        reply_markup: kb,
      });
    }
    return;
  }

  // 4. Render candidate choices in randomized order
  const shuffled = shuffleArray(ballot.candidates);
  const kb = new InlineKeyboard();

  for (const c of shuffled) {
    kb.text(`🗳️ Vote for ${c.creatorName}`, `vote:sel:${ballot.id}:${c.candidateId}`).row();
  }
  kb.text("⬅️ Main Menu", "member:home");

  const closesDate = formatTorontoDate(ballot.closesAt, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const text =
    `🗳️ *${escapeMd(ballot.title)}*\n\n` +
    `Which creator should Underground acquire next?\n\n` +
    `⏳ *Voting Closes:* ${closesDate}\n` +
    `⚠️ *Rules:* 1 irrevocable vote per paid member. Candidate order is randomized.\n\n` +
    `Select your choice below:`;

  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(text, {
      parse_mode: "Markdown",
      reply_markup: kb,
    });
  } else {
    await ctx.reply(text, {
      parse_mode: "Markdown",
      reply_markup: kb,
    });
  }
}

votingComposer.command("vote", handleOpenVote);
votingComposer.callbackQuery("vote:open", handleOpenVote);

// Candidate Selection -> Confirmation Screen
votingComposer.callbackQuery(/^vote:sel:([a-f0-9-]+):([a-f0-9-]+)$/, async (ctx) => {
  const ballotId = ctx.match[1];
  const candidateId = ctx.match[2];

  const ballot = await getBallot(ballotId);
  if (!ballot) {
    await ctx.answerCallbackQuery({ text: "Ballot not found." });
    return;
  }

  const candidate = ballot.candidates.find((c) => c.candidateId === candidateId);
  if (!candidate) {
    await ctx.answerCallbackQuery({ text: "Candidate not found." });
    return;
  }

  const kb = new InlineKeyboard()
    .text(`✅ Confirm Vote: ${candidate.creatorName}`, `vote:exec:${ballotId}:${candidateId}`)
    .row()
    .text("❌ Cancel / Pick Another", "vote:open");

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `🗳️ *CONFIRM YOUR ACQUISITION VOTE*\n\n` +
    `Are you sure you want to cast your vote for *${escapeMd(candidate.creatorName)}*?\n\n` +
    `⚠️ _Once confirmed, your vote is recorded atomically and cannot be withdrawn or changed._`,
    {
      parse_mode: "Markdown",
      reply_markup: kb,
    }
  );
});

// Final Vote Confirmation Execution
votingComposer.callbackQuery(/^vote:exec:([a-f0-9-]+):([a-f0-9-]+)$/, async (ctx) => {
  const userId = ctx.from?.id;
  const ballotId = ctx.match[1];
  const candidateId = ctx.match[2];

  if (!userId) return;

  const result = await castVote({ userId, ballotId, candidateId });
  if (!result.success) {
    await ctx.answerCallbackQuery({
      text: result.error ?? "Failed to record vote.",
      show_alert: true,
    });
    return;
  }

  await ctx.answerCallbackQuery({ text: "Vote recorded!" });
  await ctx.editMessageText(
    `🎉 *VOTE SUCCESSFULLY RECORDED!*\n\n` +
    `Your vote has been securely and privately registered.\n\n` +
    `Final results and acquisition decisions will be announced in the Wanted List channel when the voting window closes.\n\n` +
    `Thank you for shaping the Underground collections!`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text("🎯 View Wanted List", "wanted:view")
        .row()
        .text("⬅️ Main Menu", "member:home"),
    }
  );
});
