/**
 * LA CONFRÉRIE — Contribution Repository (UG-04)
 * Stores message IDs of a member's submission (metadata only, never media).
 */

import { getKv } from "./kv.ts";
import { Contribution } from "../types.ts";

export async function getContribution(id: string): Promise<Contribution | null> {
  const kv = await getKv();
  return (await kv.get<Contribution>(["contributions", id])).value ?? null;
}

export async function saveContribution(c: Contribution): Promise<void> {
  const kv = await getKv();
  const next = { ...c, updatedAt: new Date().toISOString() };
  const atomic = kv.atomic().set(["contributions", c.id], next);
  if (c.status === "collecting") atomic.set(["contrib_active", c.userId], c.id);
  else atomic.delete(["contrib_active", c.userId]);
  await atomic.commit();
}

/** The member's open (collecting) session, if any. */
export async function getActiveContribution(userId: number): Promise<Contribution | null> {
  const kv = await getKv();
  const id = (await kv.get<string>(["contrib_active", userId])).value;
  if (!id) return null;
  const c = await getContribution(id);
  return c && c.status === "collecting" ? c : null;
}

export async function listContributions(status?: Contribution["status"]): Promise<Contribution[]> {
  const kv = await getKv();
  const out: Contribution[] = [];
  for await (const e of kv.list<Contribution>({ prefix: ["contributions"] })) {
    if (e.value && (!status || e.value.status === status)) out.push(e.value);
  }
  return out.sort((a, b) => (a.submittedAt ?? a.createdAt).localeCompare(b.submittedAt ?? b.createdAt));
}

/**
 * Atomically move a contribution between statuses (compare-and-set).
 * Returns the updated record, or null if the current status was not allowed —
 * this is what prevents a double approval from publishing twice.
 */
export async function transitionContribution(
  id: string,
  from: Contribution["status"][],
  mutate: (c: Contribution) => void,
  expected?: Contribution
): Promise<Contribution | null> {
  const kv = await getKv();
  const cur = await kv.get<Contribution>(["contributions", id]);
  if (!cur.value || !from.includes(cur.value.status) || (expected && JSON.stringify(cur.value) !== JSON.stringify(expected))) return null;
  const next: Contribution = structuredClone(cur.value);
  mutate(next);
  next.updatedAt = new Date().toISOString();
  const atomic = kv.atomic().check(cur).set(["contributions", id], next);
  if (next.status !== "collecting" && next.status !== "cancelled") atomic.set(["contribution_review_dirty", id], crypto.randomUUID());
  if (next.status === "collecting") atomic.set(["contrib_active", next.userId], id);
  else atomic.delete(["contrib_active", next.userId]);
  const res = await atomic.commit();
  return res.ok ? next : null;
}

/** Each moderator confirms only their own current reward choices. */
export type ModeratorRewardDraft = { scopes: import("../types.ts").RewardScope[]; days: number; nonce: string };
export async function getModeratorRewardDraft(id: string, adminId: number): Promise<ModeratorRewardDraft | null> {
  return (await (await getKv()).get<ModeratorRewardDraft>(["moderator_reward_draft", id, adminId])).value;
}
export async function setModeratorRewardDraft(id: string, adminId: number, patch: Partial<Pick<ModeratorRewardDraft, "scopes" | "days">>, defaultDays = 30): Promise<ModeratorRewardDraft> {
  const kv = await getKv();
  const key = ["moderator_reward_draft", id, adminId];
  for (let attempt = 0; attempt < 10; attempt++) {
    const old = await kv.get<ModeratorRewardDraft>(key);
    const draft = { scopes: patch.scopes ?? old.value?.scopes ?? [], days: patch.days ?? old.value?.days ?? defaultDays, nonce: crypto.randomUUID().slice(0, 8) };
    if ((await kv.atomic().check(old).set(key, draft, { expireIn: 3600000 }).commit()).ok) return draft;
  }
  throw new Error("Les choix ont changé. Réessayez.");
}

/** Append only against the exact collecting snapshot; concurrent album updates retry. */
export async function appendContributionItem(snapshot: Contribution, item: import("../types.ts").ContributionItem): Promise<Contribution | null> {
  const kv = await getKv();
  const entry = await kv.get<Contribution>(["contributions", snapshot.id]);
  if (!entry.value || entry.value.status !== "collecting" || JSON.stringify(entry.value) !== JSON.stringify(snapshot)) return null;
  const next = structuredClone(entry.value);
  next.items.push(item);
  next.updatedAt = new Date().toISOString();
  return (await kv.atomic().check(entry).set(entry.key, next).commit()).ok ? next : null;
}
