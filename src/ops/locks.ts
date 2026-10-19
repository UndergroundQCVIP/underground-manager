/**
 * LA CONFRÉRIE — Lightweight job lease (single-flight) on Deno KV.
 *
 * Deno.cron instances on different isolates/regions could overlap after a slow
 * run; the lease keeps a scheduled job single-flight. A crashed run's lease
 * simply expires.
 */

import { getKv } from "../db/kv.ts";

export async function withJobLease<T>(
  name: string,
  leaseMs: number,
  fn: () => Promise<T>
): Promise<{ ran: boolean; result?: T }> {
  const kv = await getKv();
  const key = ["job_lease", name];
  const holder = crypto.randomUUID();

  const current = await kv.get<{ holder: string; until: number }>(key);
  if (current.value && current.value.until > Date.now()) {
    return { ran: false };
  }

  const claimed = await kv
    .atomic()
    .check(current)
    .set(key, { holder, until: Date.now() + leaseMs }, { expireIn: leaseMs })
    .commit();
  if (!claimed.ok) return { ran: false };

  try {
    return { ran: true, result: await fn() };
  } finally {
    const now = await kv.get<{ holder: string }>(key);
    if (now.value?.holder === holder) await kv.delete(key);
  }
}
