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

export function getCurrentMonthCycle(): string {
  const d = new Date();
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

export async function createWantedCandidate(
  data: Omit<WantedCandidate, "id" | "createdAt" | "updatedAt">
): Promise<WantedCandidate> {
  const kv = await getKv();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const candidate: WantedCandidate = {
    ...data,
    id,
    createdAt: now,
    updatedAt: now,
  };

  const atomic = kv.atomic();
  atomic.set(["wanted_candidates", id], candidate);
  atomic.set(["wanted_candidates_by_name", candidate.normalizedName], id);

  const res = await atomic.commit();
  if (!res.ok) {
    throw new Error(`Failed to commit wanted candidate: ${candidate.name}`);
  }

  return candidate;
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

export async function updateWantedStatus(
  id: string,
  status: WantedCandidateStatus,
  notes?: string,
  creatorId?: string
): Promise<WantedCandidate | null> {
  const kv = await getKv();
  const current = await getWantedCandidate(id);
  if (!current) return null;

  const now = new Date().toISOString();
  const updated: WantedCandidate = {
    ...current,
    status,
    notes: notes !== undefined ? notes : current.notes,
    creatorId: creatorId !== undefined ? creatorId : current.creatorId,
    updatedAt: now,
  };

  await kv.set(["wanted_candidates", id], updated);
  return updated;
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

  // 1. Check if user already supported or nominated in this monthly cycle
  const existingCycleSupport = await getUserSupportForCycle(cycleId, userId);
  if (existingCycleSupport) {
    return {
      success: false,
      alreadySupportedThisCycle: true,
      error: "You have already used your nomination or support selection for this monthly cycle.",
    };
  }

  // 2. Check if user already supported this specific candidate historically
  const candidateSupporterKey = ["candidate_supporters", candidateId, userId];
  const existingCandidateSupport = await kv.get(candidateSupporterKey);
  if (existingCandidateSupport.value) {
    return {
      success: false,
      alreadySupportedThisCandidate: true,
      error: "You have already supported this creator previously.",
    };
  }

  // 3. Retrieve candidate
  const candidateRes = await kv.get<WantedCandidate>(["wanted_candidates", candidateId]);
  const candidate = candidateRes.value;
  if (!candidate) {
    return { success: false, error: "Candidate not found." };
  }

  const supportId = crypto.randomUUID();
  const now = new Date().toISOString();

  const supportRecord: MemberSupportRecord = {
    id: supportId,
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

  const cycleKey = ["member_support_by_cycle", cycleId, userId];

  const atomic = kv.atomic();
  atomic.check({ key: cycleKey, versionstamp: null });
  atomic.check({ key: candidateSupporterKey, versionstamp: null });
  atomic.check({ key: ["wanted_candidates", candidateId], versionstamp: candidateRes.versionstamp });

  atomic.set(cycleKey, supportRecord);
  atomic.set(candidateSupporterKey, 1);
  atomic.set(["wanted_candidates", candidateId], updatedCandidate);

  const commitRes = await atomic.commit();
  if (!commitRes.ok) {
    return {
      success: false,
      error: "Concurrent support submission detected. Please try again.",
    };
  }

  return {
    success: true,
    candidate: updatedCandidate,
  };
}

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

  const mergedCount = target.supportCount + source.supportCount;
  const now = new Date().toISOString();

  const updatedTarget: WantedCandidate = {
    ...target,
    supportCount: mergedCount,
    updatedAt: now,
  };

  const atomic = kv.atomic();
  atomic.set(["wanted_candidates", target.id], updatedTarget);
  atomic.delete(["wanted_candidates", source.id]);
  atomic.delete(["wanted_candidates_by_name", source.normalizedName]);

  const res = await atomic.commit();
  if (!res.ok) {
    throw new Error(`Failed to merge candidate ${sourceId} into ${targetId}`);
  }

  return updatedTarget;
}
