/**
 * LA CONFRÉRIE — Payment Repository & Idempotency Storage
 */

import { getKv } from "./kv.ts";
import { Payment, PaymentStatus } from "../types.ts";

export interface RecordPaymentResult {
  success: boolean;
  duplicate: boolean;
  payment?: Payment;
  error?: string;
}

export async function recordPayment(
  data: Omit<Payment, "id" | "createdAt">
): Promise<RecordPaymentResult> {
  const kv = await getKv();

  // Check idempotency via telegram charge ID
  const existingIndex = await kv.get<string>(["payments_by_charge_id", data.chargeId]);
  if (existingIndex.value) {
    const existingPayment = await kv.get<Payment>(["payments", existingIndex.value]);
    return {
      success: false,
      duplicate: true,
      payment: existingPayment.value ?? undefined,
      error: `Duplicate payment charge ID: ${data.chargeId}`,
    };
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const payment: Payment = {
    ...data,
    id,
    createdAt: now,
  };

  const atomic = kv.atomic();
  // Atomic check to prevent race conditions on identical charge IDs
  atomic.check({ key: ["payments_by_charge_id", data.chargeId], versionstamp: null });
  atomic.set(["payments", id], payment);
  atomic.set(["payments_by_charge_id", data.chargeId], id);
  atomic.set(["payments_by_user", data.userId, id], payment);

  const res = await atomic.commit();
  if (!res.ok) {
    // Another concurrent request committed the same charge ID
    const retryIndex = await kv.get<string>(["payments_by_charge_id", data.chargeId]);
    if (retryIndex.value) {
      const existing = await kv.get<Payment>(["payments", retryIndex.value]);
      return {
        success: false,
        duplicate: true,
        payment: existing.value ?? undefined,
        error: `Concurrent duplicate payment charge ID: ${data.chargeId}`,
      };
    }
    return {
      success: false,
      duplicate: false,
      error: "Atomic commit failed while recording payment",
    };
  }

  return {
    success: true,
    duplicate: false,
    payment,
  };
}

export async function getPaymentByChargeId(chargeId: string): Promise<Payment | null> {
  const kv = await getKv();
  const index = await kv.get<string>(["payments_by_charge_id", chargeId]);
  if (!index.value) return null;
  const res = await kv.get<Payment>(["payments", index.value]);
  return res.value ?? null;
}

export async function getUserPayments(userId: number): Promise<Payment[]> {
  const kv = await getKv();
  const iter = kv.list<Payment>({ prefix: ["payments_by_user", userId] });
  const payments: Payment[] = [];
  for await (const entry of iter) {
    if (entry.value) {
      payments.push(entry.value);
    }
  }
  return payments.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

export async function listPayments(limit = 100): Promise<Payment[]> {
  const kv = await getKv();
  const iter = kv.list<Payment>({ prefix: ["payments"] }, { limit });
  const payments: Payment[] = [];
  for await (const entry of iter) {
    if (entry.value) {
      payments.push(entry.value);
    }
  }
  return payments;
}

export async function updatePaymentStatus(
  paymentId: string,
  status: PaymentStatus
): Promise<Payment | null> {
  const kv = await getKv();
  const res = await kv.get<Payment>(["payments", paymentId]);
  if (!res.value) return null;

  const updated: Payment = {
    ...res.value,
    status,
  };

  const atomic = kv.atomic();
  atomic.set(["payments", paymentId], updated);
  atomic.set(["payments_by_user", updated.userId, paymentId], updated);

  const commitRes = await atomic.commit();
  if (!commitRes.ok) {
    throw new Error(`Failed to update payment status for ${paymentId}`);
  }

  return updated;
}

export async function updatePaymentStatusByChargeId(
  chargeId: string,
  status: PaymentStatus
): Promise<Payment | null> {
  const payment = await getPaymentByChargeId(chargeId);
  if (!payment) return null;
  return await updatePaymentStatus(payment.id, status);
}


/** All payments (no limit) — used for tier revenue reporting. */
export async function listAllPayments(): Promise<Payment[]> {
  const kv = await getKv();
  const payments: Payment[] = [];
  for await (const entry of kv.list<Payment>({ prefix: ["payments"] })) {
    if (entry.value) payments.push(entry.value);
  }
  return payments;
}
