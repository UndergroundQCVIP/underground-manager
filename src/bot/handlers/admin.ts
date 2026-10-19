/**
 * LA CONFRÉRIE — Administrator Handlers & Controls
 */

import { Composer, InlineKeyboard } from "grammy";
import { formatTorontoDate } from "../../util/time.ts";
import { getClubName, getConfig } from "../../config.ts";
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
import { escapeMd } from "../../util/markdown.ts";

export const adminComposer = new Composer();

// Admin authentication, scoped to this composer's own commands and admin buttons
// (see adminRouteGuard: a blanket gate would block every member feature after it).
export const ADMIN_COMMANDS = [
  "admin", "lookup", "grant", "register_creator",
  "index_media", "attest_inventory", "retire_creator", "move_to_retro", "relink_creator", "diag",
];
adminComposer.use(
  adminRouteGuard({ callbackPrefixes: ["admin:", "mig:"], commands: ADMIN_COMMANDS })
);

/**
 * /diag — what the RUNNING bot actually sees (configuration, live Telegram rights, registered
 * creators per forum). Plain text so nothing can break formatting; no secrets are shown.
 */
adminComposer.command("diag", async (ctx) => {
  const { getConfig } = await import("../../config.ts");
  const { listCreators, creatorCollection } = await import("../../db/creators.ts");
  const { getDirectorySyncState } = await import("../../db/directory.ts");
  const c = getConfig();
  const tail = (n: number) => (n ? `…${String(n).slice(-5)}` : "NON DÉFINI");
  const lines: string[] = ["🩺 DIAGNOSTIC (robot en ligne)", ""];

  lines.push(`Forum Regular (VIP_COLLECTIONS_CHAT_ID) : ${tail(c.VIP_COLLECTIONS_CHAT_ID)}`);
  lines.push(`Forum Retro (TELEGRAM_RETRO_FORUM_CHAT_ID) : ${tail(c.TELEGRAM_RETRO_FORUM_CHAT_ID)}`);
  lines.push(`Répertoire public : ${tail(c.PUBLIC_DIRECTORY_CHAT_ID)}`);
  lines.push(`Mode d'adhésion par défaut : ${c.MEMBERSHIP_MODE}`);
  lines.push("");

  for (const [label, chatId] of [["Regular", c.VIP_COLLECTIONS_CHAT_ID], ["Retro", c.TELEGRAM_RETRO_FORUM_CHAT_ID]] as const) {
    if (!chatId) {
      lines.push(`${label} : identifiant absent de l'environnement du robot → le robot ignore ce forum.`);
      continue;
    }
    try {
      const me = await ctx.api.getMe();
      const chat = await ctx.api.getChat(chatId);
      const m = await ctx.api.getChatMember(chatId, me.id);
      // deno-lint-ignore no-explicit-any
      const r = m as any;
      lines.push(
        `${label} : « ${"title" in chat ? chat.title : "?"} » · sujets ${"is_forum" in chat && chat.is_forum ? "activés" : "NON activés"} · ` +
          `robot ${m.status}` +
          (m.status === "administrator"
            ? ` · gérer les sujets ${r.can_manage_topics === false ? "NON" : "oui"} · anonyme ${r.is_anonymous ? "oui" : "non"}`
            : "")
      );
    } catch (err) {
      lines.push(`${label} : ERREUR Telegram → ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const all = await listCreators();
  lines.push("");
  for (const col of ["regular", "retro"] as const) {
    const mine = all.filter((x) => creatorCollection(x) === col);
    const listed = mine.filter((x) => x.hasContent && x.status === "active").length;
    lines.push(`Créateurs ${col === "retro" ? "Retro" : "Regular"} inscrits : ${mine.length} (listés au répertoire : ${listed})`);
    if (col === "retro") {
      for (const x of mine.slice(0, 15)) lines.push(`   • ${x.name} — sujet ${x.topicId}${x.hasContent ? "" : " (aucun contenu détecté → non listé)"}`);
    }
  }

  const dir = await getDirectorySyncState();
  lines.push("");
  lines.push(`Répertoire : dernière synchro ${dir.lastSyncAt ?? "jamais"} · changements en attente : ${dir.isDirty ? "oui" : "non"}`);
  if (dir.lastError) lines.push(`Dernière erreur de synchro : ${dir.lastError}`);
  try {
    const w = await ctx.api.getWebhookInfo();
    lines.push(`Webhook : ${w.pending_update_count} en attente` + (w.last_error_message ? ` · dernière erreur ${new Date((w.last_error_date ?? 0) * 1000).toISOString()} : ${w.last_error_message}` : " · aucune erreur"));
  } catch { /* optional */ }

  lines.push("");
  if (all.filter((x) => creatorCollection(x) === "retro").length === 0 && c.TELEGRAM_RETRO_FORUM_CHAT_ID) {
    lines.push("➡️ Aucun Retro inscrit : tapez /register_here dans chaque sujet Retro (en tant qu'administrateur, pas en anonyme si possible).");
  }
  await ctx.reply(lines.join("\n").slice(0, 3900));
});

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

  let text = `👥 *MEMBRES INSCRITS* (Total : ${total})\n\n`;

  const kb = new InlineKeyboard();
  if (members.length === 0) {
    text += "_Aucun membre enregistré pour le moment._\n";
  } else {
    for (const m of members) {
      const name = m.username ? `@${m.username}` : m.firstName;
      text += `• \`${m.userId}\` — ${escapeMd(name)}\n`;
      kb.text(`Gérer ${name}`, `admin:manage:${m.userId}`).row();
    }
  }

  kb.text("⬅️ Menu administrateur", "admin:menu");

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
    `🔍 *RECHERCHE DE MEMBRE*\n\n` +
    `Pour rechercher un membre, envoyez la commande avec son identifiant Telegram numérique ou son @nom_d'utilisateur :\n\n` +
    `Exemple :\n` +
    `\`/lookup 123456789\`\n` +
    `\`/lookup @username\``,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard().text("⬅️ Menu administrateur", "admin:menu"),
    }
  );
});

// /lookup command
adminComposer.command("lookup", async (ctx) => {
  const input = ctx.match?.trim();
  if (!input) {
    await ctx.reply("Veuillez indiquer un identifiant d'utilisateur ou un @nom_d'utilisateur : `/lookup 123456789`", {
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
    await ctx.reply(`❌ Membre \`${input}\` introuvable dans la base de données.`, {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard().text("⬅️ Menu administrateur", "admin:menu"),
    });
    return;
  }

  const summary = await getMembershipSummary(member.userId);
  const allEntitlements = await getUserEntitlements(member.userId);

  let text =
    `👤 *DÉTAILS DU MEMBRE*\n\n` +
    `*ID utilisateur :* \`${member.userId}\`\n` +
    `*Nom :* ${escapeMd(member.firstName)} ${escapeMd(member.lastName || "")}\n` +
    `*Nom d'utilisateur :* ${member.username ? `@${escapeMd(member.username)}` : "Aucun"}\n` +
    `*Première apparition :* ${formatTorontoDate(member.firstSeenAt, { dateStyle: "medium", timeStyle: "short" })}\n` +
    `*Adhésion :* ${summary.primaryType}\n` +
    `*Espaces actifs :* ${summary.accessibleSpaces.join(", ") || "Aucun"}\n` +
    `*Expiration :* ${summary.effectiveExpiry ? formatTorontoDate(summary.effectiveExpiry, { dateStyle: "medium", timeStyle: "short" }) : "s.o."}\n\n` +
    `*Historique des accès :*\n`;

  if (allEntitlements.length === 0) {
    text += "_Aucun enregistrement d'accès trouvé._\n";
  } else {
    for (const ent of allEntitlements.slice(0, 5)) {
      const statusIcon = ent.status === "active" ? "🟢" : "⚪";
      text += `${statusIcon} *${ent.source}* (${ent.status})\n  Expiration : ${formatTorontoDate(ent.expiresAt)}\n`;
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
    await ctx.answerCallbackQuery({ text: "Membre introuvable" });
    return;
  }

  const summary = await getMembershipSummary(userId);
  const activeComp = summary.activeEntitlements.find(
    (e) => e.source === "complimentary"
  );

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `👤 *GÉRER LE MEMBRE : \`${userId}\`*\n\n` +
    `*Nom :* ${escapeMd(member.firstName)}\n` +
    `*Nom d'utilisateur :* ${member.username ? `@${escapeMd(member.username)}` : "Aucun"}\n` +
    `*Adhésion :* ${summary.primaryType}\n` +
    `*Expiration :* ${summary.effectiveExpiry ? formatTorontoDate(summary.effectiveExpiry) : "Aucune"}`,
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
  kb.text("⬅️ Menu administrateur", "admin:menu");

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `🎁 *ACCORDER UN ACCÈS GRACIEUX — ÉTAPE 1*\n\n` +
    `Sélectionnez un membre inscrit ci-dessous, ou envoyez la commande :\n\n` +
    `\`/grant <userId> [days]\`\n` +
    `Exemple : \`/grant 123456789 30\``,
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
    await ctx.reply("Utilisation : `/grant <id_utilisateur_numérique> [jours]`\nExemple : `/grant 123456789 30`", {
      parse_mode: "Markdown",
    });
    return;
  }

  await ctx.reply(
    `🎁 *ACCORDER UN ACCÈS GRACIEUX*\n\nID de l'utilisateur ciblé : \`${targetId}\`\nChoisissez la durée :`,
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
    `🎁 *ACCORDER UN ACCÈS GRACIEUX — ÉTAPE 2*\n\n` +
    `*Membre ciblé :* \`${userId}\`\n` +
    `*Durée :* ${duration} jours\n\n` +
    `Choisissez le motif de cet accès :`,
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
    `🎁 *ACCORDER UN ACCÈS GRACIEUX — ÉTAPE 3*\n\n` +
    `*Membre ciblé :* \`${userId}\`\n` +
    `*Durée :* ${duration} jours\n` +
    `*Motif :* ${reason}\n\n` +
    `Choisissez les espaces autorisés :`,
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
      `🎁 *CONFIRMER L'ACCÈS GRACIEUX*\n\n` +
      `*Membre ciblé :* \`${userId}\`\n` +
      `*Durée :* ${duration} jours\n` +
      `*Motif :* ${reason}\n` +
      `*Niveau d'accès :* ${level}\n\n` +
      `Veuillez confirmer pour activer l'accès immédiatement :`,
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
        text: `Erreur : ${result.error ?? "Échec de l'octroi"}`,
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Accès gracieux accordé!" });
    await ctx.editMessageText(
      `✅ *ACCÈS GRACIEUX ACTIVÉ*\n\n` +
      `*Membre :* \`${userId}\`\n` +
      `*Durée :* ${duration} jours\n` +
      `*Expiration :* ${formatTorontoDate(result.entitlement.expiresAt)}\n` +
      `*Espaces :* ${result.entitlement.spaces.join(", ")}`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("⬅️ Menu administrateur", "admin:menu"),
      }
    );

    // Notify the member directly
    try {
      await ctx.api.sendMessage(
        userId,
        `🎁 *Vous avez reçu un accès VIP gracieux!*\n\n` +
        `L'accès est actif pour *${duration} jours* (jusqu'au ${formatTorontoDate(
          result.entitlement.expiresAt
        )}).\n\n` +
        `Touchez ci-dessous pour rejoindre vos espaces :`,
        {
          parse_mode: "Markdown",
          reply_markup: new InlineKeyboard().text(
            "🔓 Accéder à mes canaux",
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
    await ctx.answerCallbackQuery({ text: `Échec : ${result.error}` });
    return;
  }

  await ctx.answerCallbackQuery({ text: `Prolongé de ${days} jours!` });
  await ctx.reply(
    `✅ Accès prolongé de ${days} jours.\nNouvelle expiration : ${formatTorontoDate(
      result.entitlement.expiresAt
    , { dateStyle: "medium", timeStyle: "short" })}`,
    {
      reply_markup: new InlineKeyboard().text("⬅️ Menu administrateur", "admin:menu"),
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
    await ctx.answerCallbackQuery({ text: `Échec : ${result.error}` });
    return;
  }

  await ctx.answerCallbackQuery({ text: "Accès révoqué!" });
  await ctx.reply(`⛔ Accès révoqué avec succès.`, {
    reply_markup: new InlineKeyboard().text("⬅️ Menu administrateur", "admin:menu"),
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
    `📊 *APERÇU DES ABONNEMENTS ET DES REVENUS*\n\n` +
    `*Total des utilisateurs inscrits :* ${totalMembers}\n` +
    `*Abonnés payants actifs :* ${activePaid}\n` +
    `*Accès gracieux actifs :* ${activeComp}\n` +
    `*Transactions en Étoiles confirmées :* ${payments.length}\n` +
    `*Revenus totaux en Étoiles :* ⭐️ ${totalPaidRevenue}\n\n` +
    `_Les contrôles complets de la trésorerie et des versements seront gérés dans UG-03._`;

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(text, {
    parse_mode: "Markdown",
    reply_markup: new InlineKeyboard().text("⬅️ Menu administrateur", "admin:menu"),
  });
});

// System Status & Permissions Check
adminComposer.callbackQuery("admin:status", async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Vérification des permissions des espaces..." });

  let text = `⚙️ *ÉTAT DU SYSTÈME ET PERMISSIONS DU ROBOT*\n\n`;

  for (const spaceId of SPACE_IDS) {
    const title = getSpaceTitle(spaceId);
    if (!getChatId(spaceId)) {
      text += `⚪ *${title} :* non configuré\n`;
      continue;
    }
    const perm = await checkBotPermissions(ctx.api, spaceId);
    if (perm.ok) {
      text += `🟢 *${title}:* OK (permissions d'administrateur vérifiées)\n`;
    } else {
      text += `🔴 *${title}:* Manquantes [${perm.missingPermissions.join(", ")}]\n`;
    }
  }

  text += `\n*Base de données :* Deno KV (connectée)\n` +
    `*Réconciliation :* toutes les heures via Deno Cron\n` +
    `*Mode de paiement :* Étoiles Telegram officielles (XTR)`;

  await ctx.editMessageText(text, {
    parse_mode: "Markdown",
    reply_markup: new InlineKeyboard()
      .text("🔄 Lancer une resynchronisation sécuritaire", "admin:resync")
      .row()
      .text("⬅️ Menu administrateur", "admin:menu"),
  });
});

// Trigger Safe Resynchronization
adminComposer.callbackQuery("admin:resync", async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Réconciliation des accès en cours..." });

  try {
    const result = await reconcileAllMembers(ctx.api);

    await ctx.reply(
      `🔄 *RÉCONCILIATION DES ACCÈS TERMINÉE*\n\n` +
      `*Membres vérifiés :* ${result.checkedUsers}\n` +
      `*Membres expirés retirés :* ${result.removedCount}\n` +
      `*Erreurs rencontrées :* ${result.errors.length}\n` +
      (result.errors.length > 0
        ? `\n_Erreurs :_\n${result.errors.slice(0, 3).join("\n")}`
        : ""),
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("⬅️ Menu administrateur", "admin:menu"),
      }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.reply(`⚠️ Erreur de réconciliation : ${msg}`);
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
    `👩‍🎤 *CRÉATEURS — ${getClubName()}*\n\n` +
    `*Total des créateurs inscrits :* ${creators.length} (Regular ${creators.length - retro} · Retro ${retro})\n` +
    `*Listés au répertoire (avec médias) :* ${withContent}\n\n` +
    `💡 _Associer un sujet existant :_ \`/register_creator <thread_id> <name>\`\n` +
    `💡 _Retraite :_ \`/retire_creator <nom> <AAAA-MM-JJ|clear>\``;

  const kb = new InlineKeyboard()
    .text("👀 Voir les créateurs", "admin:creators_list:0")
    .text("📝 Inscrire un créateur", "admin:creator_register_help")
    .row()
    .text("✏️ Modifier un créateur", "admin:creator_edit_help")
    .text("🎞️ Passer à Retro", "mig:pick")
    .row()
    .text("🚚 État des migrations", "mig:list")
    .text("🛠️ Réparer le répertoire", "admin:repair_dir")
    .row()
    .text("⬅️ Menu administrateur", "admin:menu");

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

  let text = `👀 *CRÉATEURS* (page ${page + 1}/${Math.max(1, Math.ceil(creators.length / pageSize))})\n\n`;
  const kb = new InlineKeyboard();
  if (slice.length === 0) text += "_Aucun créateur inscrit pour le moment._\n";
  for (const c of slice) {
    const icon = c.status === "archived" ? "📦" : c.hasContent ? "🟢" : "⚪";
    const label = creatorCollection(c) === "retro" ? "Retro" : "Regular";
    text += `${icon} *${c.name}* — ${label}\n`;
    kb.text(`${c.name} (${label})`, `admin:creator_view:${c.id}`).row();
  }
  if (page > 0) kb.text("◀️ Préc.", `admin:creators_list:${page - 1}`);
  if ((page + 1) * pageSize < creators.length) kb.text("Suiv. ▶️", `admin:creators_list:${page + 1}`);
  kb.row().text("⬅️ Créateurs", "admin:creators_menu");

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
    await ctx.editMessageText("⚠️ Créateur introuvable.", {
      reply_markup: new InlineKeyboard().text("⬅️ Créateurs", "admin:creators_menu"),
    });
    return;
  }
  const collection = creatorCollection(creator);
  const indexed = (await listMediaIndex(creator.id, { chatId: creator.chatId, topicId: creator.topicId })).length;
  const job = await getActiveMigrationForCreator(creator.id);
  const text =
    `👩‍🎤 *${creator.name}*\n\n` +
    `*Collection :* ${collection === "retro" ? "Retro" : "Regular"}\n` +
    `*Forum / Sujet :* \`${creator.chatId}\` / \`${creator.topicId}\`\n` +
    `*Dernière mise à jour du contenu :* ${creator.lastContentUpdatedAt ? new Date(creator.lastContentUpdatedAt).toLocaleDateString("en-US") : "—"}\n` +
    `*Droits de publication :* ${creator.rightsStatus === "verified" ? "✅ vérifiés" : "⚠️ non vérifiés"}\n` +
    `*Messages médias indexés :* ${indexed} (${creator.inventoryStatus === "complete" ? "inventaire complet" : "inventaire NON confirmé complet"})\n` +
    (creator.retiredAt ? `*Retraite :* ${new Date(creator.retiredAt).toLocaleDateString("en-US")}\n` : "") +
    (job ? `*Migration:* ${job.status.replace(/_/g, " ")}\n` : "");
  const kb = new InlineKeyboard();
  if (collection === "regular") kb.text("🎞️ Passer à Retro", `mig:sel:${creator.id}`).row();
  if (job) kb.text("🚚 Open Migration", `mig:view:${job.id}`).row();
  kb.text("⬅️ Créateurs", "admin:creators_list:0");
  await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: kb });
});

adminComposer.callbackQuery("admin:creator_register_help", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `📝 *INSCRIRE UN CRÉATEUR*\n\n` +
    `Les nouveaux sujets créés dans le forum Regular ou Retro sont inscrits automatiquement.\n` +
    `Les sujets déjà existants sont aussi inscrits automatiquement dès qu'un administrateur y publie une photo ou une vidéo.\n` +
    `*Le plus simple :* tapez \`/register_here\` à l'intérieur du sujet du créateur (en tant qu'administrateur).\n` +
    `Pour associer un sujet existant manuellement :\n\`/register_creator <id_sujet> <nom>\` (Regular)\n\`/register_creator retro <id_sujet> <nom>\` (Retro)\n` +
    `_L'ID du sujet est le dernier nombre d'un lien de message du sujet (t.me/c/…/ID_SUJET/…)._`,
    { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("⬅️ Créateurs", "admin:creators_menu") }
  );
});

adminComposer.callbackQuery("admin:creator_edit_help", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `✏️ *MODIFIER UN CRÉATEUR*\n\n` +
    `• *Renommer :* renommez le sujet du forum dans Telegram — le robot suit.\n` +
    `• *Retraite :* \`/retire_creator <name> <YYYY-MM-DD>\` (or \`clear\`)\n` +
    `• *Indexer d'anciens médias :* \`/index_media <nom> <liens de messages du sujet…>\`\n` +
    `• *Attester que l'inventaire est complet :* \`/attest_inventory <nom>\`\n\n` +
    `L'identifiant interne du créateur ne change jamais.`,
    { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("⬅️ Créateurs", "admin:creators_menu") }
  );
});

adminComposer.callbackQuery("admin:repair_dir", async (ctx) => {
  const { repairDirectory } = await import("../../creators/admin.ts");
  const { syncPublicDirectory } = await import("../../directory/sync.ts");
  await ctx.answerCallbackQuery({ text: "Réparation du répertoire..." });
  const report = await repairDirectory();
  const sync = await syncPublicDirectory(ctx.api, true);
  await ctx.editMessageText(
    `🛠️ *RÉPERTOIRE RÉPARÉ*\n\n` +
    `• Créateurs vérifiés : ${report.checked}\n` +
    `• Index de recherche réparés : ${report.indexesRepaired}\n` +
    `• Noms en double : ${report.duplicateNames.length ? report.duplicateNames.join(", ") : "aucun"}\n` +
    `• Répertoire public : ${sync.updated ? `republié (${sync.publishedCount} message(s))` : sync.reason ?? sync.error ?? "inchangé"}`,
    { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("⬅️ Créateurs", "admin:creators_menu") }
  );
});

// Directory menu
adminComposer.callbackQuery("admin:sync_dir_menu", async (ctx) => {
  const { getDirectorySyncState } = await import("../../db/directory.ts");
  const { listCreators, creatorCollection } = await import("../../db/creators.ts");
  const state = await getDirectorySyncState();
  const listed = await listCreators({ status: "active", hasContentOnly: true });
  const everyone = await listCreators();
  const retro = listed.filter((c) => creatorCollection(c) === "retro").length;
  const retroRegistered = everyone.filter((c) => creatorCollection(c) === "retro");
  const retroHidden = retroRegistered.filter((c) => !c.hasContent || c.status !== "active").length;
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `📚 *RÉPERTOIRE*\n\n` +
    `• Créateurs listés : ${listed.length} (Regular ${listed.length - retro} · Retro ${retro})\n` +
    `• Forum Retro configuré dans le robot en ligne : ${getConfig().TELEGRAM_RETRO_FORUM_CHAT_ID ? `oui (…${String(getConfig().TELEGRAM_RETRO_FORUM_CHAT_ID).slice(-4)})` : "⚠️ NON — définissez TELEGRAM_RETRO_FORUM_CHAT_ID dans Deno Deploy"}\n` +
    `• Retro inscrits : ${retroRegistered.length}${retroHidden ? ` (dont ${retroHidden} sans contenu détecté, donc non listés)` : ""}\n` +
    (state.lastError ? `• ⚠️ Dernière erreur de synchronisation : ${escapeMd(state.lastError)}\n` : "") +
    (retroRegistered.length === 0
      ? `\n💡 _Aucun créateur Retro n'est inscrit. Faites publier une photo/vidéo dans le sujet Retro par un administrateur (le sujet s'inscrit tout seul), ou utilisez_ \`/register_creator retro <id_sujet> <nom>\`.\n\n`
      : "") +
    `• Dernière synchronisation : ${state.lastSyncAt ? new Date(state.lastSyncAt).toLocaleString("fr-CA") : "jamais"}\n` +
    `• Changements en attente : ${state.isDirty ? "oui" : "non"}`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text("🔄 Synchroniser le répertoire public maintenant", "admin:sync_dir")
        .row()
        .text("🛠️ Réparer le répertoire", "admin:repair_dir")
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
    `💎 *FORFAITS D'ADHÉSION*\n\n` +
    `*Regular :* ${regular.priceStars} Étoiles / 30 jours — ${regular.enabled ? "🟢 en vente" : "🔴 désactivé"}\n` +
    `*Retro Plus :* ${retro.priceStars > 0 ? `${retro.priceStars} Étoiles / 30 jours` : "prix non configuré"} — ${retro.enabled ? "🟢 en vente" : "🔴 facturation désactivée"}\n\n` +
    `*Revenus par forfait (ce mois-ci) :*\n${formatTierRevenueLines(tiers)}\n` +
    `_Les prix se règlent avec STARS_PRICE_AMOUNT et RETRO_PLUS_STARS_PRICE_AMOUNT. Retro Plus reste désactivé tant que son prix est 0 ou que le forum Retro n'est pas configuré._`,
    { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("⬅️ Admin Menu", "admin:menu") }
  );
});

// Trigger Public Directory Sync
adminComposer.callbackQuery("admin:sync_dir", async (ctx) => {
  const { syncPublicDirectory } = await import("../../directory/sync.ts");
  await ctx.answerCallbackQuery({ text: "Synchronisation du répertoire public des créateurs..." });

  const result = await syncPublicDirectory(ctx.api, true);
  if (result.updated) {
    await ctx.reply(`✅ *Répertoire public synchronisé!*\n${result.publishedCount} message(s) publié(s) ou mis à jour.`, {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard().text("⬅️ Menu des créateurs", "admin:creators_menu"),
    });
  } else {
    await ctx.reply(`ℹ️ Synchronisation du répertoire terminée : ${result.reason || result.error || "Aucune mise à jour nécessaire."}`, {
      reply_markup: new InlineKeyboard().text("⬅️ Menu des créateurs", "admin:creators_menu"),
    });
  }
});

// /register_creator command
adminComposer.command("register_creator", async (ctx) => {
  const args = ctx.match?.trim().split(/\s+/);
  if (!args || args.length < 2) {
    await ctx.reply(
      "Utilisation : `/register_creator [retro] <id_sujet_numérique> <Nom du créateur>`\n" +
      "Exemples : `/register_creator 42 Aria` (forum Regular) · `/register_creator retro 17 Maya` (forum Retro)",
      { parse_mode: "Markdown" }
    );
    return;
  }

  // Optional leading "retro"/"regular" picks the forum (default: Regular).
  let forum: "regular" | "retro" = "regular";
  if (/^(retro|regular)$/i.test(args[0])) forum = args.shift()!.toLowerCase() as "regular" | "retro";
  if (args.length < 2) {
    await ctx.reply("Utilisation : `/register_creator [retro] <id_sujet_numérique> <Nom du créateur>`", { parse_mode: "Markdown" });
    return;
  }

  const topicId = Number(args[0]);
  const creatorName = args.slice(1).join(" ");
  const config = (await import("../../config.ts")).getConfig();
  const targetChatId = forum === "retro" ? config.TELEGRAM_RETRO_FORUM_CHAT_ID : config.VIP_COLLECTIONS_CHAT_ID;
  if (!targetChatId) {
    await ctx.reply("Le forum Retro n'est pas configuré (TELEGRAM_RETRO_FORUM_CHAT_ID).");
    return;
  }

  if (isNaN(topicId) || topicId <= 0) {
    await ctx.reply("ID de sujet invalide. Il doit s'agir d'un ID de fil numérique positif.");
    return;
  }

  const { registerOrRepairTopic } = await import("../../creators/service.ts");
  let creator;
  try {
    creator = await registerOrRepairTopic(ctx.from!.id, targetChatId, topicId, creatorName);
  } catch (err) {
    await ctx.reply(`⚠️ ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  await ctx.reply(
    `✅ *Créateur inscrit!*\n\n` +
    `• *Nom :* ${escapeMd(creator.name)}\n` +
    `• *Collection :* ${forum === "retro" ? "Retro" : "Regular"}\n` +
    `• *ID du sujet :* \`${creator.topicId}\`\n` +
    `• *ID du clavardage :* \`${creator.chatId}\`\n` +
    `• *Statut :* Actif`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard().text("👩‍🎤 Menu des créateurs", "admin:creators_menu"),
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
    `🎯 *ADMINISTRATION DE LA LISTE DE SOUHAITS*\n\n` +
    `*Total des candidats :* ${candidates.length}\n` +
    `*En attente de révision :* ${pendingReview.length}\n\n` +
    `*Principales suggestions de la communauté :*\n`;

  const kb = new InlineKeyboard();
  if (candidates.length === 0) {
    text += `_Aucun candidat dans la Liste de souhaits pour le moment._\n\n`;
  } else {
    for (const c of candidates.slice(0, 8)) {
      const statusLabel = WANTED_STATUS_LABELS[c.status] || c.status;
      text += `• *${escapeMd(c.name)}* — ${c.supportCount} appuis \`[${statusLabel}]\`\n`;
      kb.text(`Gérer ${c.name}`, `admin:manage_cand:${c.id}`).row();
    }
    text += "\n";
  }

  kb.text("🔄 Synchroniser le canal des souhaits", "admin:sync_wanted_channel")
    .row()
    .text("⬅️ Menu administrateur", "admin:menu");

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
    await ctx.answerCallbackQuery({ text: "Candidat introuvable." });
    return;
  }

  const statusLabel = WANTED_STATUS_LABELS[candidate.status] || candidate.status;
  const text =
    `🎯 *GÉRER LE CANDIDAT : ${escapeMd(candidate.name)}*\n\n` +
    `*Appuis :* ${candidate.supportCount}\n` +
    `*Statut actuel :* \`${statusLabel}\`\n` +
    `*URL du profil :* ${candidate.profileUrl || "Aucune"}\n` +
    `*Date de suggestion :* ${formatTorontoDate(candidate.createdAt)}\n\n` +
    `Mettre à jour le statut :`;

  const kb = new InlineKeyboard()
    .text("✅ Approuver pour le vote", `admin:set_stat:${candidate.id}:eligible_for_voting`)
    .text("💰 Révision du prix", `admin:set_stat:${candidate.id}:pricing_review`)
    .row();

  // Acquisition money flow goes through the treasury (budget check, commitment,
  // ledger) — never a bare status flip.
  if (candidate.status === "selected") {
    kb.text("💳 Approuver l'acquisition (réserver le budget)", `admin:acq_approve:${candidate.id}`).row();
  } else if (candidate.status === "acquisition_pending") {
    kb.text("🏦 Payé avec les fonds du club", `admin:acq_paid:${candidate.id}:club_funds`)
      .text("👤 J'ai payé personnellement", `admin:acq_paid:${candidate.id}:admin_personal`)
      .row()
      .text("↩️ Annuler et libérer le budget", `admin:acq_cancel:${candidate.id}`)
      .row();
  }

  kb.text("🟢 Marquer comme disponible", `admin:set_stat:${candidate.id}:available`)
    .row()
    .text("⛔ Rejeter / indisponible", `admin:set_stat:${candidate.id}:rejected_unavailable`)
    .row()
    .text("⬅️ Admin des souhaits", "admin:wanted_menu");

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

  // "voting", "selected", "acquisition_pending" and "acquired" are owned by the
  // ballot and treasury workflows and cannot be set by hand.
  const MANUAL_STATUSES = ["requested", "pricing_review", "eligible_for_voting", "available", "rejected_unavailable"];
  if (!MANUAL_STATUSES.includes(newStatus)) {
    await ctx.answerCallbackQuery({ text: "Ce statut est géré automatiquement.", show_alert: true });
    return;
  }

  const updated = await updateWantedStatus(candidateId, newStatus, `Updated by admin ${ctx.from!.id}`);
  if (!updated) {
    await ctx.answerCallbackQuery({ text: "Échec de la mise à jour du statut." });
    return;
  }

  await ctx.answerCallbackQuery({ text: `Statut mis à jour : ${newStatus}` });
  await ctx.reply(`✅ Le statut du candidat *${escapeMd(updated.name)}* est maintenant \`${newStatus}\`.`, {
    parse_mode: "Markdown",
    reply_markup: new InlineKeyboard().text("🎯 Admin des souhaits", "admin:wanted_menu"),
  });
});

// Sync Wanted List Channel
adminComposer.callbackQuery("admin:sync_wanted_channel", async (ctx) => {
  const { syncWantedListChannel } = await import("../../wanted/service.ts");
  await ctx.answerCallbackQuery({ text: "Synchronisation du canal de la Liste de souhaits..." });

  const result = await syncWantedListChannel(ctx.api);
  if (result.success) {
    await ctx.reply("✅ Canal de la Liste de souhaits synchronisé avec succès!", {
      reply_markup: new InlineKeyboard().text("🎯 Admin des souhaits", "admin:wanted_menu"),
    });
  } else {
    await ctx.reply(`⚠️ Échec de la synchronisation du canal de la Liste de souhaits : ${result.error}`, {
      reply_markup: new InlineKeyboard().text("🎯 Admin des souhaits", "admin:wanted_menu"),
    });
  }
});

// Voting Administration Menu
adminComposer.callbackQuery("admin:voting_menu", async (ctx) => {
  const { getActiveBallot, listPastBallots, tallyBallot } = await import("../../db/voting.ts");
  const activeBallot = await getActiveBallot();
  const past = await listPastBallots(3);

  let text = `🗳️ *ADMINISTRATION DU VOTE D'ACQUISITION*\n\n`;

  const kb = new InlineKeyboard();

  if (activeBallot) {
    const summary = await tallyBallot(activeBallot.id);
    const closesStr = formatTorontoDate(activeBallot.closesAt, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

    text +=
      `🟢 *SCRUTIN ACTIF : ${escapeMd(activeBallot.title)}*\n` +
      `*Clôture :* ${closesStr}\n` +
      `*Votes exprimés jusqu'à maintenant :* ${summary.totalVotes}\n` +
      `*Candidats :* ${activeBallot.candidates.map((c) => escapeMd(c.creatorName)).join(", ")}\n\n`;

    kb.text("🛑 Clore le scrutin maintenant et compter les votes", `admin:close_ballot:${activeBallot.id}`).row();
  } else {
    text += `⚪ _Aucun scrutin actif en cours._\n\n`;
    kb.text("📝 Préparer le scrutin mensuel", "admin:prepare_ballot").row();
  }

  if (past.length > 0) {
    text += `*Scrutins passés :*\n`;
    for (const b of past) {
      text += `• ${escapeMd(b.title)} (${b.status})\n`;
    }
  }

  kb.text("⬅️ Menu administrateur", "admin:menu");

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
      text: "Il faut au moins 2 candidats ayant des appuis pour créer un scrutin.",
      show_alert: true,
    });
    return;
  }

  const kb = new InlineKeyboard()
    .text("🚀 Ouvrir le scrutin maintenant (5 meilleurs candidats)", "admin:launch_ballot")
    .row()
    .text("❌ Annuler", "admin:voting_menu");

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `🗳️ *PRÉPARER LE SCRUTIN MENSUEL DES CRÉATEURS*\n\n` +
    `*Candidats admissibles à la liste restreinte :*\n` +
    eligible.slice(0, 5).map((c, i) => `${i + 1}. *${escapeMd(c.name)}* (${c.supportCount} appuis)`).join("\n") +
    `\n\nLe vote se déroulera pendant la période de vote configurée (VOTING_PERIOD_DAYS). Confirmez pour lancer :`,
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

    await ctx.answerCallbackQuery({ text: "Scrutin publié!" });
    await ctx.reply(
      `🎉 *SCRUTIN OUVERT AVEC SUCCÈS!*\n\n` +
      `*Titre :* ${escapeMd(ballot.title)}\n` +
      `*Candidats :* ${ballot.candidates.map((c) => escapeMd(c.creatorName)).join(", ")}\n` +
      `*Clôture :* ${formatTorontoDate(ballot.closesAt, { dateStyle: "medium", timeStyle: "short" })}`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("🗳️ Admin du vote", "admin:voting_menu"),
      }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.answerCallbackQuery({ text: `Échec : ${msg}`, show_alert: true });
  }
});

// Close Ballot Early
adminComposer.callbackQuery(/^admin:close_ballot:([a-f0-9-]+)$/, async (ctx) => {
  const ballotId = ctx.match[1];
  const { closeAndFinalizeBallot } = await import("../../voting/service.ts");

  await ctx.answerCallbackQuery({ text: "Clôture du scrutin et décompte des votes..." });

  try {
    const summary = await closeAndFinalizeBallot(ballotId, ctx.api);

    await ctx.reply(
      `📊 *SCRUTIN CLOS!*\n\n` +
      `*Total des votes exprimés :* ${summary.totalVotes}\n` +
      `*Participation :* ${summary.eligibleTurnoutPct}%\n` +
      `*Résultat :* ${summary.isTie ? "ÉGALITÉ (second tour prévu)" : (summary.winner ? `Gagnant : *${escapeMd(summary.winner.creatorName)}*` : "Aucun vote exprimé")}\n\n` +
      `*Décompte par candidat :*\n` +
      summary.tally.map((t) => `• ${escapeMd(t.name)}: ${t.votes} votes`).join("\n"),
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("🗳️ Admin du vote", "admin:voting_menu"),
      }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.reply(`⚠️ Échec de la clôture du scrutin : ${msg}`);
  }
});

