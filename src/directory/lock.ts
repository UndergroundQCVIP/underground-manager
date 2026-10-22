import { getKv } from "../db/kv.ts";

/** Shared by publication, page navigation and keyboard maintenance. */
export async function withDirectoryLock<T>(job: () => Promise<T>): Promise<{ ran: boolean; result?: T }> {
  const kv = await getKv();
  const key = ["directory_sync_lease"];
  const lease = await kv.get<string>(key);
  if (lease.value) return { ran: false };
  const token = crypto.randomUUID();
  if (!(await kv.atomic().check(lease).set(key, token, { expireIn: 300_000 }).commit()).ok) return { ran: false };
  try { return { ran: true, result: await job() }; }
  finally {
    const current = await kv.get<string>(key);
    if (current.value === token) await kv.atomic().check(current).delete(key).commit();
  }
}
