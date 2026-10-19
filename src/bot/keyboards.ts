/**
 * Underground Manager — Inline Keyboards
 */

import { InlineKeyboard } from "grammy";
import { getConfig } from "../config.ts";
import {
  COMPLIMENTARY_REASONS,
  ComplimentaryAccessLevel,
  ComplimentaryReason,
  SpaceId,
} from "../types.ts";
import { getSpaceTitle } from "../access/spaces.ts";

export function mainMenuKeyboard(isMember: boolean, isAdmin: boolean): InlineKeyboard {
  const config = getConfig();
  const kb = new InlineKeyboard();

  if (!isMember) {
    kb.text(`🌟 Joindre Underground (${config.STARS_PRICE_AMOUNT} Étoiles)`, "member:join").row();
  }

  kb.text("📋 Mon abonnement", "member:status")
    .text("🔓 Accéder à mes canaux", "member:channels")
    .row();

  kb.text("🎯 Liste de souhaits", "wanted:menu")
    .text("🗳️ Vote mensuel", "vote:open")
    .row();

  kb.text("💬 Aide et soutien", "member:support");

  if (isAdmin) {
    kb.row().text("🛠️ Administration", "admin:menu");
  }

  return kb;
}

export function subscribeKeyboard(): InlineKeyboard {
  const config = getConfig();
  return new InlineKeyboard()
    .text(`🌟 Payer ${config.STARS_PRICE_AMOUNT} Étoiles (30 jours)`, "member:pay_stars")
    .row()
    .text("⬅️ Menu principal", "member:home");
}

export function spacesKeyboard(
  spaces: { spaceId: SpaceId; url: string }[]
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const s of spaces) {
    kb.url(`👉 Joindre ${getSpaceTitle(s.spaceId)}`, s.url).row();
  }
  kb.text("⬅️ Menu principal", "member:home");
  return kb;
}

export function supportKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🌟 Joindre Underground", "member:join")
    .row()
    .text("⬅️ Menu principal", "member:home");
}

export function adminMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("👥 Membres", "admin:members_list")
    .text("🎁 Accès gracieux", "admin:grant_wizard")
    .row()
    .text("👩‍🎤 Répertoire de créateurs", "admin:creators_menu")
    .text("🎯 Liste de souhaits", "admin:wanted_menu")
    .row()
    .text("🗳️ Vote mensuel", "admin:voting_menu")
    .text("💰 Trésorerie et budget", "admin:treasury_menu")
    .row()
    .text("⚙️ État du système", "admin:status")
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
      "Collections VIP seulement (par défaut)",
      `admin:grant_spc:${userId}:${duration}:${reason}:vip_only`
    )
    .row()
    .text(
      "Collections VIP + Clavardage général",
      `admin:grant_spc:${userId}:${duration}:${reason}:vip_and_chat`
    )
    .row()
    .text(
      "Accès complet (VIP + Clavardage + Liste de souhaits)",
      `admin:grant_spc:${userId}:${duration}:${reason}:full`
    )
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

