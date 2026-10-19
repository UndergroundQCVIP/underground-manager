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
  prepared: "🟡 Préparée (essai à blanc — rien de copié)",
  blocked: "🔴 Bloquée",
  copying: "🔵 Copie en cours",
  paused: "⏸ En pause",
  needs_review: "🟠 À examiner",
  ready_to_finalize: "🟢 Vérifiée — en attente de votre approbation",
  finalized: "✅ Finalisée (l'ancien sujet Regular existe toujours)",
  source_deleted: "🗑 Terminée — ancien sujet supprimé",
  cancelled: "⚫ Annulée",
};

export const PROTECTED_CONTENT_ALTERNATIVE =
  `*Solution de rechange : republication contrôlée par un administrateur*\n` +
  `L'option « Restreindre l'enregistrement du contenu » de Telegram interdit la copie de ces médias, et le robot ne la contournera ni ne la désactivera.\n` +
  `1. Rassemblez les médias du créateur à partir de vos fichiers sources autorisés.\n` +
  `2. Créez le sujet du créateur dans RETRO | {club} et téléversez les fichiers vous-même.\n` +
  `3. Associez-le à la fiche existante du créateur (même identifiant interne, aucun doublon) :\n` +
  `   \`/relink_creator <nom du créateur> <id du sujet retro>\``;

function mdSafe(t: string): string {
  return t.replace(/([_*`\[])/g, "\\$1");
}

async function renderJob(job: MigrationJob): Promise<{ text: string; kb: InlineKeyboard }> {
  const items = await listMigrationItems(job.id);
  const t = job.totals;
  const kb = new InlineKeyboard();

  let text =
    `🚚 *MIGRATION — ${mdSafe(job.creatorName)}*\n` +
    `*Statut :* ${STATUS_LABEL[job.status]}\n\n` +
    `*Source :* forum Regular \`${job.source.chatId}\` / sujet \`${job.source.topicId}\`\n` +
    `*Destination :* RETRO | ${getClubName()} \`${job.destination.chatId}\` / sujet ${job.destination.topicId ? `\`${job.destination.topicId}\`` : "_pas encore créé_"}\n\n` +
    `*Inventaire :* ${t.items} message(s), ${t.albums} album(s)\n` +
    `✔ copiés ${t.copied} · ⏳ en attente ${t.pending} · ✖ échoués ${t.failed} · ❓ ambigus ${t.ambiguous} · 🚫 exclus ${t.excluded}\n`;

  if (job.status === "prepared") {
    text += `\n*Essai à blanc :* ${estimateBatches(items)} lot(s) seraient copiés. Aucun contenu Telegram n'a été modifié.\n`;
  }

  if (job.preflight && job.preflight.blockers.length) {
    text += `\n*Blocages :*\n` + job.preflight.blockers.map((b) => `• ${mdSafe(b.detail)}`).join("\n") + "\n";
  }
  if (job.preflight?.warnings.length) {
    text += `\n*Avertissements :*\n` + job.preflight.warnings.map((w) => `• ${mdSafe(w)}`).join("\n") + "\n";
  }
  if (job.blockedReason === "protected_content") {
    text += `\n${PROTECTED_CONTENT_ALTERNATIVE.replace("{club}", getClubName())}\n`;
  }
  if (job.notes.length) {
    text += `\n*Notes :*\n` + job.notes.slice(-4).map((n) => `• ${mdSafe(n).slice(0, 300)}`).join("\n") + "\n";
  }
  if (["prepared", "copying", "paused", "needs_review", "ready_to_finalize"].includes(job.status)) {
    text +=
      `\n⚠️ _Tant que l'ancien sujet Regular n'est pas supprimé, les membres Regular peuvent encore ouvrir la collection d'origine — l'accès exclusif Retro n'est pas encore atteint._`;
  }

  switch (job.status) {
    case "prepared":
      kb.text("▶️ Lancer la copie", `mig:start:${job.id}`).row();
      break;
    case "blocked":
      kb.text("🔄 Revérifier", `mig:start:${job.id}`).row();
      break;
    case "copying":
      kb.text("⏩ Copier les prochains lots", `mig:run:${job.id}`).text("⏸ Pause", `mig:pause:${job.id}`).row();
      break;
    case "paused":
      kb.text("▶️ Reprendre", `mig:start:${job.id}`).row();
      break;
    case "needs_review":
      kb.text("🔁 Réessayer les échecs", `mig:start:${job.id}`).text("🔍 Revérifier", `mig:verify:${job.id}`).row();
      if (t.failed + t.ambiguous > 0) kb.text("🚫 Exclure les éléments non résolus…", `mig:excl:${job.id}`).row();
      break;
    case "ready_to_finalize":
      kb.text("✅ Examiner et approuver la finalisation", `mig:fin:${job.id}`).row();
      break;
    case "finalized":
      kb.text("🗑 Supprimer l'ancien sujet Regular…", `mig:del:${job.id}`).row();
      break;
  }
  if (!isTerminalMigration(job.status) && !["finalized"].includes(job.status)) {
    kb.text("❌ Annuler la migration", `mig:cancel:${job.id}`).row();
  }
  kb.text("🔃 Actualiser", `mig:view:${job.id}`).text("⬅️ Migrations", "mig:list");
  return { text, kb };
}

async function showJob(ctx: { editMessageText: (t: string, o: object) => Promise<unknown> }, jobId: string) {
  const job = await getMigrationJob(jobId);
  if (!job) {
    await ctx.editMessageText("⚠️ Migration introuvable.", {
      reply_markup: new InlineKeyboard().text("⬅️ Menu administrateur", "admin:menu"),
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
  kb.text("⬅️ Menu administrateur", "admin:menu");
  await ctx.editMessageText(
    `🎞️ *PASSER À RETRO*\n\nChoisissez un créateur Regular à préparer pour la migration. Rien n'est déplacé tant que vous n'avez pas examiné l'essai à blanc et lancé la copie.` +
    (regular.length === 0 ? `\n\n_Aucun créateur Regular inscrit._` : ""),
    { parse_mode: "Markdown", reply_markup: kb }
  );
});

migrationComposer.command("move_to_retro", async (ctx) => {
  const creator = await resolveCreator(ctx.match ?? "");
  if (!creator) {
    await ctx.reply("Utilisation : `/move_to_retro <nom ou id du créateur>`", { parse_mode: "Markdown" });
    return;
  }
  await ctx.reply(`Ouvrir la migration de *${mdSafe(creator.name)}* :`, {
    parse_mode: "Markdown",
    reply_markup: new InlineKeyboard().text("🎞️ Continuer", `mig:sel:${creator.id}`),
  });
});

migrationComposer.callbackQuery(/^mig:sel:([\w-]+)$/, async (ctx) => {
  const creator = await getCreator(ctx.match[1]);
  await ctx.answerCallbackQuery();
  if (!creator) {
    await ctx.editMessageText("⚠️ Créateur introuvable.", { reply_markup: new InlineKeyboard().text("⬅️ Retour", "mig:pick") });
    return;
  }
  const existing = await getActiveMigrationForCreator(creator.id);
  if (existing && !["prepared", "blocked"].includes(existing.status)) {
    await showJob(ctx, existing.id);
    return;
  }
  const indexed = (await listMediaIndex(creator.id, { chatId: creator.chatId, topicId: creator.topicId })).length;
  await ctx.editMessageText(
    `🎞️ *DÉPLACER ${mdSafe(creator.name)} VERS RETRO*\n\n` +
    `Messages médias indexés : *${indexed}* (${creator.inventoryStatus === "complete" ? "inventaire complet" : "⚠️ inventaire non confirmé complet"})\n\n` +
    `Ceci prépare un *essai à blanc seulement* : le robot vérifie la correspondance de la source, le forum Retro, les permissions et la protection du contenu, et compte ce qui peut être copié. Rien n'est copié ni supprimé.\n\n` +
    `Veuillez confirmer que le club conserve les droits de publication et de distribution de cette collection :`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text("✅ Je confirme les droits — préparer l'essai à blanc", `mig:rts:${creator.id}`)
        .row()
        .text("❌ Annuler", "mig:pick"),
    }
  );
});

migrationComposer.callbackQuery(/^mig:rts:([\w-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Préparation de l'essai à blanc..." });
  const res = await prepareMigration(ctx.api, {
    creatorId: ctx.match[1],
    adminId: ctx.from!.id,
    rightsConfirmed: true,
  });
  if (!res.ok || !res.job) {
    await ctx.editMessageText(`⚠️ ${res.error ?? "Impossible de préparer la migration."}`, {
      reply_markup: new InlineKeyboard().text("⬅️ Retour", "mig:pick"),
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
  let text = `🚚 *ÉTAT DES MIGRATIONS*\n\n`;
  if (jobs.length === 0) text += `_Aucune migration pour le moment._`;
  for (const j of jobs) {
    text += `• *${mdSafe(j.creatorName)}* — ${STATUS_LABEL[j.status]} (${j.totals.copied}/${j.totals.items})\n`;
    kb.text(j.creatorName, `mig:view:${j.id}`).row();
  }
  kb.text("🎞️ Déplacer un créateur", "mig:pick").row().text("⬅️ Menu administrateur", "admin:menu");
  await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: kb });
});

migrationComposer.callbackQuery(/^mig:view:([\w-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await showJob(ctx, ctx.match[1]);
});

// ---- Execution controls ---------------------------------------------------------

migrationComposer.callbackQuery(/^mig:start:([\w-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Démarrage..." });
  const res = await startMigration(ctx.api, ctx.match[1], ctx.from!.id);
  if (!res.ok && res.error) await ctx.reply(`⚠️ ${res.error}`);
  if (res.ok) {
    // Copy the first batches right away; the cron worker continues the rest.
    await runMigrationStep(ctx.api, ctx.match[1], { maxBatches: 3, timeBudgetMs: 15_000 });
  }
  await showJob(ctx, ctx.match[1]);
});

migrationComposer.callbackQuery(/^mig:run:([\w-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Copie en cours..." });
  const r = await runMigrationStep(ctx.api, ctx.match[1], { maxBatches: 5, timeBudgetMs: 20_000 });
  if (r.reason === "locked") await ctx.reply("ℹ️ Un autre processus exécute déjà cette migration.");
  if (r.reason === "rate_limited") await ctx.reply("ℹ️ Telegram nous demande de ralentir ; le processus reprendra automatiquement.");
  await showJob(ctx, ctx.match[1]);
});

migrationComposer.callbackQuery(/^mig:pause:([\w-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await pauseMigration(ctx.match[1], ctx.from!.id);
  await showJob(ctx, ctx.match[1]);
});

migrationComposer.callbackQuery(/^mig:verify:([\w-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Vérification..." });
  const job = await reevaluateMigration(ctx.api, ctx.match[1]);
  const v = await verifyMigration(ctx.api, ctx.match[1]);
  if (!v.ok) await ctx.reply(`🔍 Vérification :\n${v.problems.map((p) => `• ${p}`).join("\n")}`);
  await showJob(ctx, job.id);
});

migrationComposer.callbackQuery(/^mig:excl:([\w-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `🚫 *EXCLURE LES ÉLÉMENTS NON RÉSOLUS*\n\n` +
    `Ne le faites que si vous avez confirmé que ces messages n'existent plus ou ne doivent pas être déplacés (par exemple supprimés dans le sujet source). ` +
    `Les éléments exclus sont consignés au journal d'audit comme lacunes acceptées par un administrateur ; ils ne sont *pas* copiés.`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text("🚫 Exclure les éléments échoués et ambigus", `mig:exclcfm:${ctx.match[1]}`)
        .row()
        .text("⬅️ Retour", `mig:view:${ctx.match[1]}`),
    }
  );
});

migrationComposer.callbackQuery(/^mig:exclcfm:([\w-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const n = await excludeUnresolvedItems(ctx.match[1], ctx.from!.id, "Accepté par l'administrateur comme non transférable");
  await reevaluateMigration(ctx.api, ctx.match[1]);
  await ctx.reply(`🚫 ${n} élément(s) exclu(s).`);
  await showJob(ctx, ctx.match[1]);
});

migrationComposer.callbackQuery(/^mig:cancel:([\w-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const res = await cancelMigration(ctx.match[1], ctx.from!.id);
  await ctx.editMessageText(
    res.ok
      ? `⚫ Migration annulée. Le sujet d'origine et la fiche du créateur n'ont pas été modifiés.`
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
    `✅ *APPROUVER LA FINALISATION — ${mdSafe(job?.creatorName ?? "")}*\n\n` +
    report.checks.map((c) => `• ${mdSafe(c)}`).join("\n") + "\n\n" +
    (report.ok
      ? `L'approbation fait pointer la fiche existante du créateur (même identifiant interne) vers le sujet Retro et met à jour le répertoire. *Rien n'est supprimé.*`
      : `⚠️ Écarts :\n${report.problems.map((p) => `• ${mdSafe(p)}`).join("\n")}`),
    {
      parse_mode: "Markdown",
      reply_markup: report.ok
        ? new InlineKeyboard().text("✅ Approuver et finaliser", `mig:fincfm:${ctx.match[1]}`).row().text("⬅️ Retour", `mig:view:${ctx.match[1]}`)
        : new InlineKeyboard().text("⬅️ Retour", `mig:view:${ctx.match[1]}`),
    }
  );
});

migrationComposer.callbackQuery(/^mig:fincfm:([\w-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Finalisation..." });
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
    `🗑 *SUPPRIMER L'ANCIEN SUJET REGULAR — ÉTAPE 1/2*\n\n` +
    `*Créateur :* ${mdSafe(job.creatorName)}\n` +
    `*Forum source :* \`${job.source.chatId}\`\n` +
    `*Sujet source :* \`${job.source.topicId}\` ("${mdSafe(job.creatorName)}")\n` +
    `*Résultat de la migration :* ${job.totals.copied} copiés · ${job.totals.excluded} exclus · ${job.totals.failed + job.totals.ambiguous + job.totals.pending} non résolus\n\n` +
    `La suppression d'un sujet retire définitivement tous ses messages. Ouvrez d'abord le sujet Retro et vérifiez-le vous-même.`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text("✅ J'ai examiné manuellement la destination Retro", `mig:delrev:${job.id}`)
        .row()
        .text("❌ Garder l'ancien sujet", `mig:view:${job.id}`),
    }
  );
});

migrationComposer.callbackQuery(/^mig:delrev:([\w-]+)$/, async (ctx) => {
  const res = await requestSourceDeletion(ctx.match[1], ctx.from!.id, true);
  await ctx.answerCallbackQuery();
  if (!res.ok || !res.summary) {
    await ctx.editMessageText(`⚠️ ${res.error}`, {
      reply_markup: new InlineKeyboard().text("⬅️ Retour", `mig:view:${ctx.match[1]}`),
    });
    return;
  }
  const s = res.summary;
  await ctx.editMessageText(
    `🗑 *SUPPRIMER L'ANCIEN SUJET REGULAR — ÉTAPE 2/2 (IRRÉVERSIBLE)*\n\n` +
    `Vous êtes sur le point de supprimer définitivement le sujet \`${s.sourceTopicId}\` (${mdSafe(s.creatorName)}) du forum \`${s.sourceChatId}\` ` +
    `avec tous ses messages. ${s.copied} message(s) ont été copiés vers le sujet Retro \`${s.destinationTopicId}\`.\n\n` +
    `Cette confirmation expire dans 10 minutes.`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text("🗑 SUPPRIMER l'ancien sujet Regular", `mig:delcfm:${ctx.match[1]}`)
        .row()
        .text("❌ Le garder", `mig:view:${ctx.match[1]}`),
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
      "Utilisation : `/index_media <nom ou id du créateur> <https://t.me/c/…/sujet/message> …`\n" +
      "Clic droit sur un message → Copier le lien. Le sujet de chaque lien doit être celui du créateur.",
      { parse_mode: "Markdown" }
    );
    return;
  }
  const creator = await resolveCreator(parts.slice(0, firstLink).join(" "));
  if (!creator) {
    await ctx.reply("⚠️ Créateur introuvable.");
    return;
  }
  const res = await indexMediaFromLinks(ctx.from!.id, creator, parts.slice(firstLink));
  await ctx.reply(
    `🗂 *${mdSafe(creator.name)}* — ${res.added} indexé(s), ${res.alreadyIndexed} déjà connu(s), ${res.rejected.length} rejeté(s).` +
    (res.rejected.length ? `\n${res.rejected.slice(0, 5).map((r) => `• ${mdSafe(r.reason)}`).join("\n")}` : "") +
    `\n\nQuand tous les messages médias sont indexés, exécutez \`/attest_inventory ${mdSafe(creator.name)}\`.`,
    { parse_mode: "Markdown" }
  );
});

migrationComposer.command("attest_inventory", async (ctx) => {
  const creator = await resolveCreator(ctx.match ?? "");
  if (!creator) {
    await ctx.reply("Utilisation : `/attest_inventory <nom ou id du créateur>`", { parse_mode: "Markdown" });
    return;
  }
  const updated = await attestInventoryComplete(ctx.from!.id, creator);
  await ctx.reply(
    updated
      ? `✅ L'inventaire de *${mdSafe(creator.name)}* est marqué complet par vous. La migration traitera les messages indexés comme la collection complète.`
      : `⚠️ Aucun média indexé pour ${creator.name} ; indexez-le d'abord avec /index_media.`,
    { parse_mode: "Markdown" }
  );
});

migrationComposer.command("retire_creator", async (ctx) => {
  const parts = (ctx.match ?? "").trim().split(/\s+/);
  const when = parts.pop() ?? "";
  const creator = await resolveCreator(parts.join(" "));
  if (!creator || !when) {
    await ctx.reply("Utilisation : `/retire_creator <nom du créateur> <AAAA-MM-JJ|clear>`", { parse_mode: "Markdown" });
    return;
  }
  const updated = await setRetirement(creator, when);
  await ctx.reply(updated ? `✅ Retraite mise à jour pour ${creator.name}.` : "⚠️ Date invalide.");
});

migrationComposer.command("relink_creator", async (ctx) => {
  const parts = (ctx.match ?? "").trim().split(/\s+/);
  const topicId = Number(parts.pop());
  const creator = await resolveCreator(parts.join(" "));
  if (!creator || !Number.isInteger(topicId) || topicId <= 0) {
    await ctx.reply("Utilisation : `/relink_creator <nom ou id du créateur> <id du sujet retro>`", { parse_mode: "Markdown" });
    return;
  }
  const res = await relinkCreatorToRetroTopic(ctx.from!.id, creator, topicId);
  if (res.ok) await syncPublicDirectory(ctx.api, true).catch(() => {});
  await ctx.reply(
    res.ok
      ? `✅ ${creator.name} pointe maintenant vers le sujet Retro ${topicId}. L'ancien sujet Regular n'a pas été touché.`
      : `⚠️ ${res.error}`
  );
});
