/**
 * LA CONFRÉRIE — Protected Telegram Spaces
 */

import { getConfig, getChatIdForSpace, getSpaceIdForChatId } from "../config.ts";
import { SPACE_DEFINITIONS, SPACE_IDS, SpaceId } from "../types.ts";

export { SPACE_DEFINITIONS, SPACE_IDS };
export type { SpaceId };

export function getChatId(spaceId: SpaceId): number {
  return getChatIdForSpace(spaceId, getConfig());
}

export function getSpaceFromChatId(chatId: number): SpaceId | null {
  return getSpaceIdForChatId(chatId, getConfig());
}

export function getSpaceTitle(spaceId: SpaceId): string {
  return SPACE_DEFINITIONS[spaceId]?.name ?? spaceId;
}
