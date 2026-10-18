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
    .text("⚙️ System Status", "admin:status")
    .row()
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
