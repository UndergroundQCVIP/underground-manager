/**
 * LA CONFRÉRIE — Chat Join Request Verification & Processing
 */

import { getClubName } from "../config.ts";
import { SpaceId } from "../types.ts";
import { getSpaceFromChatId } from "./spaces.ts";
import { hasAccessToSpace } from "../db/entitlements.ts";
import { recordSyncState } from "../db/sync.ts";
import { logAuditEvent } from "../db/audit.ts";

export interface JoinRequestApiLike {
  approveChatJoinRequest(chatId: number | string, userId: number): Promise<boolean>;
  declineChatJoinRequest(chatId: number | string, userId: number): Promise<boolean>;
}

export interface JoinRequestPayload {
  chat: { id: number; title?: string };
  from: { id: number; first_name: string; username?: string };
}

export interface ProcessJoinRequestResult {
  approved: boolean;
  spaceId: SpaceId | null;
  userId: number;
  error?: string;
}

export async function processChatJoinRequest(
  api: JoinRequestApiLike,
  request: JoinRequestPayload
): Promise<ProcessJoinRequestResult> {
  const userId = request.from.id;
  const chatId = request.chat.id;
  const spaceId = getSpaceFromChatId(chatId);

  if (!spaceId) {
    // Unrecognized or unmanaged chat
    return {
      approved: false,
      spaceId: null,
      userId,
      error: `Chat ID ${chatId} is not a managed ${getClubName()} space.`,
    };
  }

  // Verify entitlement using immutable numeric user ID
  const isEligible = await hasAccessToSpace(userId, spaceId);

  if (isEligible) {
    try {
      await api.approveChatJoinRequest(chatId, userId);
      await recordSyncState({
        userId,
        spaceId,
        chatId,
        status: "admitted",
        lastSyncAt: new Date().toISOString(),
      });
      await logAuditEvent(
        "join_request_approved",
        { spaceId, chatId, username: request.from.username },
        0,
        userId
      );
      return { approved: true, spaceId, userId };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await recordSyncState({
        userId,
        spaceId,
        chatId,
        status: "error",
        lastSyncAt: new Date().toISOString(),
        error: msg,
      });
      return { approved: false, spaceId, userId, error: msg };
    }
  } else {
    try {
      await api.declineChatJoinRequest(chatId, userId);
      await recordSyncState({
        userId,
        spaceId,
        chatId,
        status: "rejected",
        lastSyncAt: new Date().toISOString(),
      });
      await logAuditEvent(
        "join_request_declined",
        { spaceId, chatId, username: request.from.username, reason: "no_valid_entitlement" },
        0,
        userId
      );
      return { approved: false, spaceId, userId };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { approved: false, spaceId, userId, error: msg };
    }
  }
}
