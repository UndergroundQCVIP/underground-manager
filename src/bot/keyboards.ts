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
    kb.text(`🌟 Join Underground (${config.STARS_PRICE_AMOUNT} Stars)`, "member:join").row();
  }

  kb.text("📋 My Membership", "member:status")
    .text("🔓 Access My Channels", "member:channels")
    .row();

  kb.text("🎯 Wanted List", "wanted:menu")
    .text("🗳️ Monthly Vote", "vote:open")
    .row();

  kb.text("💬 Help & Support", "member:support");

  if (isAdmin) {
    kb.row().text("🛠️ Administration", "admin:menu");
  }

  return kb;
}

export function subscribeKeyboard(): InlineKeyboard {
  const config = getConfig();
  return new InlineKeyboard()
    .text(`🌟 Pay ${config.STARS_PRICE_AMOUNT} Stars (30 Days)`, "member:pay_stars")
    .row()
    .text("⬅️ Main Menu", "member:home");
}

export function spacesKeyboard(
  spaces: { spaceId: SpaceId; url: string }[]
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const s of spaces) {
    kb.url(`👉 Join ${getSpaceTitle(s.spaceId)}`, s.url).row();
  }
  kb.text("⬅️ Main Menu", "member:home");
  return kb;
}

export function supportKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🌟 Join Underground", "member:join")
    .row()
    .text("⬅️ Main Menu", "member:home");
}

export function adminMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("👥 Members", "admin:members_list")
    .text("🎁 Complimentary", "admin:grant_wizard")
    .row()
    .text("👩‍🎤 Creator Directory", "admin:creators_menu")
    .text("🎯 Wanted List", "admin:wanted_menu")
    .row()
    .text("🗳️ Monthly Voting", "admin:voting_menu")
    .text("💰 Treasury & Budget", "admin:treasury_menu")
    .row()
    .text("⚙️ System Status", "admin:status")
    .text("⬅️ User Menu", "member:home");
}

export function grantDurationKeyboard(userId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("7 Days", `admin:grant_dur:${userId}:7`)
    .text("30 Days (Default)", `admin:grant_dur:${userId}:30`)
    .row()
    .text("90 Days", `admin:grant_dur:${userId}:90`)
    .text("365 Days", `admin:grant_dur:${userId}:365`)
    .row()
    .text("❌ Cancel", "admin:menu");
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

  kb.text("❌ Cancel", "admin:menu");
  return kb;
}

export function grantSpacesKeyboard(
  userId: number,
  duration: number,
  reason: ComplimentaryReason
): InlineKeyboard {
  return new InlineKeyboard()
    .text(
      "VIP Collections Only (Default)",
      `admin:grant_spc:${userId}:${duration}:${reason}:vip_only`
    )
    .row()
    .text(
      "VIP Collections + General Chat",
      `admin:grant_spc:${userId}:${duration}:${reason}:vip_and_chat`
    )
    .row()
    .text(
      "Full Access (VIP + Chat + Wanted List)",
      `admin:grant_spc:${userId}:${duration}:${reason}:full`
    )
    .row()
    .text("❌ Cancel", "admin:menu");
}

export function grantConfirmKeyboard(
  userId: number,
  duration: number,
  reason: ComplimentaryReason,
  level: ComplimentaryAccessLevel
): InlineKeyboard {
  return new InlineKeyboard()
    .text(
      "✅ Confirm & Grant Access",
      `admin:grant_cfm:${userId}:${duration}:${reason}:${level}`
    )
    .row()
    .text("❌ Cancel", "admin:menu");
}

export function memberManageKeyboard(userId: number, entitlementId?: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (entitlementId) {
    kb.text("➕ Extend 30 Days", `admin:extend_ent:${userId}:${entitlementId}:30`)
      .text("⛔ Revoke Access", `admin:revoke_ent:${userId}:${entitlementId}`)
      .row();
  }
  kb.text("🎁 Grant Complimentary", `admin:grant_dur:${userId}:30`).row();
  kb.text("⬅️ Admin Menu", "admin:menu");
  return kb;
}

// ==============================================================================
// UG-03 Treasury Keyboards
// ==============================================================================

export function treasuryMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("➕ Add Expense", "admin:treasury_add_exp")
    .text("📋 View Expenses", "admin:treasury_expenses")
    .row()
    .text("📤 Record Withdrawal", "admin:treasury_withdraw")
    .text("🔄 Reconcile Stars", "admin:treasury_reconcile")
    .row()
    .text("📊 Monthly Reports", "admin:treasury_reports")
    .text("⚙️ Allocations", "admin:treasury_allocations")
    .row()
    .text("⬅️ Admin Menu", "admin:menu");
}

export function treasuryExpenseCategoryKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("Creator Sub", "admin:exp_cat:creator_subscription")
    .text("Content/License", "admin:exp_cat:creator_content_license")
    .row()
    .text("Operations", "admin:exp_cat:platform_operations")
    .text("Marketing", "admin:exp_cat:marketing")
    .row()
    .text("Transaction Fees", "admin:exp_cat:transaction_fees")
    .text("Other", "admin:exp_cat:other")
    .row()
    .text("❌ Cancel", "admin:treasury_menu");
}

export function treasuryExpensePayerKeyboard(category: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("🏦 Club Funds", `admin:exp_pyr:${category}:club_funds`)
    .text("👤 Admin Personal", `admin:exp_pyr:${category}:admin_personal`)
    .row()
    .text("❌ Cancel", "admin:treasury_menu");
}

export function treasuryReportsKeyboard(period: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("📢 Publish to Channel", `admin:report_pub:${period}`)
    .text("🔍 Detailed Audit", `admin:report_audit:${period}`)
    .row()
    .text("⬅️ Treasury Menu", "admin:treasury_menu");
}

export function treasuryAllocationsKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("60% Acq / 25% Ops / 15% Res (Default)", "admin:alloc_preset:60_25_15")
    .row()
    .text("70% Acq / 20% Ops / 10% Res", "admin:alloc_preset:70_20_10")
    .row()
    .text("50% Acq / 30% Ops / 20% Res", "admin:alloc_preset:50_30_20")
    .row()
    .text("⬅️ Treasury Menu", "admin:treasury_menu");
}

