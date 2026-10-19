/**
 * LA CONFRÉRIE — Media Message Inventory (UG-04)
 *
 * Stores ONLY message metadata (IDs, kind, album id) so a creator's
 * collection can later be copied between forums with Telegram's official
 * copyMessages. No media bytes or file_ids are stored outside Telegram.
 *
 * The Bot API cannot list a topic's history, so this inventory is built
 * from authorized uploads seen live (or manually indexed by an administrator).
 */

import { getKv } from "./kv.ts";
import { MediaIndexEntry } from "../types.ts";

export async function recordMediaIndex(entry: MediaIndexEntry): Promise<void> {
  const kv = await getKv();
  // Numeric key part => KV iterates in ascending message-ID order.
  await kv.set(["media_index", entry.creatorId, entry.messageId], entry);
}

export async function listMediaIndex(
  creatorId: string,
  location?: { chatId: number; topicId: number }
): Promise<MediaIndexEntry[]> {
  const kv = await getKv();
  const out: MediaIndexEntry[] = [];
  for await (const e of kv.list<MediaIndexEntry>({ prefix: ["media_index", creatorId] })) {
    const v = e.value;
    if (!v) continue;
    if (location && (v.chatId !== location.chatId || v.topicId !== location.topicId)) continue;
    out.push(v);
  }
  return out.sort((a, b) => a.messageId - b.messageId);
}

export async function countMediaIndex(creatorId: string): Promise<number> {
  return (await listMediaIndex(creatorId)).length;
}

/**
 * Parse Telegram topic message links of the form
 *   https://t.me/c/<chat>/<topicId>/<messageId>
 * Returns null for anything else. The topic segment is what lets us verify a
 * manually indexed message really belongs to the creator's topic.
 */
export function parseTopicMessageLink(
  link: string
): { chatId: number; topicId: number; messageId: number } | null {
  const m = link.trim().match(/^(?:https?:\/\/)?t\.me\/c\/(\d+)\/(\d+)\/(\d+)(?:\?.*)?$/i);
  if (!m) return null;
  return {
    chatId: Number(`-100${m[1]}`),
    topicId: Number(m[2]),
    messageId: Number(m[3]),
  };
}
