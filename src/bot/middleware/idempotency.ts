/**
 * Underground Manager — Update Idempotency Middleware
 */

import { Context, NextFunction } from "grammy";
import { getKv } from "../../db/kv.ts";

export async function idempotencyMiddleware(ctx: Context, next: NextFunction): Promise<void> {
  const updateId = ctx.update?.update_id;
  if (!updateId) {
    await next();
    return;
  }

  const kv = await getKv();
  const key = ["processed_updates", updateId];
  const existing = await kv.get(key);

  if (existing.value) {
    // Already processed this update_id, safely ignore replay
    return;
  }

  // Atomically mark update_id as processed
  const commit = await kv.atomic().check({ key, versionstamp: null }).set(key, Date.now()).commit();
  if (!commit.ok) {
    // Another concurrent worker processed this update_id
    return;
  }

  await next();
}
