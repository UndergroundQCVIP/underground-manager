/**
 * LA CONFRÉRIE — Migration Job Repository (UG-04)
 * Jobs, per-message copy mappings, and an atomic execution lease.
 */

import { getKv } from "./kv.ts";
import { MigrationItem, MigrationJob } from "../types.ts";

const TERMINAL = new Set(["cancelled", "source_deleted"]);

export function isTerminalMigration(status: MigrationJob["status"]): boolean {
  return TERMINAL.has(status);
}

export async function getMigrationJob(id: string): Promise<MigrationJob | null> {
  const kv = await getKv();
  return (await kv.get<MigrationJob>(["migration_jobs", id])).value ?? null;
}

export async function createMigrationJob(job: MigrationJob): Promise<void> {
  const kv = await getKv();
  const res = await kv
    .atomic()
    .check({ key: ["migration_active_by_creator", job.creatorId], versionstamp: null })
    .set(["migration_jobs", job.id], job)
    .set(["migration_active_by_creator", job.creatorId], job.id)
    .commit();
  if (!res.ok) throw new Error(`An active migration already exists for creator ${job.creatorId}`);
}

export async function getActiveMigrationForCreator(creatorId: string): Promise<MigrationJob | null> {
  const kv = await getKv();
  const idRes = await kv.get<string>(["migration_active_by_creator", creatorId]);
  if (!idRes.value) return null;
  const job = await getMigrationJob(idRes.value);
  if (!job || isTerminalMigration(job.status)) return null;
  return job;
}

export async function listMigrationJobs(): Promise<MigrationJob[]> {
  const kv = await getKv();
  const out: MigrationJob[] = [];
  for await (const e of kv.list<MigrationJob>({ prefix: ["migration_jobs"] })) {
    if (e.value) out.push(e.value);
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Optimistic read-modify-write; retries on version conflicts. */
export async function updateMigrationJob(
  id: string,
  mutate: (job: MigrationJob) => MigrationJob | void
): Promise<MigrationJob> {
  const kv = await getKv();
  for (let attempt = 0; attempt < 8; attempt++) {
    const cur = await kv.get<MigrationJob>(["migration_jobs", id]);
    if (!cur.value) throw new Error(`Migration job ${id} not found`);
    const draft: MigrationJob = structuredClone(cur.value);
    const next = mutate(draft) ?? draft;
    next.updatedAt = new Date().toISOString();
    const atomic = kv.atomic().check(cur).set(["migration_jobs", id], next);
    if (isTerminalMigration(next.status)) {
      atomic.delete(["migration_active_by_creator", next.creatorId]);
    }
    const res = await atomic.commit();
    if (res.ok) return next;
  }
  throw new Error(`Could not update migration job ${id} (concurrent modification)`);
}

/** Acquire the exclusive execution lease; false if another runner holds it. */
export async function acquireMigrationLease(id: string, leaseMs: number): Promise<boolean> {
  const kv = await getKv();
  const cur = await kv.get<MigrationJob>(["migration_jobs", id]);
  if (!cur.value) return false;
  const now = Date.now();
  if (cur.value.lockedUntil && cur.value.lockedUntil > now) return false;
  const next: MigrationJob = { ...cur.value, lockedUntil: now + leaseMs };
  const res = await kv.atomic().check(cur).set(["migration_jobs", id], next).commit();
  return res.ok;
}

export async function releaseMigrationLease(id: string): Promise<void> {
  await updateMigrationJob(id, (j) => {
    j.lockedUntil = undefined;
  });
}

export async function saveMigrationItem(jobId: string, item: MigrationItem): Promise<void> {
  const kv = await getKv();
  await kv.set(["migration_items", jobId, item.sourceMessageId], item);
}

export async function listMigrationItems(jobId: string): Promise<MigrationItem[]> {
  const kv = await getKv();
  const out: MigrationItem[] = [];
  for await (const e of kv.list<MigrationItem>({ prefix: ["migration_items", jobId] })) {
    if (e.value) out.push(e.value);
  }
  return out.sort((a, b) => a.sourceMessageId - b.sourceMessageId);
}
