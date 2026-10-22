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
  for (let attempt = 0; attempt < 10; attempt++) {
    const atomic = kv.atomic().set(["contributions", c.id], next);
    if (c.status === "collecting") atomic.set(["contrib_active", c.userId], c.id);
    else {
      const active = await kv.get<string>(["contrib_active", c.userId]);
      if (active.value === c.id) atomic.check(active).delete(active.key);
    }
    if ((await atomic.commit()).ok) return;
  }
  throw new Error("La contribution a changé pendant son enregistrement. Réessayez.");
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
  else {
    const active = await kv.get<string>(["contrib_active", next.userId]);
    if (active.value === id) atomic.check(active).delete(active.key);
  }
  if (next.items.length && (next.status === "collecting" || next.status === "pending")) atomic.set(["contribution_receipt_dirty", id], crypto.randomUUID());
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

/** Album routing survives Finish and isolates, so delayed updates cannot enter a new submission. */
export async function getAlbumContribution(userId: number, mediaGroupId: string): Promise<Contribution | null> {
  const kv = await getKv();
  const id = (await kv.get<string>(["contribution_album", userId, mediaGroupId])).value;
  const c = id ? await getContribution(id) : null;
  return c?.userId === userId ? c : null;
}

/** Append one distinct message atomically; keep late album members in their original pending submission. */
export async function appendContributionItem(snapshot: Contribution, item: import("../types.ts").ContributionItem): Promise<Contribution | null> {
  const kv = await getKv();
  const entry = await kv.get<Contribution>(["contributions", snapshot.id]);
  if (!entry.value || JSON.stringify(entry.value) !== JSON.stringify(snapshot)) return null;
  const next = structuredClone(entry.value);
  const pendingAlbum = next.status === "pending" && !!item.mediaGroupId && next.items.some(i => i.mediaGroupId === item.mediaGroupId);
  if (next.status !== "collecting" && !pendingAlbum) return null;
  if (next.items.some(i => i.messageId === item.messageId)) return null;
  const active = await kv.get<string>(["contrib_active", next.userId]);
  if (next.status === "collecting" && active.value !== next.id) return null;
  const atomic = kv.atomic().check(entry);
  if (next.status === "collecting") atomic.check(active);
  if (item.mediaGroupId) {
    const album = await kv.get<string>(["contribution_album", next.userId, item.mediaGroupId]);
    if (album.value && album.value !== next.id) return null;
    atomic.check(album).set(album.key, next.id, { expireIn: 7 * 86400000 });
  }
  next.items.push(item);
  next.lastMediaAt = Date.now();
  next.updatedAt = new Date().toISOString();
  if (pendingAlbum) {
    next.lateAlbumMessageIds = [...(next.lateAlbumMessageIds ?? []), item.messageId];
    if (next.proposal) next.proposal.identityRightsConfirmed = false;
    atomic.set(["contribution_review_dirty", next.id], crypto.randomUUID());
  }
  atomic.set(["contribution_receipt_dirty", next.id], crypto.randomUUID());
  return (await atomic.set(entry.key, next).commit()).ok ? next : null;
}
