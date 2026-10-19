/**
 * LA CONFRÉRIE — Access Synchronization & Removal Logic
 */

import { SPACE_IDS, SpaceId } from "../types.ts";
import { getChatId, getSpaceTitle } from "./spaces.ts";
import { hasAccessToSpace } from "../db/entitlements.ts";
import {
  getSyncState,
  listAllSyncedUserIds,
  recordSyncState,
} from "../db/sync.ts";
import { logAuditEvent } from "../db/audit.ts";

export interface SyncApiLike {
  getMe(): Promise<{ id: number; username?: string }>;
  getChatMember(
    chatId: number | string,
    userId: number
  ): Promise<{
    status: string;
    can_invite_users?: boolean;
    can_restrict_members?: boolean;
    can_manage_topics?: boolean;
  }>;
  banChatMember(
    chatId: number | string,
    userId: number,
    options?: { until_date?: number }
  ): Promise<boolean>;
  unbanChatMember(
    chatId: number | string,
    userId: number,
    options?: { only_if_banned?: boolean }
  ): Promise<boolean>;
}

export interface PermissionCheckResult {
  ok: boolean;
  chatId: number;
  spaceId: SpaceId;
  status: string;
  missingPermissions: string[];
}

export async function checkBotPermissions(
  api: SyncApiLike,
  spaceId: SpaceId
): Promise<PermissionCheckResult> {
  const chatId = getChatId(spaceId);
  const me = await api.getMe();
  const missing: string[] = [];

  try {
    const member = await api.getChatMember(chatId, me.id);
    if (member.status !== "administrator" && member.status !== "creator") {
      missing.push("Bot is not an administrator in this space");
    } else {
      if (member.can_invite_users === false) {
        missing.push("can_invite_users");
      }
      if (member.can_restrict_members === false) {
        missing.push("can_restrict_members");
      }
      // The Retro forum is also managed (topics created by the migration service).
      if (spaceId === "retro_collections" && member.can_manage_topics === false) {
        missing.push("can_manage_topics");
      }
    }

    const ok = missing.length === 0;
    if (!ok) {
      await logAuditEvent(
        "permission_check_failed",
        { spaceId, chatId, missingPermissions: missing, status: member.status },
        0
      );
    }

    return {
      ok,
      chatId,
      spaceId,
      status: member.status,
      missingPermissions: missing,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await logAuditEvent(
      "permission_check_failed",
      { spaceId, chatId, error: errorMsg },
      0
    );
    return {
      ok: false,
      chatId,
      spaceId,
      status: "error",
      missingPermissions: [errorMsg],
    };
  }
}

export interface RemoveMemberResult {
  success: boolean;
  skippedProtected: boolean;
  error?: string;
}

export async function removeMemberFromSpace(
  api: SyncApiLike,
  spaceId: SpaceId,
  userId: number
): Promise<RemoveMemberResult> {
  const chatId = getChatId(spaceId);

  try {
    // 1. Check member status to avoid kicking administrators or creators
    const chatMember = await api.getChatMember(chatId, userId);
    if (
      chatMember.status === "creator" ||
      chatMember.status === "administrator"
    ) {
      return { success: true, skippedProtected: true };
    }

    // 2. If user already left or was kicked, just update our sync record
    if (chatMember.status === "left" || chatMember.status === "kicked") {
      await recordSyncState({
        userId,
        spaceId,
        chatId,
        status: "removed",
        lastSyncAt: new Date().toISOString(),
      });
      return { success: true, skippedProtected: false };
    }

    // 3. Remove user: ban then immediately unban to allow future re-entry when eligible
    await api.banChatMember(chatId, userId);
    await api.unbanChatMember(chatId, userId, { only_if_banned: true });

    await recordSyncState({
      userId,
      spaceId,
      chatId,
      status: "removed",
      lastSyncAt: new Date().toISOString(),
    });

    await logAuditEvent(
      "member_removed",
      { spaceId, chatId, spaceTitle: getSpaceTitle(spaceId) },
      0,
      userId
    );

    return { success: true, skippedProtected: false };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await recordSyncState({
      userId,
      spaceId,
      chatId,
      status: "error",
      lastSyncAt: new Date().toISOString(),
      error: errorMsg,
    });
    return { success: false, skippedProtected: false, error: errorMsg };
  }
}

export interface ReconcileResult {
  checkedUsers: number;
  removedCount: number;
  errors: string[];
}

export async function reconcileAllMembers(
  api: SyncApiLike
): Promise<ReconcileResult> {
  const userIds = await listAllSyncedUserIds();
  let removedCount = 0;
  const errors: string[] = [];

  for (const userId of userIds) {
    for (const spaceId of SPACE_IDS) {
      try {
        const syncState = await getSyncState(userId, spaceId);
        // Only consider spaces where the user was previously admitted
        if (syncState && syncState.status === "admitted") {
          const eligible = await hasAccessToSpace(userId, spaceId);
          if (!eligible) {
            const removeRes = await removeMemberFromSpace(api, spaceId, userId);
            if (removeRes.success && !removeRes.skippedProtected) {
              removedCount++;
            } else if (removeRes.error) {
              errors.push(
                `Failed removing user ${userId} from ${spaceId}: ${removeRes.error}`
              );
            }
          }
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        errors.push(`Error checking user ${userId} for ${spaceId}: ${errorMsg}`);
      }
    }
  }

  await logAuditEvent(
    "reconciliation_run",
    { checkedUsers: userIds.length, removedCount, errorCount: errors.length },
    0
  );

  return {
    checkedUsers: userIds.length,
    removedCount,
    errors,
  };
}
