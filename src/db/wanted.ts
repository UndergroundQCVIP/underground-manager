/**
 * Underground Manager — Wanted List Repository
 * Manages creator acquisition nominations, supporter counts, and statuses.
 */

import { getKv } from "./kv.ts";
import {
  MemberSupportRecord,
  WantedCandidate,
  WantedCandidateStatus,
} from "../types.ts";
import { normalizeCreatorName } from "./creators.ts";
import { torontoMonthCycle } from "../util/time.ts";

/** Monthly nomination/voting cycle ("YYYY-MM") in America/Toronto local time. */
export function getCurrentMonthCycle(date: Date = new Date()): string {
  return torontoMonthCycle(date);
}

/**
 * Creates a candidate, unique by normalized name. If another request created the
 * same name first, that existing candidate is returned instead (`created: false`)
 * so concurrent duplicate nominations merge instead of splitting support.
 */
export async function createWantedCandidateOnce(
  data: Omit<WantedCandidate, "id" | "createdAt" | "updatedAt">
): Promise<{ candidate: WantedCandidate; created: boolean }> {
  const kv = await getKv();
  const normalizedName = normalizeCreatorName(data.name);
  const nameKey = ["wanted_candidates_by_name", normalizedName];

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const candidate: WantedCandidate = {
    ...data,
    normalizedName,
    id,
    createdAt: now,
    updatedAt: now,
  };

  const res = await kv
    .atomic()
    .check({ key: nameKey, versionstamp: null })
    .set(["wanted_candidates", id], candidate)
    .set(nameKey, id)
    .commit();

  if (res.ok) return { candidate, created: true };

  const existing = await getWantedCandidateByName(data.name);
  if (existing) return { candidate: existing, created: false };
  throw new Error(`Failed to commit wanted candidate: ${data.name}`);
}

export async function createWantedCandidate(
  data: Omit<WantedCandidate, "id" | "createdAt" | "updatedAt">
): Promise<WantedCandidate> {
  return (await createWantedCandidateOnce(data)).candidate;
}

export async function getWantedCandidate(
  id: string
): Promise<WantedCandidate | null> {
  const kv = await getKv();
  const res = await kv.get<WantedCandidate>(["wanted_candidates", id]);
  return res.value ?? null;
}

export async function getWantedCandidateByName(
  name: string
): Promise<WantedCandidate | null> {
  const normalized = normalizeCreatorName(name);
  const kv = await getKv();
  const idRes = await kv.get<string>(["wanted_candidates_by_name", normalized]);
  if (!idRes.value) return null;
  return getWantedCandidate(idRes.value);
}

export async function listWantedCandidates(filter?: {
  status?: WantedCandidateStatus;
}): Promise<WantedCandidate[]> {
  const kv = await getKv();
  const iter = kv.list<WantedCandidate>({ prefix: ["wanted_candidates"] });
  const results: WantedCandidate[] = [];

  for await (const entry of iter) {
    const candidate = entry.value;
    if (!candidate) continue;

    if (filter?.status && candidate.status !== filter.status) {
      continue;
    }
    results.push(candidate);
  }

  // Sort by supportCount descending, then alphabetically by name
  return results.sort((a, b) => {
    if (b.supportCount !== a.supportCount) {
      return b.supportCount - a.supportCount;
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

/** Compare-and-set patch of a candidate (retries on write conflicts). */
export async function patchWantedCandidate(
  id: string,
  patch: Partial<Omit<WantedCandidate, "id" | "createdAt">>
): Promise<WantedCandidate | null> {
  const kv = await getKv();
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await kv.get<WantedCandidate>(["wanted_candidates", id]);
    if (!res.value) return null;

    const updated: WantedCandidate = {
      ...res.value,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    const commit = await kv
      .atomic()
      .check(res)
      .set(["wanted_candidates", id], updated)
      .commit();
    if (commit.ok) return updated;
  }
  throw new Error(`Candidate ${id} could not be updated (persistent write conflict)`);
}

export async function updateWantedStatus(
  id: string,
  status: WantedCandidateStatus,
  notes?: string,
  creatorId?: string
): Promise<WantedCandidate | null> {
  const patch: Partial<WantedCandidate> = { status };
  if (notes !== undefined) patch.notes = notes;
  if (creatorId !== undefined) patch.creatorId = creatorId;
  return await patchWantedCandidate(id, patch);
}

export async function getUserSupportForCycle(
  cycleId: string,
  userId: number
): Promise<MemberSupportRecord | null> {
  const kv = await getKv();
  const res = await kv.get<MemberSupportRecord>([
    "member_support_by_cycle",
    cycleId,
    userId,
  ]);
  return res.value ?? null;
}

export interface RecordSupportResult {
  success: boolean;
  candidate?: WantedCandidate;
  alreadySupportedThisCycle?: boolean;
  alreadySupportedThisCandidate?: boolean;
  error?: string;
}

export async function recordMemberSupport(
  cycleId: string,
  userId: number,
  candidateId: string,
  type: "nomination" | "support"
): Promise<RecordSupportResult> {
  const kv = await getKv();

  // Many members can back the same candidate at once; a lost compare-and-set on the
  // candidate's counter is retried (re-validating every rule) instead of failing the member.
  for (let attempt = 0; attempt < 25; attempt++) {
    // 1. One nomination/support selection per member per monthly cycle
    const cycleKey = ["member_support_by_cycle", cycleId, userId];
    if ((await kv.get(cycleKey)).value) {
      return {
        success: false,
        alreadySupportedThisCycle: true,
        error: "Vous avez déjà utilisé votre suggestion ou votre appui pour ce cycle mensuel.",
      };
    }

    // 2. A member backs a given creator only once, ever (unique supporter count)
    const candidateSupporterKey = ["candidate_supporters", candidateId, userId];
    if ((await kv.get(candidateSupporterKey)).value) {
      return {
        success: false,
        alreadySupportedThisCandidate: true,
        error: "Vous avez déjà appuyé ce créateur.",
      };
    }

    // 3. Retrieve candidate
    const candidateRes = await kv.get<WantedCandidate>(["wanted_candidates", candidateId]);
    const candidate = candidateRes.value;
    if (!candidate) {
      return { success: false, error: "Candidat introuvable." };
    }

    const now = new Date().toISOString();
    const supportRecord: MemberSupportRecord = {
      id: crypto.randomUUID(),
      cycleId,
      userId,
      candidateId,
      type,
      createdAt: now,
    };
    const updatedCandidate: WantedCandidate = {
      ...candidate,
      supportCount: candidate.supportCount + 1,
      updatedAt: now,
    };

    const commitRes = await kv
      .atomic()
      .check({ key: cycleKey, versionstamp: null })
      .check({ key: candidateSupporterKey, versionstamp: null })
      .check(candidateRes)
      .set(cycleKey, supportRecord)
      .set(candidateSupporterKey, 1)
      .set(["wanted_candidates", candidateId], updatedCandidate)
      .commit();

    if (commitRes.ok) {
      return { success: true, candidate: updatedCandidate };
    }
    await new Promise((resolve) => setTimeout(resolve, Math.random() * 6 * (attempt + 1)));
  }

  return {
    success: false,
    error: "La Liste de souhaits est très sollicitée en ce moment. Veuillez réessayer dans un instant.",
  };
}

/**
 * Merge `source` into `target`: supporters are re-keyed (deduplicated by user) and
 * the support count is the number of UNIQUE supporters, never a plain sum.
 */
export async function mergeWantedCandidates(
  sourceId: string,
  targetId: string
): Promise<WantedCandidate | null> {
  const kv = await getKv();
  const source = await getWantedCandidate(sourceId);
  const target = await getWantedCandidate(targetId);

  if (!source || !target || source.id === target.id) {
    return null;
  }

  const supporters = new Set<number>();
  let targetRecorded = 0;
  for await (const e of kv.list({ prefix: ["candidate_supporters", target.id] })) {
    supporters.add(e.key[2] as number);
    targetRecorded++;
  }
  const sourceSupporters: number[] = [];
  for await (const e of kv.list({ prefix: ["candidate_supporters", source.id] })) {
    sourceSupporters.push(e.key[2] as number);
  }
  // Counts without a per-user record (legacy/imported) cannot be de-duplicated
  // and are carried over as-is.
  const unrecorded =
    Math.max(0, target.supportCount - targetRecorded) +
    Math.max(0, source.supportCount - sourceSupporters.length);

  const atomic = kv.atomic();
  for (const userId of sourceSupporters) {
    supporters.add(userId);
    atomic.set(["candidate_supporters", target.id, userId], 1);
    atomic.delete(["candidate_supporters", source.id, userId]);
  }

  const now = new Date().toISOString();
  const updatedTarget: WantedCandidate = {
    ...target,
    supportCount: supporters.size + unrecorded,
    updatedAt: now,
  };

  atomic.set(["wanted_candidates", target.id], updatedTarget);
  atomic.delete(["wanted_candidates", source.id]);
  atomic.delete(["wanted_candidates_by_name", source.normalizedName]);

  const res = await atomic.commit();
  if (!res.ok) {
    throw new Error(`Failed to merge candidate ${sourceId} into ${targetId}`);
  }

  return updatedTarget;
}
