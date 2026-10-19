/**
 * LA CONFRÉRIE — Referral Repository (UG-06)
 * Personal codes, first-touch attribution, and an idempotent bonus ledger.
 */

import { getKv } from "./kv.ts";
import { CollectionCategory } from "../types.ts";

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no look-alike characters

export interface ReferralAttribution {
  referrerId: number;
  refereeId: number;
  code: string;
  at: string;
}

export interface ReferralBonus {
  key: string; // "contribution:<id>" | "payment:<chargeId>"
  referrerId: number;
  refereeId: number;
  source: "contribution" | "payment";
  sourceRef: string;
  scopes: CollectionCategory[];
  days: number;
  status: "pending" | "applied";
  createdAt: string;
  appliedAt?: string;
}

function randomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

/** Each user has exactly one stable personal code, created on first request. */
export async function getOrCreateReferralCode(userId: number): Promise<string> {
  const kv = await getKv();
  const existing = await kv.get<string>(["referral_code", userId]);
  if (existing.value) return existing.value;

  for (let attempt = 0; attempt < 10; attempt++) {
    const code = randomCode();
    const res = await kv
      .atomic()
      .check({ key: ["referral_code", userId], versionstamp: null })
      .check({ key: ["referral_owner", code], versionstamp: null })
      .set(["referral_code", userId], code)
      .set(["referral_owner", code], userId)
      .commit();
    if (res.ok) return code;
    const again = await kv.get<string>(["referral_code", userId]);
    if (again.value) return again.value; // a concurrent request created it
  }
  throw new Error("Could not allocate a referral code");
}

export async function getReferralCodeOwner(code: string): Promise<number | null> {
  const kv = await getKv();
  return (await kv.get<number>(["referral_owner", code.toLowerCase()])).value ?? null;
}

export async function getReferralOf(refereeId: number): Promise<ReferralAttribution | null> {
  const kv = await getKv();
  return (await kv.get<ReferralAttribution>(["referral_of", refereeId])).value ?? null;
}

/** First touch wins and is permanent: the key can only ever be created once. */
export async function saveAttribution(a: ReferralAttribution): Promise<boolean> {
  const kv = await getKv();
  const res = await kv
    .atomic()
    .check({ key: ["referral_of", a.refereeId], versionstamp: null })
    .set(["referral_of", a.refereeId], a)
    .set(["referrals_by_referrer", a.referrerId, a.refereeId], a.at)
    .commit();
  return res.ok;
}

export async function countReferred(referrerId: number): Promise<number> {
  const kv = await getKv();
  let n = 0;
  for await (const _ of kv.list({ prefix: ["referrals_by_referrer", referrerId] })) n++;
  return n;
}

export async function getBonus(key: string): Promise<ReferralBonus | null> {
  const kv = await getKv();
  return (await kv.get<ReferralBonus>(["referral_bonus", key])).value ?? null;
}

export async function saveBonus(b: ReferralBonus): Promise<void> {
  const kv = await getKv();
  await kv.set(["referral_bonus", b.key], b);
}

export async function listBonuses(): Promise<ReferralBonus[]> {
  const kv = await getKv();
  const out: ReferralBonus[] = [];
  for await (const e of kv.list<ReferralBonus>({ prefix: ["referral_bonus"] })) {
    if (e.value) out.push(e.value);
  }
  return out;
}

/**
 * Reserve a bonus ledger entry (and, for Stars, advance the referee's cumulative total)
 * in ONE atomic commit. Returns false if this source was already recorded.
 */
export async function reserveBonus(
  bonus: ReferralBonus,
  starsDelta?: number
): Promise<{ reserved: boolean; days: number }> {
  const kv = await getKv();
  for (let attempt = 0; attempt < 10; attempt++) {
    const ledger = await kv.get<ReferralBonus>(["referral_bonus", bonus.key]);
    if (ledger.value) return { reserved: false, days: ledger.value.days };

    const atomic = kv.atomic().check(ledger);
    let days = bonus.days;
    if (starsDelta !== undefined) {
      const totalKey = ["referral_stars_total", bonus.refereeId];
      const total = await kv.get<number>(totalKey);
      const before = total.value ?? 0;
      const after = before + starsDelta;
      // 1 day per full 100 Stars, cumulative: remainders are never lost.
      days = Math.floor(after / 100) - Math.floor(before / 100);
      atomic.check(total).set(totalKey, after);
    }
    const stored: ReferralBonus = { ...bonus, days, status: days > 0 ? "pending" : "applied", appliedAt: days > 0 ? undefined : new Date().toISOString() };
    const res = await atomic.set(["referral_bonus", bonus.key], stored).commit();
    if (res.ok) return { reserved: true, days };
  }
  throw new Error("Could not record the referral bonus (write conflict)");
}
