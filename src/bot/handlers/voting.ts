/**
 * LA CONFRÉRIE — Member Acquisition Voting Handlers
 */

import { getClubName } from "../../config.ts";
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
      `🔒 *VOTE MENSUEL DES CRÉATEURS*\n\n` +
      `Le vote d'acquisition de créateurs est un avantage exclusif réservé aux abonnés payants actifs.\n\n` +
      `Abonnez-vous avec les Étoiles Telegram ci-dessous pour participer au choix de nos prochains créateurs :`;

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
      `🗳️ *AUCUN TOUR DE VOTE ACTIF*\n\n` +
      `Aucun vote d'acquisition n'est en cours actuellement.\n\n` +
      `Les votes mensuels pour les créateurs s'ouvrent après les suggestions de la communauté dans la Liste de souhaits. Revenez bientôt!`;

    const kb = new InlineKeyboard()
      .text("🎯 Voir la Liste de souhaits", "wanted:view")
      .row()
      .text("⬅️ Menu principal", "member:home");

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
      `✅ *VOTE DÉJÀ ENREGISTRÉ*\n\n` +
      `Vous avez déjà voté dans *${escapeMd(ballot.title)}*.\n\n` +
      `🔒 Conformément aux règles de vote de ${getClubName()}, les votes sont définitifs, non modifiables et confidentiels.\n` +
      `📅 Les résultats seront annoncés le *${closesDate}*.`;

    const kb = new InlineKeyboard()
      .text("🎯 Liste de souhaits", "wanted:view")
      .row()
      .text("⬅️ Menu principal", "member:home");

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
    kb.text(`🗳️ Voter pour ${c.creatorName}`, `vote:sel:${ballot.id}:${c.candidateId}`).row();
  }
  kb.text("⬅️ Menu principal", "member:home");

  const closesDate = formatTorontoDate(ballot.closesAt, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const text =
    `🗳️ *${escapeMd(ballot.title)}*\n\n` +
    `Quel créateur ${getClubName()} devrait-il acquérir ensuite?\n\n` +
    `⏳ *Clôture du vote :* ${closesDate}\n` +
    `⚠️ *Règles :* 1 vote irrévocable par membre payant. L'ordre des candidats est aléatoire.\n\n` +
    `Faites votre choix ci-dessous :`;

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
    await ctx.answerCallbackQuery({ text: "Scrutin introuvable." });
    return;
  }

  const candidate = ballot.candidates.find((c) => c.candidateId === candidateId);
  if (!candidate) {
    await ctx.answerCallbackQuery({ text: "Candidat introuvable." });
    return;
  }

  const kb = new InlineKeyboard()
    .text(`✅ Confirmer le vote : ${candidate.creatorName}`, `vote:exec:${ballotId}:${candidateId}`)
    .row()
    .text("❌ Annuler / en choisir un autre", "vote:open");

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `🗳️ *CONFIRMEZ VOTRE VOTE D'ACQUISITION*\n\n` +
    `Voulez-vous vraiment voter pour *${escapeMd(candidate.creatorName)}*?\n\n` +
    `⚠️ _Une fois confirmé, votre vote est enregistré de façon atomique et ne peut être retiré ni modifié._`,
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
      text: result.error ?? "Échec de l'enregistrement du vote.",
      show_alert: true,
    });
    return;
  }

  await ctx.answerCallbackQuery({ text: "Vote enregistré!" });
  await ctx.editMessageText(
    `🎉 *VOTE ENREGISTRÉ AVEC SUCCÈS!*\n\n` +
    `Votre vote a été enregistré de façon sécurisée et confidentielle.\n\n` +
    `Les résultats finaux et les décisions d'acquisition seront annoncés dans le canal de la Liste de souhaits à la fermeture du vote.\n\n` +
    `Merci de façonner les collections de ${getClubName()}!`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text("🎯 Voir la Liste de souhaits", "wanted:view")
        .row()
        .text("⬅️ Menu principal", "member:home"),
    }
  );
});
