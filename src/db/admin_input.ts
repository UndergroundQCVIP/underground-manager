/**
 * LA CONFRÉRIE — Pending administrator text input (UG-05)
 * A tiny, expiring "the next text message answers this prompt" marker.
 */

import { getKv } from "./kv.ts";

export type AdminInputRequest =
  | { type: "custom_days"; contributionId: string }
  | { type: "rename_proposal"; contributionId: string }
  | { type: "reject_reason"; contributionId: string };

const TTL_MS = 10 * 60 * 1000;

export async function requestAdminInput(adminId: number, req: AdminInputRequest): Promise<void> {
  const kv = await getKv();
  await kv.set(["admin_input", adminId], req, { expireIn: TTL_MS });
}

export async function takeAdminInput(adminId: number): Promise<AdminInputRequest | null> {
  const kv = await getKv();
  const res = await kv.get<AdminInputRequest>(["admin_input", adminId]);
  if (!res.value) return null;
  await kv.delete(["admin_input", adminId]);
  return res.value;
}

export async function peekAdminInput(adminId: number): Promise<AdminInputRequest | null> {
  const kv = await getKv();
  return (await kv.get<AdminInputRequest>(["admin_input", adminId])).value ?? null;
}
