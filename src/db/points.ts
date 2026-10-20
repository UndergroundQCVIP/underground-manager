/**
 * LA CONFRÉRIE — Points ledger & profiles (UG-07)
 * One immutable entry per source event (idempotent key); per-user totals are
 * updated in the SAME atomic commit, so a retry can never double-count.
 */

import { getKv } from "./kv.ts";

export type PointsReason =
  | "payment"
  | "contribution_items"
  | "contribution_reward"
  | "referral_join"
  | "refund";

export interface PointsEntry {
  key: string; // idempotency key, e.g. "payment:<chargeId>"
  userId: number;
  points: number; // signed
  reason: PointsReason;
  month: string; // "YYYY-MM" the points belong to (Toronto time)
  at: string; // ISO
  ref?: string;
}

export interface PointsTotals {
  total: number;
  months: Record<string, number>;
  lastAt?: string;
}

export interface PointsProfile {
  showName: boolean; // default false = anonymous alias
}

export async function getPointsEntry(key: string): Promise<PointsEntry | null> {
  const kv = await getKv();
  return (await kv.get<PointsEntry>(["points_ledger", key])).value ?? null;
}

/** Records the entry once. Returns false if this source was already counted. */
export async function addPoints(entry: PointsEntry): Promise<boolean> {
  const kv = await getKv();
  for (let attempt = 0; attempt < 10; attempt++) {
    const ledger = await kv.get<PointsEntry>(["points_ledger", entry.key]);
    if (ledger.value) return false;
    const totalsRes = await kv.get<PointsTotals>(["points_total", entry.userId]);
    const t: PointsTotals = totalsRes.value ?? { total: 0, months: {} };
    const next: PointsTotals = {
      total: t.total + entry.points,
      months: { ...t.months, [entry.month]: (t.months[entry.month] ?? 0) + entry.points },
      lastAt: !t.lastAt || entry.at > t.lastAt ? entry.at : t.lastAt,
    };
    const res = await kv
      .atomic()
      .check(ledger)
      .check(totalsRes)
      .set(["points_ledger", entry.key], entry)
      .set(["points_total", entry.userId], next)
      .commit();
    if (res.ok) return true;
  }
  throw new Error(`Could not record points for ${entry.key} (write conflict)`);
}

export async function getTotals(userId: number): Promise<PointsTotals> {
  const kv = await getKv();
  return (await kv.get<PointsTotals>(["points_total", userId])).value ?? { total: 0, months: {} };
}

export async function listAllTotals(): Promise<{ userId: number; totals: PointsTotals }[]> {
  const kv = await getKv();
  const out: { userId: number; totals: PointsTotals }[] = [];
  for await (const e of kv.list<PointsTotals>({ prefix: ["points_total"] })) {
    if (e.value) out.push({ userId: e.key[1] as number, totals: e.value });
  }
  return out;
}

export async function getProfile(userId: number): Promise<PointsProfile> {
  const kv = await getKv();
  return (await kv.get<PointsProfile>(["points_profile", userId])).value ?? { showName: false };
}

export async function setShowName(userId: number, showName: boolean): Promise<void> {
  const kv = await getKv();
  await kv.set(["points_profile", userId], { showName });
}

export interface MonthlyPrize {
  month: string;
  winnerId: number;
  points: number;
  days: number;
  at: string;
}

export async function getPrize(month: string): Promise<MonthlyPrize | null> {
  const kv = await getKv();
  return (await kv.get<MonthlyPrize>(["points_prize", month])).value ?? null;
}

/** First writer wins: a month's prize can be reserved only once. */
export async function reservePrize(p: MonthlyPrize): Promise<boolean> {
  const kv = await getKv();
  return (await kv.atomic().check({ key: ["points_prize", p.month], versionstamp: null }).set(["points_prize", p.month], p).commit()).ok;
}
