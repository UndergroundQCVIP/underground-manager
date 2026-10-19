/**
 * LA CONFRÉRIE — Access Synchronization & Removal Logic
 */

import { SPACE_IDS, SpaceId } from "../types.ts";
import { getChatId, getSpaceTitle } from "./spaces.ts";
import { getActiveUserEntitlements, hasAccessToSpace } from "../db/entitlements.ts";
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
  userId: number,
  options: {
    /**
     * Re-evaluated right before the ban, after the Telegram round-trip. Return
     * false to abort: the member renewed (or was granted access) while the
     * reconciliation run was in flight.
     */
    stillIneligible?: () => Promise<boolean>;
    /** A previous attempt failed part-way (e.g. ban succeeded, unban did not). */
    isRetry?: boolean;
  } = {}
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
      if (chatMember.status === "kicked" && options.isRetry) {
        // Our earlier ban succeeded but the unban did not: lift it so the member
        // can rejoin after renewing. Only done for bans this service created.
        await api.unbanChatMember(chatId, userId, { only_if_banned: true });
      }
      await recordSyncState({
        userId,
        spaceId,
        chatId,
        status: "removed",
        lastSyncAt: new Date().toISOString(),
      });
      return { success: true, skippedProtected: false };
    }

    // 3. Last-moment safety check against a concurrent renewal
    if (options.stillIneligible && !(await options.stillIneligible())) {
      return { success: true, skippedProtected: true };
    }

    // 4. Remove user: ban then immediately unban to allow future re-entry when eligible
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
    // One entitlement read per user (not per space). A failed read throws and the
    // user is skipped for this run — never treated as "no entitlement".
    let granted: Set<SpaceId>;
    try {
      const active = await getActiveUserEntitlements(userId);
      granted = new Set(active.flatMap((e) => e.spaces));
    } catch (err) {
      errors.push(`Could not read entitlements for user ${userId}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    for (const spaceId of SPACE_IDS) {
      try {
        if (granted.has(spaceId)) continue;

        const syncState = await getSyncState(userId, spaceId);
        // "admitted" members are removed; "error" means an earlier removal/admission
        // attempt failed and must be retried — otherwise a single transient Telegram
        // failure would leave an expired member inside forever.
        if (syncState && (syncState.status === "admitted" || syncState.status === "error")) {
          const removeRes = await removeMemberFromSpace(api, spaceId, userId, {
            isRetry: syncState.status === "error",
            stillIneligible: async () => !(await hasAccessToSpace(userId, spaceId)),
          });
          if (removeRes.success && !removeRes.skippedProtected) {
            removedCount++;
          } else if (removeRes.error) {
            errors.push(
              `Failed removing user ${userId} from ${spaceId}: ${removeRes.error}`
            );
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
