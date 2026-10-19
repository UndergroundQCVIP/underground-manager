/**
 * LA CONFRÉRIE — Legacy import job repository (UG-06)
 */

import { getKv } from "./kv.ts";
import { ImportJob } from "../types.ts";

export async function getImportJob(id: string): Promise<ImportJob | null> {
  const kv = await getKv();
  return (await kv.get<ImportJob>(["import_jobs", id])).value ?? null;
}

export async function saveImportJob(job: ImportJob): Promise<void> {
  const kv = await getKv();
  await kv.set(["import_jobs", job.id], { ...job, updatedAt: new Date().toISOString() });
}

export async function listImportJobs(): Promise<ImportJob[]> {
  const kv = await getKv();
  const out: ImportJob[] = [];
  for await (const e of kv.list<ImportJob>({ prefix: ["import_jobs"] })) if (e.value) out.push(e.value);
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Compare-and-set update; returns null if `allowed` statuses no longer match. */
export async function updateImportJob(
  id: string,
  allowed: ImportJob["status"][] | null,
  mutate: (j: ImportJob) => void
): Promise<ImportJob | null> {
  const kv = await getKv();
  for (let attempt = 0; attempt < 8; attempt++) {
    const cur = await kv.get<ImportJob>(["import_jobs", id]);
    if (!cur.value || (allowed && !allowed.includes(cur.value.status))) return null;
    const next = structuredClone(cur.value);
    mutate(next);
    next.updatedAt = new Date().toISOString();
    if ((await kv.atomic().check(cur).set(["import_jobs", id], next).commit()).ok) return next;
  }
  throw new Error(`Import ${id} could not be updated (write conflict)`);
}

/** Destination message ids are stored per batch (a job can cover thousands of messages). */
export async function saveImportBatchIds(jobId: string, batch: number, ids: number[]): Promise<void> {
  const kv = await getKv();
  await kv.set(["import_dest", jobId, batch], ids);
}

export async function listImportDestIds(jobId: string): Promise<number[]> {
  const kv = await getKv();
  const out: number[] = [];
  for await (const e of kv.list<number[]>({ prefix: ["import_dest", jobId] })) if (e.value) out.push(...e.value);
  return out;
}

export async function deleteImportBatchIds(jobId: string): Promise<void> {
  const kv = await getKv();
  for await (const e of kv.list({ prefix: ["import_dest", jobId] })) await kv.delete(e.key);
}
