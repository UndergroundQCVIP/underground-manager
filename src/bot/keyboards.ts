/**
 * LA CONFRÉRIE — Inline Keyboards
 */

import { InlineKeyboard } from "grammy";
import {
  COMPLIMENTARY_REASONS,
  ComplimentaryAccessLevel,
  ComplimentaryReason,
  MembershipMode,
  MembershipPlanId,
  SpaceId,
} from "../types.ts";
import { getPlan } from "../plans/plans.ts";
import { getSpaceTitle } from "../access/spaces.ts";

export function mainMenuKeyboard(
  isMember: boolean,
  isAdmin: boolean,
  plan: MembershipPlanId | "none" = "none",
  mode: MembershipMode = "contributions_and_stars"
): InlineKeyboard {
  const kb = new InlineKeyboard();

  kb.text("💎 Forfaits d'adhésion", "member:plans")
    .text("📋 Mon abonnement", "member:status")
    .row();

  if (plan === "regular" && getPlan("retro_plus").enabled && mode !== "contribution_only") {
    kb.text("⬆️ Passer à Retro Plus", "member:upgrade").row();
  }

  kb.text("📚 Répertoire des créateurs", "dir:all")
    .text("🎯 Suggestions et votes", "wanted:menu")
    .row();

  kb.text("🔎 Liste recherchée", "wreq:menu").row();
  kb.text("🔒 Collection Amateur", "member:amateur").row();

  kb.text("➕ Contribuer", "contrib:start").text("🤝 Parrainage", "ref:menu").row();
  kb.text("🏆 Classement", "lb:month").row();

  kb.text("💬 Clavardage général", "member:general_chat")
    .text("🗳️ Vote mensuel", "vote:open")
    .row();

  // Keep the route reachable on menus opened before a contribution was rewarded.
  // The handler always rechecks current entitlements before issuing any link.
  kb.text(isMember ? "🔓 Accéder à mes canaux" : "🔐 Vérifier mes accès", "member:channels").row();

  kb.text("💬 Aide et soutien", "member:support");

  if (isAdmin) {
    kb.row().text("🛠️ Administration", "admin:menu");
  }

  return kb;
}

/** Plan picker. Buttons adapt to the member's current plan. */
export function plansKeyboard(
  plan: MembershipPlanId | "none",
  mode: MembershipMode = "contributions_and_stars"
): InlineKeyboard {
  const kb = new InlineKeyboard();
  const regular = getPlan("regular");
  const retro = getPlan("retro_plus");
  const stars = mode !== "contribution_only";

  if (mode !== "stars_only") kb.text("➕ Contribuer pour gagner l'accès", "contrib:start").row();

  if (!stars) {
    // Contribution Only: no new Stars checkout. A paying Retro Plus member may still downgrade.
    if (plan === "retro_plus") kb.text("⬇️ Revenir à Regular au renouvellement", "member:downgrade").row();
  } else if (plan === "none") {
    if (regular.enabled) kb.text(`🌟 Regular — ${regular.priceStars} Étoiles`, "member:pay:regular").row();
    if (retro.enabled) kb.text(`🎞️ Retro Plus — ${retro.priceStars} Étoiles`, "member:pay:retro_plus").row();
  } else if (plan === "regular") {
    if (retro.enabled) kb.text(`⬆️ Passer à Retro Plus — ${retro.priceStars} Étoiles`, "member:upgrade").row();
  } else {
    kb.text("⬇️ Revenir à Regular au renouvellement", "member:downgrade").row();
  }
  kb.text("⬅️ Menu principal", "member:home");
  return kb;
}

export function subscribeKeyboard(mode: MembershipMode = "contributions_and_stars"): InlineKeyboard {
  return plansKeyboard("none", mode);
}

export function spacesKeyboard(
  spaces: { spaceId: SpaceId; url: string }[]
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const s of spaces) {
    kb.url(`👉 Joindre ${getSpaceTitle(s.spaceId)}`, s.url).row();
  }
  kb.text("🔄 Renouveler les liens", "member:channels:refresh").row();
  kb.text("⬅️ Menu principal", "member:home");
  return kb;
}

export function supportKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("💎 Forfaits d'adhésion", "member:plans")
    .row()
    .text("⬅️ Menu principal", "member:home");
}

export function adminMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🔒 Amateur — administration", "amateur:admin").row()
    .text("👥 Membres", "admin:roster:0")
    .text("🎁 Accès gracieux", "admin:grant_wizard")
    .row()
    .text("💎 Forfaits", "admin:plans")
    .text("👩‍🎤 Créateurs", "admin:creators_menu")
    .row()
    .text("🎞️ Passer à Retro", "mig:pick")
    .text("🚚 État des migrations", "mig:list")
    .row()
    .text("📚 Répertoire", "admin:sync_dir_menu")
    .text("💰 Trésorerie", "admin:treasury_menu")
    .row()
    .text("🎯 Suggestions et votes", "admin:wanted_menu")
    .text("🗳️ Vote mensuel", "admin:voting_menu")
    .row()
    .text("🔎 Gérer la liste recherchée", "wreq:admin:list:0")
    .row()
    .text("📥 Contributions", "cadm:hub")
    .text("⚙️ Paramètres", "admin:settings")
    .text("⬅️ Menu membre", "member:home");
}

export function grantDurationKeyboard(userId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("7 jours", `admin:grant_dur:${userId}:7`)
    .text("30 jours (par défaut)", `admin:grant_dur:${userId}:30`)
    .row()
    .text("90 jours", `admin:grant_dur:${userId}:90`)
    .text("365 jours", `admin:grant_dur:${userId}:365`)
    .row()
    .text("❌ Annuler", "admin:menu");
}

export function grantReasonKeyboard(userId: number, duration: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  const reasons: ComplimentaryReason[] = [
    "content_contribution",
    "partnership",
    "promotion",
    "admin_exception",
  ];

  for (const r of reasons) {
    kb.text(COMPLIMENTARY_REASONS[r], `admin:grant_rsn:${userId}:${duration}:${r}`).row();
  }

  kb.text("❌ Annuler", "admin:menu");
  return kb;
}

export function grantSpacesKeyboard(
  userId: number,
  duration: number,
  reason: ComplimentaryReason
): InlineKeyboard {
  return new InlineKeyboard()
    .text(
      "En activité + communauté (sans Retro)",
      `admin:grant_spc:${userId}:${duration}:${reason}:regular`
    )
    .row()
    .text(
      "Accès complet — en activité + Retro + communauté",
      `admin:grant_spc:${userId}:${duration}:${reason}:full`
    )
    .row()
    .text("🔐 Amateur + en activité + Retro + communautés", `admin:grant_spc:${userId}:${duration}:${reason}:amateur`)
    .row()
    .text("❌ Annuler", "admin:menu");
}

export function grantConfirmKeyboard(
  userId: number,
  duration: number,
  reason: ComplimentaryReason,
  level: ComplimentaryAccessLevel
): InlineKeyboard {
  return new InlineKeyboard()
    .text(
      "✅ Confirmer et accorder l'accès",
      `admin:grant_cfm:${userId}:${duration}:${reason}:${level}`
    )
    .row()
    .text("❌ Annuler", "admin:menu");
}

export function memberManageKeyboard(userId: number, entitlementId?: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (entitlementId) {
    kb.text("➕ Prolonger de 30 jours", `admin:extend_ent:${userId}:${entitlementId}:30`)
      .text("⛔ Révoquer l'accès", `admin:revoke_ent:${userId}:${entitlementId}`)
      .row();
  }
  kb.text("🎁 Accorder un accès gracieux", `admin:grant_dur:${userId}:30`).row();
  kb.text("⬅️ Menu admin", "admin:menu");
  return kb;
}

// ==============================================================================
// UG-03 Treasury Keyboards
// ==============================================================================

export function treasuryMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("➕ Ajouter une dépense", "admin:treasury_add_exp")
    .text("📋 Voir les dépenses", "admin:treasury_expenses")
    .row()
    .text("📤 Consigner un retrait", "admin:treasury_withdraw")
    .text("🔄 Rapprocher les Étoiles", "admin:treasury_reconcile")
    .row()
    .text("📊 Rapports mensuels", "admin:treasury_reports")
    .text("⚙️ Répartitions", "admin:treasury_allocations")
    .row()
    .text("⬅️ Menu admin", "admin:menu");
}

export function treasuryExpenseCategoryKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("Abonn. créateur", "admin:exp_cat:creator_subscription")
    .text("Contenu/licence", "admin:exp_cat:creator_content_license")
    .row()
    .text("Opérations", "admin:exp_cat:platform_operations")
    .text("Marketing", "admin:exp_cat:marketing")
    .row()
    .text("Frais de transaction", "admin:exp_cat:transaction_fees")
    .text("Autre", "admin:exp_cat:other")
    .row()
    .text("❌ Annuler", "admin:treasury_menu");
}

export function treasuryExpensePayerKeyboard(category: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("🏦 Fonds du club", `admin:exp_pyr:${category}:club_funds`)
    .text("👤 Admin (personnel)", `admin:exp_pyr:${category}:admin_personal`)
    .row()
    .text("❌ Annuler", "admin:treasury_menu");
}

export function treasuryReportsKeyboard(period: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("📢 Publier dans le canal", `admin:report_pub:${period}`)
    .text("🔍 Audit détaillé", `admin:report_audit:${period}`)
    .row()
    .text("⬅️ Menu trésorerie", "admin:treasury_menu");
}

export function treasuryAllocationsKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("60 % Acq. / 25 % Op. / 15 % Rés. (par défaut)", "admin:alloc_preset:60_25_15")
    .row()
    .text("70 % Acq. / 20 % Op. / 10 % Rés.", "admin:alloc_preset:70_20_10")
    .row()
    .text("50 % Acq. / 30 % Op. / 20 % Rés.", "admin:alloc_preset:50_30_20")
    .row()
    .text("⬅️ Menu trésorerie", "admin:treasury_menu");
}

