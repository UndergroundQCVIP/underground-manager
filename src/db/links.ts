/**
 * Underground Manager — Cached Invite Links
 */

import { getKv } from "./kv.ts";
import { SpaceId } from "../types.ts";

export interface CachedInviteLink {
  spaceId: SpaceId;
  inviteLink: string;
  chatId: number;
  updatedAt: string;
}

export async function saveInviteLink(
  spaceId: SpaceId,
  chatId: number,
  inviteLink: string
): Promise<void> {
  const kv = await getKv();
  const entry: CachedInviteLink = {
    spaceId,
    chatId,
    inviteLink,
    updatedAt: new Date().toISOString(),
  };
  await kv.set(["invite_links", spaceId], entry);
}

export async function getInviteLink(
  spaceId: SpaceId
): Promise<CachedInviteLink | null> {
  const kv = await getKv();
  const res = await kv.get<CachedInviteLink>(["invite_links", spaceId]);
  return res.value ?? null;
}
