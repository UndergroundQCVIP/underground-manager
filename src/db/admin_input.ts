/**
 * LA CONFRÉRIE — Pending administrator text input (UG-05)
 * A tiny, expiring "the next text message answers this prompt" marker.
 */

import { getKv } from "./kv.ts";
import { WantedRequestClass } from "../types.ts";

export type AdminInputRequest =
  | { type: "wanted_request"; nonce: string; field: "name" | "url" | "category"; entryId?: string; name?: string; profileUrl?: string; category?: WantedRequestClass }
  | { type: "custom_days"; contributionId: string }
  | { type: "rename_proposal"; contributionId: string }
  | { type: "reject_reason"; contributionId: string }
  | { type: "import_links"; creatorId: string };

const TTL_MS = 10 * 60 * 1000;

export async function requestAdminInput(adminId: number, req: AdminInputRequest, chatId = adminId): Promise<void> {
  const kv = await getKv();
  await kv.set(["admin_input", adminId, ...(chatId === adminId ? [] : [chatId])], req, { expireIn: TTL_MS });
}

export async function takeAdminInput(adminId: number, chatId = adminId): Promise<AdminInputRequest | null> {
  const kv = await getKv();
  const res = await kv.get<AdminInputRequest>(["admin_input", adminId, ...(chatId === adminId ? [] : [chatId])]);
  if (!res.value) return null;
  await kv.delete(["admin_input", adminId, ...(chatId === adminId ? [] : [chatId])]);
  return res.value;
}

export async function peekAdminInput(adminId: number, chatId = adminId): Promise<AdminInputRequest | null> {
  const kv = await getKv();
  return (await kv.get<AdminInputRequest>(["admin_input", adminId, ...(chatId === adminId ? [] : [chatId])])).value ?? null;
}
