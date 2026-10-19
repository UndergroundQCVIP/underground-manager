/**
 * LA CONFRÉRIE — Member Contributions UI (UG-04, extended in UG-05)
 *
 * Member flow: Contribute → existing creator OR new creator → send photos/videos → Finish.
 * Admin flow (cadm:*): queue → review → Approve & Reward / Approve Without Reward / Reject.
 */

import { Composer, Context, InlineKeyboard } from "grammy";
import { getClubName, isAdministrator } from "../../config.ts";
import { adminRouteGuard } from "../middleware/auth.ts";
import { creatorCollection, getCreator, listCreators } from "../../db/creators.ts";
import { getContribution, listContributions } from "../../db/contributions.ts";
import { peekAdminInput, requestAdminInput, takeAdminInput } from "../../db/admin_input.ts";
import { getSystemSettings, updateSystemSettings } from "../../db/settings.ts";
import {
  addContributionItem,
  adminUpdateProposal,
  approveContribution,
  cancelContribution,
  finishContribution,
  rejectContribution,
  resolvePartialPublication,
  retryContributionReward,
  setRewardDraft,
  startContribution,
  startNewCreatorContribution,
  submitProposalCollection,
  submitProposalName,
  submitProposalUrl,
  switchToExistingCreator,
} from "../../contributions/service.ts";
import { listContributionRewards, scopesLabel, fmtDay, validateRewardParams } from "../../contributions/rewards.ts";
import { contributionRewardsEnabled } from "../../membership/mode.ts";
import { getReferralOf } from "../../db/referrals.ts";
import { referralBonusDays } from "../../referrals/service.ts";
import { Contribution, ContributionStatus, CollectionCategory } from "../../types.ts";

export const contributeComposer = new Composer();

const PAGE = 8;
const mdEsc = (t: string) => t.replace(/([_*`\[])/g, "\\$1");

// ===========================================================================
// Member: entry point
// ===========================================================================

/** "➕ Contribuer": choose between an existing creator and a new one (menu or deep link). */
export async function contributeChooser(ctx: Context): Promise<void> {
  const kb = new InlineKeyboard()
    .text("👩‍🎤 Créateur existant", "contrib:existing")
    .row()
    .text("✨ Nouveau créateur", "contrib:new")
    .row()
    .text("⬅️ Menu principal", "member:home");
  const text =
    `➕ *CONTRIBUER À ${getClubName()}*\n\n` +
    `Tout le monde peut contribuer, même sans abonnement.\n` +
    `Un administrateur examine chaque envoi. Il décide s'il est publié, puis — séparément — s'il donne droit à du temps d'accès.\n\n` +
    `Pour quel créateur est votre contenu ?`;
  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: kb });
  } else {
    await ctx.reply(text, { parse_mode: "Markdown", reply_markup: kb });
  }
}

contributeComposer.callbackQuery("contrib:start", contributeChooser);

// ---- Existing creator (UG-04 flow, unchanged behaviour) ---------------------------------

async function showCreatorList(ctx: Context, page: number) {
  const creators = (await listCreators({ status: "active" })).filter((c) => !c.retiredAt);
  const slice = creators.slice(page * PAGE, page * PAGE + PAGE);
  const kb = new InlineKeyboard();
  for (const c of slice) {
    kb.text(`${c.name} (${creatorCollection(c) === "retro" ? "Retro" : "Regular"})`, `contrib:pick:${c.id}`).row();
  }
  if (page > 0) kb.text("◀️ Préc.", `contrib:list:${page - 1}`);
  if ((page + 1) * PAGE < creators.length) kb.text("Suiv. ▶️", `contrib:list:${page + 1}`);
  kb.row().text("✨ Nouveau créateur", "contrib:new").row().text("⬅️ Retour", "contrib:start");
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `👩‍🎤 *CRÉATEUR EXISTANT*\n\nChoisissez le créateur pour lequel vous contribuez.\n` +
    `_Tout ce que vous envoyez est examiné par un administrateur avant d'être publié._` +
    (creators.length === 0 ? `\n\nAucun créateur n'est disponible pour le moment.` : ""),
    { parse_mode: "Markdown", reply_markup: kb }
  );
}

contributeComposer.callbackQuery("contrib:existing", (ctx) => showCreatorList(ctx, 0));
contributeComposer.callbackQuery(/^contrib:list:(\d+)$/, (ctx) => showCreatorList(ctx, Number(ctx.match[1])));

const collectingKeyboard = () =>
  new InlineKeyboard().text("✅ Terminer", "contrib:finish").text("❌ Annuler", "contrib:cancel");

function mediaPrompt(name: string): string {
  return (
    `📤 *Contribution pour ${mdEsc(name)}*\n\n` +
    `Envoyez-moi maintenant les photos et vidéos (les albums sont acceptés). Quand vous avez terminé, appuyez sur *Terminer*.\n` +
    `Une fois approuvé, le robot les publie pour vous — vous n'apparaîtrez pas comme l'auteur de la publication.`
  );
}

contributeComposer.callbackQuery(/^contrib:pick:([\w-]+)$/, async (ctx) => {
  const res = await startContribution(ctx.from.id, ctx.match[1]);
  await ctx.answerCallbackQuery();
  if (!res.ok || !res.contribution) {
    await ctx.reply(`⚠️ ${res.error}`, { reply_markup: new InlineKeyboard().text("⬅️ Retour", "contrib:start") });
    return;
  }
  await ctx.reply(mediaPrompt(res.contribution.creatorName), { parse_mode: "Markdown", reply_markup: collectingKeyboard() });
});

// ---- New creator proposal ----------------------------------------------------------------

contributeComposer.callbackQuery("contrib:new", async (ctx) => {
  await startNewCreatorContribution(ctx.from.id);
  await ctx.answerCallbackQuery();
  await ctx.reply(
    `✨ *NOUVEAU CRÉATEUR*\n\nQuel est le *nom* du créateur ?\n_Répondez par un message texte. Rien n'est créé tant qu'un administrateur n'a pas approuvé._`,
    { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("❌ Annuler", "contrib:cancel") }
  );
});

const urlPrompt = () =>
  `🔗 Avez-vous un *lien public de profil* du créateur ? Envoyez-le en message, ou passez cette étape.`;

contributeComposer.on("message:text", async (ctx, next) => {
  if (ctx.chat.type !== "private" || ctx.message.text.startsWith("/")) return next();
  const userId = ctx.from.id;
  const text = ctx.message.text;

  // --- Administrator prompts (custom duration, proposal rename, rejection reason) ---
  if (isAdministrator(userId) && (await peekAdminInput(userId))) {
    const req = (await takeAdminInput(userId))!;
    if (req.type === "custom_days") {
      const days = Number(text.trim());
      const invalid = validateRewardParams(["regular"], days);
      if (invalid) {
        await requestAdminInput(userId, req);
        await ctx.reply(`⚠️ ${invalid.replace("Choisissez le ou les forums accessibles.", "")} Entrez un nombre de jours valide.`);
        return;
      }
      await setRewardDraft(req.contributionId, { days });
      await showRewardConfig(ctx, req.contributionId, true);
    } else if (req.type === "rename_proposal") {
      const res = await adminUpdateProposal(req.contributionId, { name: text });
      await ctx.reply(res.ok ? "✏️ Nom corrigé." : `⚠️ ${res.error}`);
      await showReview(ctx, req.contributionId, true);
    } else if (req.type === "reject_reason") {
      const res = await rejectContribution(ctx.api, req.contributionId, userId, text);
      await ctx.reply(res.ok ? "❌ Refusé. Le contributeur a été avisé." : `⚠️ ${res.error}`);
    }
    return;
  }

  // --- Contributor: new-creator proposal steps ---
  const { getActiveContribution } = await import("../../db/contributions.ts");
  const active = await getActiveContribution(userId);
  if (!active || active.kind !== "new") return next();

  if (active.step === "name") {
    const res = await submitProposalName(userId, text);
    if (!res.ok) {
      await ctx.reply(`⚠️ ${res.error}`);
      return;
    }
    if (res.duplicates && res.duplicates.length > 0) {
      const kb = new InlineKeyboard();
      res.duplicates.slice(0, 3).forEach((d, i) => {
        kb.text(`Utiliser « ${d.name} » (${creatorCollection(d) === "retro" ? "Retro" : "Regular"})`.slice(0, 60), `contrib:dupuse:${i}`).row();
      });
      kb.text("➡️ Continuer comme nouveau créateur", "contrib:dupgo");
      await ctx.reply(
        `⚠️ Des créateurs au nom semblable existent déjà : ${res.duplicates.slice(0, 3).map((d) => `*${mdEsc(d.name)}*`).join(", ")}.\n` +
        `Est-ce le même créateur ?`,
        { parse_mode: "Markdown", reply_markup: kb }
      );
      return;
    }
    await ctx.reply(urlPrompt(), {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard().text("⏭️ Passer", "contrib:urlskip").text("❌ Annuler", "contrib:cancel"),
    });
    return;
  }

  if (active.step === "url") {
    const res = await submitProposalUrl(userId, text);
    if (!res.ok) {
      await ctx.reply(`⚠️ ${res.error}`);
      return;
    }
    await askCollection(ctx);
    return;
  }
  return next();
});

async function askCollection(ctx: Context) {
  await ctx.reply(
    `📚 Ce créateur appartient à quelle collection ?\n_Un administrateur confirmera la classification._`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text("📖 Regular", "contrib:col:regular")
        .text("🎞️ Retro", "contrib:col:retro")
        .row()
        .text("❌ Annuler", "contrib:cancel"),
    }
  );
}

contributeComposer.callbackQuery("contrib:dupgo", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply(urlPrompt(), {
    parse_mode: "Markdown",
    reply_markup: new InlineKeyboard().text("⏭️ Passer", "contrib:urlskip").text("❌ Annuler", "contrib:cancel"),
  });
});

contributeComposer.callbackQuery(/^contrib:dupuse:(\d)$/, async (ctx) => {
  const { getActiveContribution } = await import("../../db/contributions.ts");
  const active = await getActiveContribution(ctx.from.id);
  const creatorId = active?.proposal?.duplicateCandidateIds[Number(ctx.match[1])];
  await ctx.answerCallbackQuery();
  if (!creatorId) return;
  const res = await switchToExistingCreator(ctx.from.id, creatorId);
  if (!res.ok || !res.contribution) {
    await ctx.reply(`⚠️ ${res.error}`);
    return;
  }
  await ctx.reply(mediaPrompt(res.contribution.creatorName), { parse_mode: "Markdown", reply_markup: collectingKeyboard() });
});

contributeComposer.callbackQuery("contrib:urlskip", async (ctx) => {
  const res = await submitProposalUrl(ctx.from.id, null);
  await ctx.answerCallbackQuery();
  if (!res.ok) {
    await ctx.reply(`⚠️ ${res.error}`);
    return;
  }
  await askCollection(ctx);
});

contributeComposer.callbackQuery(/^contrib:col:(regular|retro)$/, async (ctx) => {
  const res = await submitProposalCollection(ctx.from.id, ctx.match[1] as CollectionCategory);
  await ctx.answerCallbackQuery();
  if (!res.ok) {
    await ctx.reply(`⚠️ ${res.error}`);
    return;
  }
  const { getActiveContribution } = await import("../../db/contributions.ts");
  const c = await getActiveContribution(ctx.from.id);
  await ctx.reply(mediaPrompt(c?.creatorName ?? ""), { parse_mode: "Markdown", reply_markup: collectingKeyboard() });
});

// ---- Receive media ----------------------------------------------------------------------------

contributeComposer.on(["message:photo", "message:video"], async (ctx, next) => {
  if (ctx.chat.type !== "private") return next();
  const msg = ctx.message;
  const res = await addContributionItem(ctx.from.id, {
    messageId: msg.message_id,
    kind: msg.photo ? "photo" : "video",
    mediaGroupId: msg.media_group_id,
  });
  if (!res.contribution) return next(); // no open session (or details incomplete): ignore silently
  if (res.added && res.newAlbum) {
    await ctx.reply(`✔ Reçu (${res.count} jusqu'ici). Envoyez-en d'autres ou appuyez sur Terminer.`, {
      reply_markup: collectingKeyboard(),
    });
  }
});

contributeComposer.on("message", async (ctx, next) => {
  // Other message types during an open session: explain what is supported.
  if (ctx.chat.type === "private" && !ctx.message.text?.startsWith("/") && (ctx.message.document || ctx.message.animation || ctx.message.audio || ctx.message.voice)) {
    const { getActiveContribution } = await import("../../db/contributions.ts");
    if (await getActiveContribution(ctx.from.id)) {
      await ctx.reply("Seules les photos et les vidéos sont acceptées pour les contributions.");
      return;
    }
  }
  return next();
});

contributeComposer.callbackQuery("contrib:finish", async (ctx) => {
  const res = await finishContribution(ctx.api, ctx.from.id);
  await ctx.answerCallbackQuery();
  await ctx.reply(
    res.ok
      ? `✅ Merci ! Vos ${res.contribution!.items.length} élément(s) pour *${mdEsc(res.contribution!.creatorName)}* ont été envoyés pour examen. ` +
        `Vous recevrez un message lorsqu'un administrateur aura décidé. Une approbation n'accorde pas automatiquement du temps d'accès : c'est une décision distincte de l'administrateur.`
      : `⚠️ ${res.error}`,
    { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("⬅️ Menu principal", "member:home") }
  );
});

contributeComposer.callbackQuery("contrib:cancel", async (ctx) => {
  await cancelContribution(ctx.from.id);
  await ctx.answerCallbackQuery();
  await ctx.reply("Contribution annulée. Rien n'a été envoyé.", {
    reply_markup: new InlineKeyboard().text("⬅️ Menu principal", "member:home"),
  });
});

// ===========================================================================
// Administrator review (cadm:*)
// ===========================================================================

contributeComposer.use(adminRouteGuard({ callbackPrefixes: ["cadm:"], commands: [] }));

const STATUS_ICON: Record<ContributionStatus, string> = {
  collecting: "✍️", pending: "⏳", publishing: "🔄", approved: "✅", rejected: "❌",
  failed: "⚠️", needs_review: "🟠", cancelled: "⚫",
};

contributeComposer.callbackQuery("cadm:hub", async (ctx) => {
  const pending = (await listContributions("pending")).length + (await listContributions("needs_review")).length;
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(`📥 *CONTRIBUTIONS*\n\nÀ examiner : *${pending}*`, {
    parse_mode: "Markdown",
    reply_markup: new InlineKeyboard()
      .text(`⏳ En attente (${pending})`, "cadm:queue")
      .text("🗂 Historique", "cadm:hist:0")
      .row()
      .text("🎁 Récompenses", "cadm:rewards")
      .row()
      .text("⬅️ Menu administrateur", "admin:menu"),
  });
});

contributeComposer.callbackQuery("cadm:queue", async (ctx) => {
  const open = [
    ...(await listContributions("pending")),
    ...(await listContributions("needs_review")),
    ...(await listContributions("failed")),
  ];
  const kb = new InlineKeyboard();
  let text = `📥 *CONTRIBUTIONS À EXAMINER* (${open.length})\n\n`;
  if (open.length === 0) text += "_Rien à examiner._";
  for (const c of open.slice(0, 15)) {
    const tag = c.kind === "new" ? "✨ NOUVEAU " : "";
    text += `${STATUS_ICON[c.status]} ${tag}*${mdEsc(c.creatorName)}* — ${c.items.length} élément(s) de \`${c.userId}\`\n`;
    kb.text(`${STATUS_ICON[c.status]} ${c.creatorName} (${c.items.length})`.slice(0, 60), `cadm:view:${c.id}`).row();
  }
  kb.text("⬅️ Contributions", "cadm:hub");
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: kb });
});

contributeComposer.callbackQuery(/^cadm:hist:(\d+)$/, async (ctx) => {
  const page = Number(ctx.match[1]);
  const all = (await listContributions()).filter((c) => !["collecting", "cancelled"].includes(c.status)).reverse();
  const slice = all.slice(page * PAGE, page * PAGE + PAGE);
  let text = `🗂 *HISTORIQUE DES CONTRIBUTIONS* (page ${page + 1}/${Math.max(1, Math.ceil(all.length / PAGE))})\n\n`;
  const kb = new InlineKeyboard();
  if (slice.length === 0) text += "_Aucune contribution._";
  for (const c of slice) {
    const reward = c.rewardStatus === "granted" ? " 🎁" : "";
    text += `${STATUS_ICON[c.status]} *${mdEsc(c.creatorName)}* — \`${c.userId}\`${reward} (${c.itemCount ?? c.items.length})\n`;
    kb.text(`${STATUS_ICON[c.status]} ${c.creatorName}`.slice(0, 60), `cadm:view:${c.id}`).row();
  }
  if (page > 0) kb.text("◀️ Préc.", `cadm:hist:${page - 1}`);
  if ((page + 1) * PAGE < all.length) kb.text("Suiv. ▶️", `cadm:hist:${page + 1}`);
  kb.row().text("⬅️ Contributions", "cadm:hub");
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: kb });
});

contributeComposer.callbackQuery("cadm:rewards", async (ctx) => {
  const settings = await getSystemSettings();
  const rewards = await listContributionRewards(8);
  let text =
    `🎁 *RÉCOMPENSES*\n\n*Durée par défaut :* ${settings.contributionDefaultDays} jours\n` +
    `*Récompenses actives :* ${(await contributionRewardsEnabled()) ? "oui" : "non (mode Étoiles seulement)"}\n\n*Historique récent :*\n`;
  if (rewards.length === 0) text += "_Aucune récompense accordée._\n";
  for (const r of rewards) {
    const until = Object.entries(r.expiresAt).map(([s, d]) => `${s === "retro" ? "Retro" : "Regular"} → ${fmtDay(d!)}`).join(", ");
    text += `• \`${r.userId}\` — ${scopesLabel(r.scopes)} — ${r.days} j (${until})\n`;
  }
  const kb = new InlineKeyboard();
  for (const d of [7, 15, 30, 60, 90]) {
    kb.text(`${settings.contributionDefaultDays === d ? "• " : ""}${d} j`, `cadm:defdays:${d}`);
  }
  kb.row().text("⬅️ Contributions", "cadm:hub");
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: kb });
});

contributeComposer.callbackQuery(/^cadm:defdays:(\d+)$/, async (ctx) => {
  await updateSystemSettings({ contributionDefaultDays: Number(ctx.match[1]) });
  await ctx.answerCallbackQuery({ text: "Durée par défaut mise à jour." });
  await ctx.editMessageText(`✅ Durée de récompense par défaut : *${ctx.match[1]} jours*.`, {
    parse_mode: "Markdown",
    reply_markup: new InlineKeyboard().text("⬅️ Récompenses", "cadm:rewards"),
  });
});

// ---- Review screen ----------------------------------------------------------------------------

async function renderReview(c: Contribution): Promise<{ text: string; kb: InlineKeyboard }> {
  const kb = new InlineKeyboard();
  const isNew = c.kind === "new";
  let text =
    `📥 *Contribution* ${STATUS_ICON[c.status]} ${c.status.replace(/_/g, " ")}\n` +
    `*Contributeur :* \`${c.userId}\`\n*Éléments :* ${c.itemCount ?? c.items.length}\n` +
    ((await getReferralOf(c.userId)) ? `*Parrainé par :* \`${(await getReferralOf(c.userId))!.referrerId}\`\n` : "");

  if (isNew && c.proposal) {
    const p = c.proposal;
    text += `\n✨ *NOUVEAU CRÉATEUR PROPOSÉ*\n*Nom :* ${mdEsc(p.name)}\n*Collection :* ${p.collection === "retro" ? "Retro" : "Regular"}\n` +
      `*Lien :* ${p.profileUrl ?? "—"}\n`;
    if (p.useExistingCreatorId) {
      const ex = await getCreator(p.useExistingCreatorId);
      text += `🔗 *Utilisera le créateur existant :* ${mdEsc(ex?.name ?? "?")}\n`;
    } else if (p.duplicateCandidateIds.length) {
      const names: string[] = [];
      for (const id of p.duplicateCandidateIds.slice(0, 3)) names.push(mdEsc((await getCreator(id))?.name ?? "?"));
      text += `⚠️ *Doublon possible :* ${names.join(", ")}\n`;
    }
    text += `*Identité et droits :* ${p.identityRightsConfirmed ? "☑️ attestés" : "☐ non attestés"}\n`;
  } else {
    text += `*Créateur :* ${mdEsc(c.creatorName)}\n`;
  }
  if (c.rejectionReason) text += `*Raison du refus :* ${mdEsc(c.rejectionReason)}\n`;
  if (c.rewardStatus) text += `*Récompense :* ${c.rewardStatus === "granted" ? "accordée" : c.rewardStatus === "pending" ? "en attente" : "aucune"}\n`;
  if (c.note) text += `\n_${mdEsc(c.note)}_\n`;
  text +=
    `\n*À vérifier :* qualité et pertinence, doublons, bon créateur, droits de publication et de diffusion, âge et consentement.`;

  const open = c.status === "pending" || c.status === "failed";
  if (open && isNew && c.proposal) {
    kb.text("✏️ Corriger le nom", `cadm:ren:${c.id}`).text(`🔁 ${c.proposal.collection === "retro" ? "→ Regular" : "→ Retro"}`, `cadm:col:${c.id}`).row();
    c.proposal.duplicateCandidateIds.slice(0, 3).forEach((_, i) => kb.text(`🔗 Utiliser le doublon ${i + 1}`, `cadm:dup:${c.id}:${i}`).row());
    if (c.proposal.useExistingCreatorId) kb.text("↩️ Ne pas utiliser le doublon", `cadm:dup:${c.id}:x`).row();
    kb.text(c.proposal.identityRightsConfirmed ? "☑️ Identité et droits attestés" : "☐ J'atteste l'identité et les droits", `cadm:rt:${c.id}`).row();
  }
  if (open) {
    kb.text("🎁 Approuver et récompenser", `cadm:rw:${c.id}`).row();
    kb.text("✅ Approuver sans récompense", `cadm:nr:${c.id}`).row();
    kb.text("❌ Refuser", `cadm:no:${c.id}`).row();
  }
  if (c.status === "needs_review") kb.text("✅ J'ai vérifié le sujet — accepter tel quel", `cadm:res:${c.id}`).row();
  if (c.status === "approved" && c.rewardStatus === "pending") kb.text("🔁 Réessayer la récompense", `cadm:rr:${c.id}`).row();
  if (open || c.status === "needs_review") kb.text("👁 Revoir l'aperçu", `cadm:pv:${c.id}`).row();
  kb.text("⬅️ File d'attente", "cadm:queue");
  return { text, kb };
}

async function showReview(ctx: Context, id: string, asNewMessage = false) {
  const c = await getContribution(id);
  if (!c) {
    await ctx.reply("Contribution introuvable.");
    return;
  }
  const { text, kb } = await renderReview(c);
  if (asNewMessage || !ctx.callbackQuery) await ctx.reply(text, { parse_mode: "Markdown", reply_markup: kb });
  else await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: kb });
}

contributeComposer.callbackQuery(/^cadm:view:([\w-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await showReview(ctx, ctx.match[1]);
});

contributeComposer.callbackQuery(/^cadm:pv:([\w-]+)$/, async (ctx) => {
  const c = await getContribution(ctx.match[1]);
  await ctx.answerCallbackQuery();
  if (!c || c.items.length === 0) return;
  try {
    await ctx.api.copyMessages(ctx.from.id, c.userId, c.items.map((i) => i.messageId).sort((a, b) => a - b));
  } catch {
    await ctx.reply("⚠️ Aperçu indisponible (le membre a peut-être supprimé les originaux).");
  }
});

contributeComposer.callbackQuery(/^cadm:ren:([\w-]+)$/, async (ctx) => {
  await requestAdminInput(ctx.from.id, { type: "rename_proposal", contributionId: ctx.match[1] });
  await ctx.answerCallbackQuery();
  await ctx.reply("✏️ Envoyez le nom corrigé du créateur (message texte).");
});

contributeComposer.callbackQuery(/^cadm:col:([\w-]+)$/, async (ctx) => {
  const c = await getContribution(ctx.match[1]);
  if (c?.proposal) {
    await adminUpdateProposal(c.id, { collection: c.proposal.collection === "retro" ? "regular" : "retro" });
  }
  await ctx.answerCallbackQuery();
  await showReview(ctx, ctx.match[1]);
});

contributeComposer.callbackQuery(/^cadm:dup:([\w-]+):(\d|x)$/, async (ctx) => {
  const c = await getContribution(ctx.match[1]);
  if (c?.proposal) {
    const pick = ctx.match[2] === "x" ? null : c.proposal.duplicateCandidateIds[Number(ctx.match[2])] ?? null;
    await adminUpdateProposal(c.id, { useExistingCreatorId: pick });
  }
  await ctx.answerCallbackQuery();
  await showReview(ctx, ctx.match[1]);
});

contributeComposer.callbackQuery(/^cadm:rt:([\w-]+)$/, async (ctx) => {
  const c = await getContribution(ctx.match[1]);
  if (c?.proposal) await adminUpdateProposal(c.id, { identityRightsConfirmed: !c.proposal.identityRightsConfirmed });
  await ctx.answerCallbackQuery();
  await showReview(ctx, ctx.match[1]);
});

// ---- Reject (optional reason) ----------------------------------------------------------------

contributeComposer.callbackQuery(/^cadm:no:([\w-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply("❌ *Refuser cette contribution ?* Aucun contenu ne sera publié et aucune récompense accordée.", {
    parse_mode: "Markdown",
    reply_markup: new InlineKeyboard()
      .text("Refuser", `cadm:nox:${ctx.match[1]}`)
      .text("Refuser avec une raison…", `cadm:nor:${ctx.match[1]}`)
      .row()
      .text("↩️ Retour", `cadm:view:${ctx.match[1]}`),
  });
});

contributeComposer.callbackQuery(/^cadm:nox:([\w-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const res = await rejectContribution(ctx.api, ctx.match[1], ctx.from.id);
  await ctx.reply(res.ok ? "❌ Refusé. Le contributeur a été avisé." : `⚠️ ${res.error}`);
});

contributeComposer.callbackQuery(/^cadm:nor:([\w-]+)$/, async (ctx) => {
  await requestAdminInput(ctx.from.id, { type: "reject_reason", contributionId: ctx.match[1] });
  await ctx.answerCallbackQuery();
  await ctx.reply("Envoyez la raison du refus (message texte, visible par le contributeur).");
});

// ---- Approve without reward ---------------------------------------------------------------------

async function runApproval(ctx: Context, id: string, decision: Parameters<typeof approveContribution>[3]) {
  const res = await approveContribution(ctx.api, id, ctx.from!.id, decision);
  if (res.ok) {
    await ctx.reply(
      `✅ ${res.published} élément(s) publié(s).` +
      (decision?.type === "reward" ? (res.rewardError ? `\n⚠️ ${res.rewardError}` : `\n🎁 Récompense accordée.`) : `\nAucune récompense accordée.`)
    );
  } else {
    await ctx.reply(`⚠️ ${res.error}`);
  }
}

// "cadm:ok" is the UG-04 button still present on older review messages.
contributeComposer.callbackQuery(/^cadm:(?:nr|ok):([\w-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Publication..." });
  await runApproval(ctx, ctx.match[1], { type: "no_reward" });
});

// ---- Approve & reward: configuration screen --------------------------------------------------

const SCOPE_CODE: Record<string, CollectionCategory[]> = { rg: ["regular"], rt: ["retro"], bo: ["regular", "retro"] };

async function showRewardConfig(ctx: Context, id: string, asNewMessage = false) {
  const c = await getContribution(id);
  if (!c) return;
  const settings = await getSystemSettings();
  const scopes = c.draft?.scopes ?? [];
  const days = c.draft?.days ?? settings.contributionDefaultDays;
  const referrer = await getReferralOf(c.userId);
  const setKey = scopes.length === 2 ? "bo" : scopes[0] === "retro" ? "rt" : scopes[0] === "regular" ? "rg" : "";
  const mark = (on: boolean, label: string) => (on ? `• ${label}` : label);

  const kb = new InlineKeyboard()
    .text(mark(setKey === "rg", "Regular seulement"), `cadm:sc:${id}:rg`)
    .text(mark(setKey === "rt", "Retro seulement"), `cadm:sc:${id}:rt`)
    .text(mark(setKey === "bo", "Les deux"), `cadm:sc:${id}:bo`)
    .row();
  for (const d of [7, 15, 30]) kb.text(mark(days === d, `${d} jours`), `cadm:du:${id}:${d}`);
  kb.row();
  for (const d of [60, 90]) kb.text(mark(days === d, `${d} jours`), `cadm:du:${id}:${d}`);
  const custom = ![7, 15, 30, 60, 90].includes(days);
  kb.text(mark(custom, custom ? `${days} jours (perso.)` : "Personnalisé…"), `cadm:duc:${id}`).row();
  if (scopes.length > 0) kb.text("✅ Confirmer l'approbation", `cadm:cf:${id}`).row();
  kb.text("↩️ Retour", `cadm:view:${id}`);

  const text =
    `🎁 *APPROUVER ET RÉCOMPENSER*\n\n` +
    `*Contributeur :* \`${c.userId}\`\n*Créateur :* ${mdEsc(c.creatorName)}${c.kind === "new" ? " _(nouveau)_" : ""}\n` +
    `*Envoi :* ${c.items.length} élément(s)\n\n` +
    `*Accès :* ${scopes.length ? scopesLabel(scopes) : "_à choisir — aucun accès Retro n'est accordé automatiquement_"}\n` +
    `*Durée :* ${days} jours\n\n` +
    (referrer
      ? `🤝 *Parrain :* \`${referrer.referrerId}\` recevra *+${referralBonusDays(days)} jour${referralBonusDays(days) > 1 ? "s" : ""}* ` +
        `(50 %, arrondi vers le haut) pour les mêmes forums.\n\n`
      : "") +
    `Les jours s'ajoutent au temps déjà gagné pour chaque forum, sans jamais raccourcir un autre droit. ` +
    `La récompense n'est accordée qu'après la publication réussie du contenu.`;
  if (asNewMessage || !ctx.callbackQuery) await ctx.reply(text, { parse_mode: "Markdown", reply_markup: kb });
  else await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: kb });
}

contributeComposer.callbackQuery(/^cadm:rw:([\w-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await contributionRewardsEnabled())) {
    await ctx.reply("⚠️ Les récompenses par contribution sont désactivées dans le mode d'adhésion actuel (Étoiles seulement).");
    return;
  }
  await showRewardConfig(ctx, ctx.match[1]);
});

contributeComposer.callbackQuery(/^cadm:sc:([\w-]+):(rg|rt|bo)$/, async (ctx) => {
  await setRewardDraft(ctx.match[1], { scopes: SCOPE_CODE[ctx.match[2]] });
  await ctx.answerCallbackQuery();
  await showRewardConfig(ctx, ctx.match[1]);
});

contributeComposer.callbackQuery(/^cadm:du:([\w-]+):(\d+)$/, async (ctx) => {
  await setRewardDraft(ctx.match[1], { days: Number(ctx.match[2]) });
  await ctx.answerCallbackQuery();
  await showRewardConfig(ctx, ctx.match[1]);
});

contributeComposer.callbackQuery(/^cadm:duc:([\w-]+)$/, async (ctx) => {
  await requestAdminInput(ctx.from.id, { type: "custom_days", contributionId: ctx.match[1] });
  await ctx.answerCallbackQuery();
  await ctx.reply("🔢 Envoyez le nombre de jours (entier, 1 à 3650).");
});

contributeComposer.callbackQuery(/^cadm:cf:([\w-]+)$/, async (ctx) => {
  const c = await getContribution(ctx.match[1]);
  await ctx.answerCallbackQuery({ text: "Publication..." });
  if (!c?.draft || c.draft.scopes.length === 0) {
    await ctx.reply("⚠️ Choisissez d'abord le ou les forums accessibles.");
    return;
  }
  await runApproval(ctx, c.id, { type: "reward", scopes: c.draft.scopes, days: c.draft.days });
});

contributeComposer.callbackQuery(/^cadm:res:([\w-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const res = await resolvePartialPublication(ctx.api, ctx.match[1], ctx.from.id);
  await ctx.reply(res.ok ? `✅ Contribution acceptée.${res.rewardError ? `\n⚠️ ${res.rewardError}` : ""}` : `⚠️ ${res.error}`);
});

contributeComposer.callbackQuery(/^cadm:rr:([\w-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const res = await retryContributionReward(ctx.api, ctx.match[1], ctx.from.id);
  await ctx.reply(res.ok ? "🎁 Récompense appliquée." : `⚠️ ${res.error}`);
});
