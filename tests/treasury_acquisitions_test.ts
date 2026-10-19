/**
 * LA CONFRÉRIE — Voting & Acquisition Treasury Integration Automated Tests
 * Phase UG-03: Treasury, Expenses & Final Automation
 */

import { assertEquals, assertRejects } from "@std/assert";
import { setupTestEnvironment } from "./test_helpers.ts";
import {
  createWantedCandidate,
  getWantedCandidate,
} from "../src/db/wanted.ts";
import { updateCandidatePricing, listExpenses } from "../src/db/expenses.ts";
import {
  approveCandidateAcquisition,
  confirmCandidateAcquisitionPaid,
  evaluateCandidateAffordability,
  recordWithdrawalWithSettlement,
} from "../src/treasury/service.ts";

Deno.test("TREASURY ACQUISITIONS — Candidate pricing and affordability check", async () => {
  await setupTestEnvironment();

  // Create candidate
  const candidate = await createWantedCandidate({
    name: "Elena",
    normalizedName: "elena",
    status: "selected",
    suggestedBy: 1001,
    supportCount: 25,
  });

  // Price candidate at $40.00 USD (which converts to approx $54.40 CAD)
  await updateCandidatePricing(candidate.id, {
    expectedPriceMinor: 4000,
    priceCurrency: "USD",
    expectedCadMinor: 5440,
    rightsVerified: true,
  });

  // Before any funds are settled, candidate is NOT affordable
  const affordBefore = await evaluateCandidateAffordability(candidate.id);
  assertEquals(affordBefore.affordable, false);
  assertEquals(affordBefore.shortfallMinor, 5440);

  // Attempting to approve must throw an error due to insufficient budget
  await assertRejects(async () => {
    await approveCandidateAcquisition(candidate.id, 111111);
  });

  // Settle $200.00 CAD (acquisitions allocation = $120.00 CAD = 12000 cents)
  await recordWithdrawalWithSettlement({
    starsQuantity: 10000,
    tonReceivedNano: 30_000_000_000,
    settlement: {
      settlementDate: new Date().toISOString(),
      amountExchangedTonNano: 30_000_000_000,
      currencyReceived: "CAD",
      netFundsReceivedMinor: 20000,
      effectiveRate: 6.67,
      feeMinor: 0,
    },
    adminId: 111111,
  });

  // Now candidate ($54.40) is affordable against $120.00 budget!
  const affordAfter = await evaluateCandidateAffordability(candidate.id);
  assertEquals(affordAfter.affordable, true);
  assertEquals(affordAfter.shortfallMinor, 0);
});

Deno.test("TREASURY ACQUISITIONS — Approving acquisition reserves budget via commitment and confirms payment", async () => {
  await setupTestEnvironment();

  // Settle $500.00 CAD (acquisitions allocation = $300.00 CAD = 30000 cents)
  await recordWithdrawalWithSettlement({
    starsQuantity: 25000,
    tonReceivedNano: 75_000_000_000,
    settlement: {
      settlementDate: new Date().toISOString(),
      amountExchangedTonNano: 75_000_000_000,
      currencyReceived: "CAD",
      netFundsReceivedMinor: 50000,
      effectiveRate: 6.67,
      feeMinor: 0,
    },
    adminId: 111111,
  });

  const candidate = await createWantedCandidate({
    name: "Chloe",
    normalizedName: "chloe",
    status: "selected",
    suggestedBy: 1002,
    supportCount: 30,
  });

  await updateCandidatePricing(candidate.id, {
    expectedPriceMinor: 2500,
    priceCurrency: "CAD",
    expectedCadMinor: 2500,
    rightsVerified: true,
  });

  // 1. Approve acquisition
  const approval = await approveCandidateAcquisition(candidate.id, 111111);
  assertEquals(approval.candidate.status, "acquisition_pending");
  assertEquals(approval.commitmentExpense.status, "committed");
  assertEquals(approval.commitmentExpense.cadAmountMinor, 2500);

  // 2. Confirm payment
  const paymentConfirm = await confirmCandidateAcquisitionPaid({
    candidateId: candidate.id,
    payer: "club_funds",
    adminId: 111111,
  });

  assertEquals(paymentConfirm.candidate.status, "acquired");
  assertEquals(paymentConfirm.expense.status, "paid");

  // Verify candidate in DB
  const fetchedCandidate = await getWantedCandidate(candidate.id);
  assertEquals(fetchedCandidate!.status, "acquired");

  // Verify commitment was turned to paid
  const expenses = await listExpenses({ candidateId: candidate.id });
  assertEquals(expenses.length, 1);
  assertEquals(expenses[0].status, "paid");
});
