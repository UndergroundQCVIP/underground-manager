/**
 * Underground Manager — Treasury Allocation Rules & Budget Calculations
 * Phase UG-03: Treasury, Expenses & Final Automation
 */

import { assertEquals, assertRejects } from "@std/assert";
import { setupTestEnvironment } from "./test_helpers.ts";
import {
  saveTreasuryAllocations,
  recordStarTransaction,
} from "../src/db/treasury.ts";
import {
  getTreasuryOverview,
  recordExpenseWithJournal,
  recordWithdrawalWithSettlement,
} from "../src/treasury/service.ts";

Deno.test("TREASURY ALLOCATIONS — Allocation percentages must sum to exactly 100%", async () => {
  await setupTestEnvironment();

  // Valid 70/20/10
  await saveTreasuryAllocations({
    acquisitionPct: 70,
    operationsPct: 20,
    reservePct: 10,
    effectiveDate: new Date().toISOString(),
  });

  // Invalid: sum = 95%
  await assertRejects(async () => {
    await saveTreasuryAllocations({
      acquisitionPct: 60,
      operationsPct: 20,
      reservePct: 15,
      effectiveDate: new Date().toISOString(),
    });
  });
});

Deno.test("TREASURY ALLOCATIONS — Pending Stars are never counted as settled cash or available budget", async () => {
  await setupTestEnvironment();

  // User pays 10,000 Stars (pending 21-day holding period)
  await recordStarTransaction({
    telegramTxId: "tx_stars_pending_01",
    starsAmount: 10000,
    txType: "subscription",
    txTimestamp: new Date().toISOString(),
    holdingPeriodEndsAt: new Date(Date.now() + 21 * 24 * 3600 * 1000).toISOString(),
    status: "pending",
    estimatedRewardUsdCents: 13000,
    estimatedRewardCadCents: 17680,
    source: "webhook_event",
  });

  const overview = await getTreasuryOverview();
  assertEquals(overview.totalStarsReceived, 10000);
  assertEquals(overview.pendingStars, 10000);

  // CRITICAL: Stars are NOT cash. Settled cash must be $0.00!
  assertEquals(overview.settledNetCashCadMinor, 0);
  assertEquals(overview.allocatedAcquisitionsCadMinor, 0);
  assertEquals(overview.availableAcquisitionBudgetCadMinor, 0);
});

Deno.test("TREASURY ALLOCATIONS — Completed withdrawal settlement credits cash and allocates 60/25/15", async () => {
  await setupTestEnvironment();

  // Record a completed withdrawal settlement of $1,000.00 CAD (100000 cents)
  await recordWithdrawalWithSettlement({
    starsQuantity: 50000,
    tonReceivedNano: 150_000_000_000, // 150 TON
    settlement: {
      settlementDate: new Date().toISOString(),
      amountExchangedTonNano: 150_000_000_000,
      currencyReceived: "CAD",
      netFundsReceivedMinor: 100000, // $1,000.00 CAD
      effectiveRate: 6.67,
      feeMinor: 0,
    },
    adminId: 111111,
  });

  const overview = await getTreasuryOverview();
  assertEquals(overview.settledNetCashCadMinor, 100000); // $1,000.00
  assertEquals(overview.allocatedAcquisitionsCadMinor, 60000); // 60% = $600.00
  assertEquals(overview.allocatedOperationsCadMinor, 25000); // 25% = $250.00
  assertEquals(overview.allocatedReserveCadMinor, 15000); // 15% = $150.00
  assertEquals(overview.availableAcquisitionBudgetCadMinor, 60000); // $600.00 available
});

Deno.test("TREASURY ALLOCATIONS — Available Acquisition Budget deducts paid expenses and commitments without double-subtraction", async () => {
  await setupTestEnvironment();

  // Settled cash: $1,000.00 CAD (Acquisitions allocation = $600.00)
  await recordWithdrawalWithSettlement({
    starsQuantity: 50000,
    tonReceivedNano: 150_000_000_000,
    settlement: {
      settlementDate: new Date().toISOString(),
      amountExchangedTonNano: 150_000_000_000,
      currencyReceived: "CAD",
      netFundsReceivedMinor: 100000,
      effectiveRate: 6.67,
      feeMinor: 0,
    },
    adminId: 111111,
  });

  // 1. Paid acquisition expense: $200.00 CAD
  await recordExpenseWithJournal({
    description: "Acquisition: Creator A",
    originalAmountMinor: 20000,
    originalCurrency: "CAD",
    category: "creator_subscription",
    status: "paid",
    payer: "club_funds",
    actorId: 111111,
  });

  // 2. Active commitment: $150.00 CAD
  await recordExpenseWithJournal({
    description: "Commitment: Creator B",
    originalAmountMinor: 15000,
    originalCurrency: "CAD",
    category: "creator_subscription",
    status: "committed",
    payer: "club_funds",
    actorId: 111111,
  });

  const overview = await getTreasuryOverview();
  assertEquals(overview.paidAcquisitionsCadMinor, 20000);
  assertEquals(overview.committedAcquisitionsCadMinor, 15000);

  // Available Budget = 60000 - 20000 - 15000 = 25000 cents ($250.00)
  assertEquals(overview.availableAcquisitionBudgetCadMinor, 25000);
});
