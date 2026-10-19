/**
 * LA CONFRÉRIE — Administrator Settings (UG-05)
 * Settings → Membership Acquisition mode, Public Navigation, Rewards.
 * All routes use the "admin:" prefix and are therefore admin-only via adminRouteGuard.
 */

import { Composer, InlineKeyboard } from "grammy";
import { getConfig } from "../../config.ts";
import { adminRouteGuard } from "../middleware/auth.ts";
import { getSystemSettings, updateSystemSettings } from "../../db/settings.ts";
import { logAuditEvent } from "../../db/audit.ts";
import { MODE_LABELS, setMembershipMode } from "../../membership/mode.ts";
import { MembershipMode } from "../../types.ts";
import { LOBBY_SETUP_INSTRUCTIONS, syncNavigationMessages, SyncOutcome } from "../../navigation/service.ts";
import { getNavigationState } from "../../db/navigation.ts";

export const adminSettingsComposer = new Composer();
adminSettingsComposer.use(adminRouteGuard({ callbackPrefixes: ["admin:"], commands: [] }));

const MODE_CODES: Record<string, MembershipMode> = {
  co: "contribution_only",
  cs: "contributions_and_stars",
  so: "stars_only",
};

adminSettingsComposer.callbackQuery("admin:settings", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(`⚙️ *PARAMÈTRES*\n\nChoisissez une section :`, {
    parse_mode: "Markdown",
    reply_markup: new InlineKeyboard()
      .text("🔐 Mode d'adhésion", "admin:mode")
      .row()
      .text("🧭 Navigation publique", "admin:nav")
      .row()
      .text("🎁 Récompenses", "cadm:rewards")
      .row()
      .text("🩺 État du système", "admin:status")
      .row()
      .text("⬅️ Menu administrateur", "admin:menu"),
  });
});

async function showMode(ctx: { answerCallbackQuery: () => Promise<unknown>; editMessageText: (t: string, o: object) => Promise<unknown> }) {
  const s = await getSystemSettings();
  const mark = (m: MembershipMode, label: string) => `${s.membershipMode === m ? "• " : ""}${label}`;
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `🔐 *MODE D'ADHÉSION*\n\nMode actuel : *${MODE_LABELS[s.membershipMode]}*\n\n` +
    `• *Contributions seulement* — l'accès se gagne par des contributions approuvées; les nouveaux paiements en Étoiles sont masqués.\n` +
    `• *Contributions + Étoiles* — les deux moyens coexistent.\n` +
    `• *Étoiles seulement* — expérience d'abonnement d'origine; les récompenses de contribution sont désactivées` +
    `${s.contributionRewardsInStarsMode ? " (sauf activation explicite : ACTIVÉE)" : " sauf activation explicite"}.\n\n` +
    `_Changer de mode ne modifie ni les abonnements existants, ni la facturation récurrente, ni l'historique financier._`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text(mark("contribution_only", "Contributions seulement"), "admin:mode_set:co")
        .row()
        .text(mark("contributions_and_stars", "Contributions + Étoiles"), "admin:mode_set:cs")
        .row()
        .text(mark("stars_only", "Étoiles seulement"), "admin:mode_set:so")
        .row()
        .text(
          `${s.contributionRewardsInStarsMode ? "☑️" : "☐"} Récompenses permises en mode Étoiles seulement`,
          "admin:mode_rw"
        )
        .row()
        .text("⬅️ Paramètres", "admin:settings"),
    }
  );
}

adminSettingsComposer.callbackQuery("admin:mode", (ctx) => showMode(ctx));

adminSettingsComposer.callbackQuery(/^admin:mode_set:(co|cs|so)$/, async (ctx) => {
  const mode = MODE_CODES[ctx.match[1]];
  const before = (await getSystemSettings()).membershipMode;
  await setMembershipMode(mode);
  await logAuditEvent("membership_mode_changed", { from: before, to: mode }, ctx.from.id);
  // Public posts mention the active methods: refresh them (best effort, hash-compared).
  await syncNavigationMessages(ctx.api).catch(() => {});
  await showMode(ctx);
});

adminSettingsComposer.callbackQuery("admin:mode_rw", async (ctx) => {
  const s = await getSystemSettings();
  await updateSystemSettings({ contributionRewardsInStarsMode: !s.contributionRewardsInStarsMode });
  await showMode(ctx);
});

// ---- Public navigation ---------------------------------------------------------------------------

const OUTCOME: Record<SyncOutcome, string> = {
  not_configured: "⚪ non configuré",
  unchanged: "🟢 déjà à jour",
  published: "✅ publié",
  updated: "✅ mis à jour",
  error: "🔴 erreur",
};

adminSettingsComposer.callbackQuery("admin:nav", async (ctx) => {
  const c = getConfig();
  const nav = await getNavigationState();
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `🧭 *NAVIGATION PUBLIQUE*\n\n` +
    `• Groupe d'accueil public : ${c.TELEGRAM_PUBLIC_LOBBY_CHAT_ID ? "✅ configuré" : "⚪ non configuré"}` +
    `${c.TELEGRAM_PUBLIC_LOBBY_URL ? ` (${c.TELEGRAM_PUBLIC_LOBBY_URL})` : ""}\n` +
    `• Canal d'accueil (menu de bienvenue) : ${c.TELEGRAM_PUBLIC_WELCOME_CHAT_ID ? "✅ configuré" : "⚪ non configuré"}\n` +
    `• Répertoire public : ${c.PUBLIC_DIRECTORY_CHAT_ID ? "✅ configuré" : "⚪ non configuré"}\n` +
    `• Message d'accueil publié : ${nav.welcome ? "oui" : "non"} · message du groupe : ${nav.lobby ? "oui" : "non"}\n\n` +
    `Sans configuration, les boutons du robot et son menu d'information servent de solution de rechange.`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text("📣 Mettre à jour le menu d'accueil", "admin:nav_sync:welcome")
        .row()
        .text("📚 Mettre à jour les boutons du répertoire", "admin:nav_sync:directory")
        .row()
        .text("🔄 Synchroniser les messages d'information", "admin:nav_sync:all")
        .row()
        .text("ℹ️ Paramètres du groupe public", "admin:nav_lobby")
        .row()
        .text("⬅️ Paramètres", "admin:settings"),
    }
  );
});

adminSettingsComposer.callbackQuery("admin:nav_lobby", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(LOBBY_SETUP_INSTRUCTIONS, {
    parse_mode: "Markdown",
    reply_markup: new InlineKeyboard().text("⬅️ Navigation publique", "admin:nav"),
  });
});

adminSettingsComposer.callbackQuery(/^admin:nav_sync:(welcome|directory|all)$/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Synchronisation..." });
  const which = ctx.match[1];
  const res = await syncNavigationMessages(ctx.api, {
    force: true,
    only: which === "all" ? undefined : (which as "welcome" | "directory"),
  });
  await logAuditEvent("navigation_synced", { which, result: res }, ctx.from.id);
  await ctx.editMessageText(
    `🔄 *SYNCHRONISATION*\n\n` +
    `• Menu d'accueil : ${OUTCOME[res.welcome.outcome]}${res.welcome.error ? ` — ${res.welcome.error}` : ""}\n` +
    `• Groupe d'accueil : ${OUTCOME[res.lobby.outcome]}${res.lobby.error ? ` — ${res.lobby.error}` : ""}\n` +
    `• Boutons du répertoire : ${OUTCOME[res.directory.outcome]}${res.directory.error ? ` — ${res.directory.error}` : ""}`,
    { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("⬅️ Navigation publique", "admin:nav") }
  );
});
