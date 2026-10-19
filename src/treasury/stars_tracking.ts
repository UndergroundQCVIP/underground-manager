/**
 * Underground Manager — Telegram Stars Tracking & Holding Period Engine
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
 * Mark a Stars transaction (identified by Telegram charge id) as refunded so it
 * no longer counts as received/pending/withdrawable revenue.
 */
export async function markStarTransactionRefunded(
  telegramTxId: string
): Promise<StarTransactionRecord | null> {
  const existing = await getStarTransactionByTelegramId(telegramTxId);
  if (!existing) return null;
  if (existing.status === "refunded") return existing;
  return await updateStarTransactionStatus(existing.id, "refunded");
}

// Minimal structural view of Bot API StarTransaction (payment.d.ts).
interface ApiStarTransaction {
  id: string;
  amount: number;
  date: number;
  source?: { type: string; transaction_type?: string; user?: { id: number }; subscription_period?: number };
  receiver?: { type: string; user?: { id: number } };
}

const API_PAGE_LIMIT = 100;
const API_MAX_PAGES = 50;

/**
 * Reconcile Star transactions via the Telegram Bot API (getStarTransactions).
 *
 * Telegram returns the newest transactions first, so a numeric offset
 * checkpoint cannot be trusted (new transactions shift every older one). Each
 * run instead pages from offset 0 until it reaches a page of already-known
 * transactions; dedupe is by Telegram transaction id.
 *
 * Direction semantics (Bot API): `amount` is always positive. Incoming
 * transactions carry `source`; outgoing ones carry `receiver`. An outgoing
 * transaction to a user is a refund and shares the id of the original payment;
 * an outgoing transaction to Fragment is a withdrawal.
 */
export async function reconcileStarTransactionsFromApi(
  api: Api,
  options?: { limit?: number; forceReset?: boolean }
): Promise<{
  newTransactionsRecorded: number;
  duplicatesSkipped: number;
  refundsApplied: number;
  withdrawalsObserved: number;
  currentOffset: number;
  errors: string[];
}> {
  const checkpoint = await getStarReconciliationCheckpoint();
  const limit = Math.min(options?.limit ?? API_PAGE_LIMIT, API_PAGE_LIMIT);

  let newTransactionsRecorded = 0;
  let duplicatesSkipped = 0;
  let refundsApplied = 0;
  let withdrawalsObserved = 0;
  const errors: string[] = [];

  // deno-lint-ignore no-explicit-any
  const rawApi = (api as any).raw;
  if (typeof rawApi?.getStarTransactions !== "function") {
    return {
      newTransactionsRecorded: 0,
      duplicatesSkipped: 0,
      refundsApplied: 0,
      withdrawalsObserved: 0,
      currentOffset: 0,
      errors: ["getStarTransactions is not supported by current API client"],
    };
  }

  try {
    const valuation = await getValuationConfig();
    let offset = 0;

    for (let page = 0; page < API_MAX_PAGES; page++) {
      const result = await rawApi.getStarTransactions({ offset, limit });
      const transactions: ApiStarTransaction[] = result?.transactions ?? [];
      if (transactions.length === 0) break;

      let newInPage = 0;

      for (const tx of transactions) {
        const telegramTxId = String(tx.id);
        const amount = Math.abs(Number(tx.amount || 0));
        const txDate = tx.date
          ? new Date(tx.date * 1000).toISOString()
          : new Date().toISOString();
        const holdingPeriodEndsAt = new Date(
          new Date(txDate).getTime() + TWENTY_ONE_DAYS_MS
        ).toISOString();
        const existing = await getStarTransactionByTelegramId(telegramTxId);

        // Outgoing: refund to a user (same id as the original payment)
        if (tx.receiver?.type === "user") {
          if (existing) {
            if (existing.status !== "refunded") {
              await updateStarTransactionStatus(existing.id, "refunded");
              refundsApplied++;
              newInPage++;
            } else {
              duplicatesSkipped++;
            }
          } else {
            // Original payment never seen locally: store it already refunded
            // so it contributes nothing, and the refund is auditable.
            const rec = await recordStarTransaction({
              telegramTxId,
              userId: tx.receiver.user?.id,
              starsAmount: amount,
              txType: "refund",
              txTimestamp: txDate,
              holdingPeriodEndsAt,
              status: "refunded",
              estimatedRewardUsdCents: 0,
              estimatedRewardCadCents: 0,
              source: "telegram_api",
            });
            if (rec.success) {
              refundsApplied++;
              newInPage++;
            }
          }
          continue;
        }

        // Outgoing: withdrawal to Fragment (informational cross-check only)
        if (tx.receiver?.type === "fragment") {
          const key = `withdrawal:${telegramTxId}`;
          if (await getStarTransactionByTelegramId(key)) {
            duplicatesSkipped++;
            continue;
          }
          const rec = await recordStarTransaction({
            telegramTxId: key,
            starsAmount: -amount,
            txType: "withdrawal",
            txTimestamp: txDate,
            holdingPeriodEndsAt: txDate,
            status: "withdrawn",
            estimatedRewardUsdCents: 0,
            estimatedRewardCadCents: 0,
            source: "telegram_api",
          });
          if (rec.success) {
            withdrawalsObserved++;
            newInPage++;
          }
          continue;
        }

        // Any other outgoing transaction (ads, API fees, ...) is not revenue.
        if (tx.receiver) {
          const key = `outgoing:${telegramTxId}`;
          if (await getStarTransactionByTelegramId(key)) {
            duplicatesSkipped++;
            continue;
          }
          const rec = await recordStarTransaction({
            telegramTxId: key,
            starsAmount: -amount,
            txType: "adjustment",
            txTimestamp: txDate,
            holdingPeriodEndsAt: txDate,
            status: "withdrawn",
            estimatedRewardUsdCents: 0,
            estimatedRewardCadCents: 0,
            source: "telegram_api",
          });
          if (rec.success) newInPage++;
          continue;
        }

        // Incoming
        if (existing) {
          duplicatesSkipped++;
          continue;
        }

        const estimatedRewardUsdCents = Math.round(
          amount * valuation.starsRewardValuationUsd * 100
        );
        const { convertedAmountMinor: estimatedRewardCadCents } = await convertCurrency(
          estimatedRewardUsdCents,
          "USD",
          "CAD"
        );
        const isPayment = tx.source?.type === "user";
        const isEligible = new Date(holdingPeriodEndsAt).getTime() <= Date.now();

        const recRes = await recordStarTransaction({
          telegramTxId,
          userId: tx.source?.user?.id,
          starsAmount: amount,
          txType: isPayment
            ? tx.source?.subscription_period
              ? "subscription"
              : "invoice"
            : "adjustment",
          txTimestamp: txDate,
          holdingPeriodEndsAt,
          status: isEligible ? "withdrawable_estimate" : "pending",
          estimatedRewardUsdCents,
          estimatedRewardCadCents,
          source: "telegram_api",
        });

        if (recRes.success) {
          newTransactionsRecorded++;
          newInPage++;
        } else {
          duplicatesSkipped++;
        }
      }

      // Everything on this page was already known: older pages are known too.
      if (newInPage === 0 || transactions.length < limit) break;
      offset += transactions.length;
    }

    await saveStarReconciliationCheckpoint({
      offset: 0,
      lastReconciledAt: new Date().toISOString(),
      totalSyncedCount: checkpoint.totalSyncedCount + newTransactionsRecorded,
    });
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  return {
    newTransactionsRecorded,
    duplicatesSkipped,
    refundsApplied,
    withdrawalsObserved,
    currentOffset: 0,
    errors,
  };
}
