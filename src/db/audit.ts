/**
 * Underground Manager — Audit Event Logging
 */

import { getKv } from "./kv.ts";
import { AuditEvent, AuditEventType } from "../types.ts";

export async function logAuditEvent(
  type: AuditEventType,
  details: Record<string, unknown>,
  actorId = 0,
  userId?: number
): Promise<AuditEvent> {
  const kv = await getKv();
  const id = crypto.randomUUID();
  const timestamp = new Date().toISOString();

  const event: AuditEvent = {
    id,
    type,
    userId,
    actorId,
    timestamp,
    details,
  };

  const atomic = kv.atomic();
  atomic.set(["audit_events", timestamp, id], event);

  if (userId) {
    atomic.set(["audit_events_by_user", userId, timestamp, id], event);
  }

  await atomic.commit();
  return event;
}

export async function listAuditEvents(limit = 50): Promise<AuditEvent[]> {
  const kv = await getKv();
  const iter = kv.list<AuditEvent>(
    { prefix: ["audit_events"] },
    { limit, reverse: true }
  );
  const events: AuditEvent[] = [];
  for await (const entry of iter) {
    if (entry.value) {
      events.push(entry.value);
    }
  }
  return events;
}

export async function getUserAuditEvents(
  userId: number,
  limit = 20
): Promise<AuditEvent[]> {
  const kv = await getKv();
  const iter = kv.list<AuditEvent>(
    { prefix: ["audit_events_by_user", userId] },
    { limit, reverse: true }
  );
  const events: AuditEvent[] = [];
  for await (const entry of iter) {
    if (entry.value) {
      events.push(entry.value);
    }
  }
  return events;
}
