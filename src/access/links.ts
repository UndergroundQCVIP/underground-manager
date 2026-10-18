/**
 * Underground Manager — Secure Join Link Management
 */

import { SpaceId } from "../types.ts";
import { getChatId, getSpaceTitle } from "./spaces.ts";
import { getInviteLink, saveInviteLink } from "../db/links.ts";

export interface InviteApiLike {
  createChatInviteLink(
    chatId: number | string,
    options: { name?: string; creates_join_request?: boolean }
  ): Promise<{ invite_link: string }>;
}

export async function getOrCreateJoinLink(
  api: InviteApiLike,
  spaceId: SpaceId
): Promise<string> {
  // Check cached link first
  const cached = await getInviteLink(spaceId);
  const chatId = getChatId(spaceId);

  if (cached && cached.chatId === chatId && cached.inviteLink) {
    return cached.inviteLink;
  }

  // Generate a new secure link requiring bot approval
  const linkObj = await api.createChatInviteLink(chatId, {
    name: `Underground VIP — ${getSpaceTitle(spaceId)}`,
    creates_join_request: true,
  });

  await saveInviteLink(spaceId, chatId, linkObj.invite_link);
  return linkObj.invite_link;
}
