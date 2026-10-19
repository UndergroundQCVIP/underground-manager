/**
 * LA CONFRÉRIE — Telegram Stars Tracking & Holding Period Engine
 * Phase UG-03: Treasury, Expenses & Final Automation
 */

import { Api } from "grammy";
import { logAuditEvent } from "../db/audit.ts";
import {
  getStarReconciliationCheckpoint,
  getStarTransactionByTelegramId,
  getValuationConfig,
  listStarTransactions,
  recordStarTransaction,
  saveStarReconciliationCheckpoint,
  updateStarTransactionStatus,
} from "../db/treasury.ts";
import { Payment, StarTransactionRecord } from "../types.ts";
import { convertCurrency } from "./conversion.ts";

export const TWENTY_ONE_DAYS_MS = 21 * 24 * 60 * 60 * 1000;

/**
 * Record a Telegram Stars revenue transaction immediately when a payment occurs.
 * Automatically initiates the 21-day holding period.
 */
export async function trackSuccessfulPaymentStarsTx(
  payment: Payment,
  starsAmount: number
): Promise<StarTransactionRecord | null> {
  const valuation = await getValuationConfig();
  const txTimestamp = payment.createdAt || new Date().toISOString();
  const holdingPeriodEndsAt = new Date(
    new Date(txTimestamp).getTime() + TWENTY_ONE_DAYS_MS
  ).toISOString();

  // Valuation calculation
  const estimatedRewardUsdCents = Math.round(
    starsAmount * valuation.starsRewardValuationUsd * 100
  );
  const { convertedAmountMinor: estimatedRewardCadCents } = await convertCurrency(
    estimatedRewardUsdCents,
    "USD",
    "CAD"
  );

  const res = await recordStarTransaction({
    telegramTxId: payment.chargeId,
    userId: payment.userId,
    starsAmount,
    txType: "subscription",
    txTimestamp,
    associatedPaymentId: payment.id,
    holdingPeriodEndsAt,
    status: "pending",
    estimatedRewardUsdCents,
    estimatedRewardCadCents,
    source: "webhook_event",
    planId: payment.planId ?? "regular",
  });

  if (res.duplicate && res.record) {
    return res.record;
  }

  if (res.record) {
    await logAuditEvent(
      "star_tx_recorded",
      {
        telegramTxId: payment.chargeId,
        starsAmount,
        holdingPeriodEndsAt,
        estimatedRewardCadCents,
      },
      0,
      payment.userId
    );
  }

  return res.record ?? null;
}

/**
 * Check and advance all pending Star transactions whose 21-day holding period has elapsed.
 * Transitions status from "pending" to "withdrawable_estimate".
 */
export async function reconcileStarHoldingStatuses(): Promise<{
  transitionedCount: number;
  totalPendingCount: number;
  totalWithdrawableCount: number;
}> {
  const transactions = await listStarTransactions(1000);
  const now = Date.now();
  let transitionedCount = 0;
  let totalPendingCount = 0;
  let totalWithdrawableCount = 0;

  for (const tx of transactions) {
    if (tx.status === "pending") {
      const eligibilityTime = new Date(tx.holdingPeriodEndsAt).getTime();
      if (eligibilityTime <= now) {
        await updateStarTransactionStatus(tx.id, "withdrawable_estimate");
        transitionedCount++;
        totalWithdrawableCount++;
      } else {
        totalPendingCount++;
      }
    } else if (tx.status === "withdrawable_estimate") {
      totalWithdrawableCount++;
    }
  }

  return {
    transitionedCount,
    totalPendingCount,
    totalWithdrawableCount,
  };
}

/**
 * Reconcile Star transactions via Telegram Bot API (getStarTransactions).
 * Safely pages through Telegram transactions and deduplicates against internal records.
 */
export async function reconcileStarTransactionsFromApi(
  api: Api,
  options?: { limit?: number; forceReset?: boolean }
): Promise<{
  newTransactionsRecorded: number;
  duplicatesSkipped: number;
  currentOffset: number;
  errors: string[];
}> {
  const checkpoint = await getStarReconciliationCheckpoint();
  const offset = options?.forceReset ? 0 : checkpoint.offset;
  const limit = options?.limit ?? 50;

  let newTransactionsRecorded = 0;
  let duplicatesSkipped = 0;
  const errors: string[] = [];

  try {
    // Call Telegram Bot API getStarTransactions if available
    // deno-lint-ignore no-explicit-any
    const rawApi = (api as any).raw;
    if (typeof rawApi?.getStarTransactions === "function") {
      const result = await rawApi.getStarTransactions({ offset, limit });
      // Telegram returns StarTransactions object: { transactions: StarTransaction[] }
      const transactions = result?.transactions ?? [];

      const valuation = await getValuationConfig();

      for (const tx of transactions) {
        const telegramTxId = String(tx.id);
        const existing = await getStarTransactionByTelegramId(telegramTxId);
        if (existing) {
          duplicatesSkipped++;
          continue;
        }

        const starsAmount = Number(tx.amount || 0);
        const txDate = tx.date
          ? new Date(tx.date * 1000).toISOString()
          : new Date().toISOString();
        const holdingPeriodEndsAt = new Date(
          new Date(txDate).getTime() + TWENTY_ONE_DAYS_MS
        ).toISOString();

        const estimatedRewardUsdCents = Math.round(
          starsAmount * valuation.starsRewardValuationUsd * 100
        );
        const { convertedAmountMinor: estimatedRewardCadCents } = await convertCurrency(
          estimatedRewardUsdCents,
          "USD",
          "CAD"
        );

        // Status determination
        const isEligible = new Date(holdingPeriodEndsAt).getTime() <= Date.now();
        const status = isEligible ? "withdrawable_estimate" : "pending";

        const recRes = await recordStarTransaction({
          telegramTxId,
          userId: tx.source?.user?.id ?? undefined,
          starsAmount,
          txType: starsAmount < 0 ? "refund" : "subscription",
          txTimestamp: txDate,
          holdingPeriodEndsAt,
          status,
          estimatedRewardUsdCents,
          estimatedRewardCadCents,
          source: "telegram_api",
        });

        if (recRes.success) {
          newTransactionsRecorded++;
        } else {
          duplicatesSkipped++;
        }
      }

      const nextOffset = offset + transactions.length;
      await saveStarReconciliationCheckpoint({
        offset: nextOffset,
        lastReconciledAt: new Date().toISOString(),
        totalSyncedCount: checkpoint.totalSyncedCount + newTransactionsRecorded,
      });

      return {
        newTransactionsRecorded,
        duplicatesSkipped,
        currentOffset: nextOffset,
        errors,
      };
    } else {
      // Mock environment or unsupported API in mock
      return {
        newTransactionsRecorded: 0,
        duplicatesSkipped: 0,
        currentOffset: offset,
        errors: ["getStarTransactions is not supported by current API client"],
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(msg);
    return {
      newTransactionsRecorded,
      duplicatesSkipped,
      currentOffset: offset,
      errors,
    };
  }
}
