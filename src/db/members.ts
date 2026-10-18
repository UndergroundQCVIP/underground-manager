/**
 * Underground Manager — Member Repository
 */

import { getKv } from "./kv.ts";
import { Member } from "../types.ts";

export async function upsertMember(data: {
  id: number;
  username?: string;
  first_name: string;
  last_name?: string;
}): Promise<Member> {
  const kv = await getKv();
  const userId = data.id;
  const now = new Date().toISOString();

  const existingRes = await kv.get<Member>(["members", userId]);
  const existing = existingRes.value;

  const member: Member = {
    userId,
    username: data.username,
    firstName: data.first_name,
    lastName: data.last_name,
    firstSeenAt: existing ? existing.firstSeenAt : now,
    lastSeenAt: now,
    status: existing ? existing.status : "active",
  };

  const atomic = kv.atomic();
  atomic.set(["members", userId], member);
  atomic.set(["all_members_index", userId], 1);

  // If old username was different, clear old index
  if (existing?.username && existing.username.toLowerCase() !== data.username?.toLowerCase()) {
    atomic.delete(["members_by_username", existing.username.toLowerCase()]);
  }

  if (data.username) {
    atomic.set(["members_by_username", data.username.toLowerCase()], userId);
  }

  const commitRes = await atomic.commit();
  if (!commitRes.ok) {
    throw new Error(`Failed to commit member update for userId: ${userId}`);
  }

  return member;
}

export async function getMember(userId: number): Promise<Member | null> {
  const kv = await getKv();
  const res = await kv.get<Member>(["members", userId]);
  return res.value ?? null;
}

export async function getMemberByUsername(username: string): Promise<Member | null> {
  const cleanUsername = username.replace(/^@/, "").toLowerCase();
  const kv = await getKv();
  const indexRes = await kv.get<number>(["members_by_username", cleanUsername]);
  if (!indexRes.value) {
    return null;
  }
  return getMember(indexRes.value);
}

export async function listMembers(limit = 100): Promise<Member[]> {
  const kv = await getKv();
  const iter = kv.list<Member>({ prefix: ["members"] }, { limit });
  const members: Member[] = [];
  for await (const entry of iter) {
    if (entry.value) {
      members.push(entry.value);
    }
  }
  return members;
}

export async function countMembers(): Promise<number> {
  const kv = await getKv();
  const iter = kv.list({ prefix: ["all_members_index"] });
  let count = 0;
  for await (const _ of iter) {
    count++;
  }
  return count;
}
