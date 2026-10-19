/**
 * LA CONFRÉRIE — Inline Keyboards
 */

import { InlineKeyboard } from "grammy";
import {
  COMPLIMENTARY_REASONS,
  ComplimentaryAccessLevel,
  ComplimentaryReason,
  MembershipPlanId,
  SpaceId,
} from "../types.ts";
import { getPlan } from "../plans/plans.ts";
import { getSpaceTitle } from "../access/spaces.ts";

export function mainMenuKeyboard(
  isMember: boolean,
  isAdmin: boolean,
  plan: MembershipPlanId | "none" = "none"
): InlineKeyboard {
  const kb = new InlineKeyboard();

  kb.text("💎 Membership Plans", "member:plans")
    .text("📋 My Membership", "member:status")
    .row();

  if (plan === "regular" && getPlan("retro_plus").enabled) {
    kb.text("⬆️ Upgrade to Retro Plus", "member:upgrade").row();
  }

  kb.text("📚 Creator Directory", "dir:all")
    .text("🎯 Wanted List", "wanted:menu")
    .row();

  kb.text("➕ Contribute", "contrib:start").row();

  kb.text("💬 General Chat", "member:general_chat")
    .text("🗳️ Monthly Vote", "vote:open")
    .row();

  if (isMember) {
    kb.text("🔓 Access My Channels", "member:channels").row();
  }

  kb.text("🆘 Support", "member:support");

  if (isAdmin) {
    kb.row().text("🛠️ Administration", "admin:menu");
  }

  return kb;
}

/** Plan picker. Buttons adapt to the member's current plan. */
export function plansKeyboard(plan: MembershipPlanId | "none"): InlineKeyboard {
  const kb = new InlineKeyboard();
  const regular = getPlan("regular");
  const retro = getPlan("retro_plus");

  if (plan === "none") {
    if (regular.enabled) kb.text(`🌟 Regular — ${regular.priceStars} Stars`, "member:pay:regular").row();
    if (retro.enabled) kb.text(`🎞️ Retro Plus — ${retro.priceStars} Stars`, "member:pay:retro_plus").row();
  } else if (plan === "regular") {
    if (retro.enabled) kb.text(`⬆️ Upgrade to Retro Plus — ${retro.priceStars} Stars`, "member:upgrade").row();
  } else {
    kb.text("⬇️ Switch to Regular at renewal", "member:downgrade").row();
  }
  kb.text("⬅️ Main Menu", "member:home");
  return kb;
}

export function subscribeKeyboard(): InlineKeyboard {
  return plansKeyboard("none");
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
    .text("💎 Membership Plans", "member:plans")
    .row()
    .text("⬅️ Main Menu", "member:home");
}

export function adminMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("👥 Members", "admin:members_list")
    .text("🎁 Complimentary", "admin:grant_wizard")
    .row()
    .text("💎 Membership Plans", "admin:plans")
    .text("👩‍🎤 Creators", "admin:creators_menu")
    .row()
    .text("🎞️ Move to Retro", "mig:pick")
    .text("🚚 Migration Status", "mig:list")
    .row()
    .text("📚 Directory", "admin:sync_dir_menu")
    .text("💰 Treasury", "admin:treasury_menu")
    .row()
    .text("🎯 Wanted List", "admin:wanted_menu")
    .text("🗳️ Monthly Voting", "admin:voting_menu")
    .row()
    .text("📥 Contributions", "cadm:queue")
    .text("⚙️ Settings", "admin:status")
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
    .text(
      "Full Access + Retro Vault",
      `admin:grant_spc:${userId}:${duration}:${reason}:full_retro`
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

