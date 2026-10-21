/**
 * LA CONFRÉRIE — Member Wanted List Handlers
 */

import { getClubName } from "../../config.ts";
import { Composer, InlineKeyboard } from "grammy";
import { escapeMd } from "../../util/markdown.ts";
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
    .text("📋 Voir les créateurs souhaités", "wanted:view")
    .text("💡 Suggérer un créateur", "wanted:suggest_prompt")
    .row()
    .text("👍 Appuyer un créateur", "wanted:support_list");

  if (hasActiveVote) {
    kb.text("🗳️ Vote en cours", "vote:open").row();
  } else {
    kb.row();
  }

  kb.text("📊 Résultats précédents", "wanted:results")
    .row()
    .text("🔎 Liste recherchée des administrateurs", "wreq:menu")
    .row()
    .text("⬅️ Menu principal", "member:home");

  return kb;
}

// Open Wanted Menu
wantedComposer.callbackQuery("wanted:menu", async (ctx) => {
  const activeBallot = await getActiveBallot();
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `🎯 *${getClubName()} | LISTE DE SOUHAITS*\n\n` +
    `Dites-nous quels créateurs nous devrions acquérir ensuite!\n\n` +
    `• *Suggérer :* soumettez de nouvelles demandes de créateurs\n` +
    `• *Appuyer :* appuyez les suggestions existantes de la communauté\n` +
    `• *Règles :* 1 suggestion ou appui par membre actif par cycle mensuel\n\n` +
    `Choisissez une option ci-dessous :`,
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

  let text = `🎯 *CRÉATEURS ACTUELLEMENT SOUHAITÉS*\n\n`;

  if (active.length === 0) {
    text += `_Aucune demande active dans la Liste de souhaits pour le moment._\n`;
  } else {
    active.slice(0, 15).forEach((c, idx) => {
      const statusLabel = WANTED_STATUS_LABELS[c.status] || c.status;
      const countLabel = c.supportCount === 1 ? "1 appui" : `${c.supportCount} appuis`;
      text += `${idx + 1}. *${escapeMd(c.name)}* — ${countLabel} \`[${statusLabel}]\`\n`;
    });
  }

  const kb = new InlineKeyboard()
    .text("👍 Appuyer un créateur", "wanted:support_list")
    .text("💡 Suggérer un créateur", "wanted:suggest_prompt")
    .row()
    .text("⬅️ Menu des souhaits", "wanted:menu");

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
  if (!summary.canParticipate) {
    await ctx.answerCallbackQuery({
      text: "Le vote et les suggestions sont réservés aux abonnés payants et aux membres ayant gagné leur accès par contribution.",
      show_alert: true,
    });
    return;
  }

  const cycleId = getCurrentMonthCycle();
  const existingSupport = await getUserSupportForCycle(cycleId, userId);
  if (existingSupport) {
    await ctx.answerCallbackQuery({
      text: "Vous avez déjà utilisé votre suggestion ou votre appui pour ce mois-ci.",
      show_alert: true,
    });
    return;
  }

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `💡 *SUGGÉRER UN CRÉATEUR À ACQUÉRIR*\n\n` +
    `Pour soumettre une suggestion, envoyez la commande :\n\n` +
    `\`/suggest <Nom du créateur> [URL du profil facultative]\`\n\n` +
    `*Exemples :*\n` +
    `• \`/suggest Ashley\`\n` +
    `• \`/suggest Nicole https://onlyfans.com/...\`\n\n` +
    `⚠️ _Votre suggestion compte automatiquement comme votre appui du mois._`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard().text("⬅️ Menu des souhaits", "wanted:menu"),
    }
  );
});

// /suggest command
wantedComposer.command("suggest", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const text = ctx.match?.trim();
  if (!text) {
    await ctx.reply("Utilisation : `/suggest <Nom du créateur> [lien du profil]`", {
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
    await ctx.reply(`⚠️ ${result.error ?? "Impossible d'enregistrer la suggestion."}`, {
      reply_markup: new InlineKeyboard().text("⬅️ Menu des souhaits", "wanted:menu"),
    });
    return;
  }

  if (result.isExistingCandidate) {
    await ctx.reply(
      `✅ *${escapeMd(result.candidate.name)}* figure déjà dans la Liste de souhaits!\n\n` +
      `Votre appui a été ajouté. Appuis actuels : *${result.candidate.supportCount}*.\n\n` +
      `Merci de nous aider à bâtir ${getClubName()}!`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("🎯 Voir la Liste de souhaits", "wanted:view"),
      }
    );
  } else {
    await ctx.reply(
      `🎉 *Suggestion soumise!*\n\n` +
      `*${escapeMd(result.candidate.name)}* a été ajouté à la Liste de souhaits avec 1 appui.\n\n` +
      `La communauté peut maintenant appuyer ce créateur pour les prochains tours de vote.`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("🎯 Voir la Liste de souhaits", "wanted:view"),
      }
    );
  }
});

// Support Existing Creator List
wantedComposer.callbackQuery("wanted:support_list", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const summary = await getMembershipSummary(userId);
  if (!summary.canParticipate) {
    await ctx.answerCallbackQuery({
      text: "Seuls les abonnés payants actifs ou les membres ayant gagné leur accès par contribution peuvent appuyer des créateurs.",
      show_alert: true,
    });
    return;
  }

  const cycleId = getCurrentMonthCycle();
  const existingSupport = await getUserSupportForCycle(cycleId, userId);
  if (existingSupport) {
    await ctx.answerCallbackQuery({
      text: "Vous avez déjà utilisé votre appui pour ce mois-ci.",
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
  kb.text("⬅️ Menu des souhaits", "wanted:menu");

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `👍 *APPUYER UN CRÉATEUR DE LA LISTE DE SOUHAITS*\n\n` +
    `Choisissez un créateur ci-dessous pour lui accorder votre appui mensuel :`,
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
    await ctx.answerCallbackQuery({ text: "Candidat introuvable." });
    return;
  }

  const kb = new InlineKeyboard()
    .text(`✅ Confirmer l'appui : ${candidate.name}`, `wanted:sup_exec:${candidate.id}`)
    .row()
    .text("❌ Annuler", "wanted:menu");

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `👍 *CONFIRMEZ VOTRE APPUI*\n\n` +
    `Voulez-vous vraiment appuyer *${escapeMd(candidate.name)}*?\n\n` +
    `⚠️ _Une fois confirmé, votre appui pour ce mois-ci est définitif et ne peut être retiré ni modifié._`,
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
      text: result.error ?? "Impossible d'enregistrer l'appui.",
      show_alert: true,
    });
    return;
  }

  await ctx.answerCallbackQuery({ text: "Appui enregistré!" });
  await ctx.editMessageText(
    `✅ *APPUI CONFIRMÉ!*\n\n` +
    `Vous avez appuyé *${escapeMd(result.candidate.name)}*.\n` +
    `Total des appuis : *${result.candidate.supportCount}*.\n\n` +
    `Merci de contribuer aux acquisitions de ${getClubName()}!`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard().text("🎯 Voir la Liste de souhaits", "wanted:view"),
    }
  );
});

// Previous Voting Results
wantedComposer.callbackQuery("wanted:results", async (ctx) => {
  const past = await listPastBallots(5);

  let text = `📊 *RÉSULTATS DES VOTES PRÉCÉDENTS*\n\n`;
  if (past.length === 0) {
    text += `_Aucun scrutin terminé pour le moment._\n`;
  } else {
    for (const b of past) {
      const winnerCandidate = b.winnerCandidateId
        ? b.candidates.find((c) => c.candidateId === b.winnerCandidateId)
        : undefined;
      const winnerName = winnerCandidate ? winnerCandidate.creatorName : (b.isTie ? "Égalité / second tour" : "Clos");
      text += `• *${escapeMd(b.title)}*\n  Gagnant : *${escapeMd(winnerName)}* | Votes : ${b.totalVotesCount ?? 0}\n`;
    }
  }

  const kb = new InlineKeyboard().text("⬅️ Menu des souhaits", "wanted:menu");
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(text, {
    parse_mode: "Markdown",
    reply_markup: kb,
  });
});
