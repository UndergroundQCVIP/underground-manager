/**
 * LA CONFRÉRIE — Update Idempotency Middleware
 *
 * Telegram redelivers an update when a webhook call times out or fails, and an
 * attacker who captured a request could replay it. Each update_id is therefore
 * processed at most once *successfully*:
 *
 *  - a claim ("processing") is taken atomically before the handlers run;
 *  - on success it becomes "done" (kept for a week, then expires);
 *  - if a handler throws, the claim is released so a redelivery (or manual
 *    replay) can run again — a transient failure never swallows the update;
 *  - a claim that has been "processing" for longer than the lease (the isolate
 *    died mid-update) may be taken over.
 *
 * Handlers must remain idempotent themselves (payments are, by charge id).
 */

import { Context, NextFunction } from "grammy";
import { getKv } from "../../db/kv.ts";

const DONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LEASE_MS = 2 * 60 * 1000;

interface UpdateClaim {
  state: "processing" | "done";
  at: number;
}

export async function idempotencyMiddleware(ctx: Context, next: NextFunction): Promise<void> {
  const updateId = ctx.update?.update_id;
  if (updateId === undefined || updateId === null) {
    await next();
    return;
  }

  const kv = await getKv();
  const key = ["processed_updates", updateId];
  const now = Date.now();

  const existing = await kv.get<UpdateClaim | number>(key);
  const current = existing.value;
  if (current !== null) {
    const claim: UpdateClaim =
      typeof current === "number" ? { state: "done", at: current } : current;
    if (claim.state === "done") return; // replay of a completed update
    if (now - claim.at < LEASE_MS) return; // still being handled elsewhere
    // stale lease: fall through and take over
  }

  const claimed = await kv
    .atomic()
    .check(existing)
    .set(key, { state: "processing", at: now } satisfies UpdateClaim, { expireIn: DONE_TTL_MS })
    .commit();
  if (!claimed.ok) return; // lost the race to a concurrent delivery

  try {
    await next();
  } catch (err) {
    await kv.delete(key).catch(() => {});
    throw err;
  }

  await kv.set(key, { state: "done", at: Date.now() } satisfies UpdateClaim, {
    expireIn: DONE_TTL_MS,
  });
}
