/**
 * Underground Manager — Treasury Stars Tracking & Holding Period Automated Tests
 * Phase UG-03: Treasury, Expenses & Final Automation
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import { setupTestEnvironment } from "./test_helpers.ts";
import {
  getStarTransactionByTelegramId,
  listStarTransactions,
  recordStarTransaction,
} from "../src/db/treasury.ts";
import {
  reconcileStarHoldingStatuses,
  trackSuccessfulPaymentStarsTx,
  TWENTY_ONE_DAYS_MS,
} from "../src/treasury/stars_tracking.ts";
import { Payment } from "../src/types.ts";

Deno.test("TREASURY STARS — Payment initiates transaction with 21-day holding period", async () => {
  await setupTestEnvironment();

  const mockPayment: Payment = {
    id: crypto.randomUUID(),
    userId: 1001,
    provider: "telegram_stars",
    chargeId: "chg_test_stars_001",
    providerChargeId: "tg_prod_001",
    amount: 750,
    currency: "XTR",
    invoicePayload: "{}",
    subscriptionPeriodSeconds: 2592000,
    isRecurring: true,
    status: "completed",
    createdAt: new Date().toISOString(),
  };

  const record = await trackSuccessfulPaymentStarsTx(mockPayment, 750);
  assertNotEquals(record, null);
  assertEquals(record!.status, "pending");
  assertEquals(record!.starsAmount, 750);
  assertEquals(record!.telegramTxId, "chg_test_stars_001");

  // Verify holding period is approximately 21 days from payment
  const txTime = new Date(record!.txTimestamp).getTime();
  const holdTime = new Date(record!.holdingPeriodEndsAt).getTime();
  assertEquals(holdTime - txTime, TWENTY_ONE_DAYS_MS);

  // Valuation should estimate rewards
  assertNotEquals(record!.estimatedRewardCadCents, 0);
});

Deno.test("TREASURY STARS — Duplicate transaction ID is safely ignored", async () => {
  await setupTestEnvironment();

  const mockPayment: Payment = {
    id: crypto.randomUUID(),
    userId: 1002,
    provider: "telegram_stars",
    chargeId: "chg_duplicate_test_002",
    providerChargeId: "tg_prod_002",
    amount: 750,
    currency: "XTR",
    invoicePayload: "{}",
    subscriptionPeriodSeconds: 2592000,
    isRecurring: true,
    status: "completed",
    createdAt: new Date().toISOString(),
  };

  const first = await trackSuccessfulPaymentStarsTx(mockPayment, 750);
  assertNotEquals(first, null);

  // Second attempt with exact same chargeId
  const second = await trackSuccessfulPaymentStarsTx(mockPayment, 750);
  assertNotEquals(second, null);
  assertEquals(second!.id, first!.id);

  const all = await listStarTransactions();
  assertEquals(all.length, 1);
});

Deno.test("TREASURY STARS — 21-day holding period advances status to withdrawable_estimate", async () => {
  await setupTestEnvironment();

  // Create an old transaction from 22 days ago
  const twentyTwoDaysAgo = new Date(Date.now() - 22 * 24 * 60 * 60 * 1000).toISOString();
  const holdPeriodEnd = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(); // Expired yesterday

  await recordStarTransaction({
    telegramTxId: "tx_old_eligible_003",
    userId: 1003,
    starsAmount: 750,
    txType: "subscription",
    txTimestamp: twentyTwoDaysAgo,
    holdingPeriodEndsAt: holdPeriodEnd,
    status: "pending",
    estimatedRewardUsdCents: 975,
    estimatedRewardCadCents: 1326,
    source: "webhook_event",
  });

  // Create a recent transaction from today
  const today = new Date().toISOString();
  const holdPeriodFuture = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString();

  await recordStarTransaction({
    telegramTxId: "tx_recent_pending_004",
    userId: 1004,
    starsAmount: 750,
    txType: "subscription",
    txTimestamp: today,
    holdingPeriodEndsAt: holdPeriodFuture,
    status: "pending",
    estimatedRewardUsdCents: 975,
    estimatedRewardCadCents: 1326,
    source: "webhook_event",
  });

  const reconciliation = await reconcileStarHoldingStatuses();
  assertEquals(reconciliation.transitionedCount, 1);
  assertEquals(reconciliation.totalPendingCount, 1);
  assertEquals(reconciliation.totalWithdrawableCount, 1);

  const eligibleTx = await getStarTransactionByTelegramId("tx_old_eligible_003");
  assertEquals(eligibleTx!.status, "withdrawable_estimate");

  const pendingTx = await getStarTransactionByTelegramId("tx_recent_pending_004");
  assertEquals(pendingTx!.status, "pending");
});
