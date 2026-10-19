/**
 * Regression tests for defects found in the independent audit — UG-03 (treasury).
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { MOCK_CONFIG, setupTestEnvironment } from "./test_helpers.ts";
import { createFakeTelegram } from "./bot_harness.ts";
import {
  approveCandidateAcquisition,
  cancelCandidateAcquisition,
  cancelExpense,
  confirmCandidateAcquisitionPaid,
  getTreasuryOverview,
  recordExpenseWithJournal,
  recordWithdrawalWithSettlement,
  refundExpense,
  reimburseAdminExpense,
  settleWithdrawal,
} from "../src/treasury/service.ts";
import { convertToBaseCurrency, getRate } from "../src/treasury/conversion.ts";
import {
  getAllJournalBalances,
  listJournalEntries,
  recordStarTransaction,
  recordWithdrawal,
  saveTreasuryAllocations,
  listStarTransactions,
} from "../src/db/treasury.ts";
import { createWantedCandidate, getWantedCandidate } from "../src/db/wanted.ts";
import { listExpenses, updateCandidatePricing } from "../src/db/expenses.ts";
import { markStarTransactionRefunded, reconcileStarTransactionsFromApi } from "../src/treasury/stars_tracking.ts";
import { parseMoneyToMinor, parseTonToNano } from "../src/util/money.ts";
import { generateMonthlyTreasuryReport } from "../src/treasury/reports.ts";
import { TelegramStarsProvider } from "../src/payments/stars.ts";

const ADMIN = 111111;

async function settle(netMinor: number, ref?: string, stars = 1000) {
  return await recordWithdrawalWithSettlement({
    starsQuantity: stars,
    tonReceivedNano: 3_000_000_000,
    fragmentReference: ref,
    settlement: {
      settlementDate: new Date().toISOString(),
      amountExchangedTonNano: 3_000_000_000,
      currencyReceived: "CAD",
      netFundsReceivedMinor: netMinor,
      effectiveRate: 1,
      feeMinor: 0,
    },
    adminId: ADMIN,
  });
}

async function pricedCandidate(name: string, cad: number, status: "selected" | "requested" = "selected") {
  const c = await createWantedCandidate({ name, normalizedName: name.toLowerCase(), status, suggestedBy: 1, supportCount: 3 });
  await updateCandidatePricing(c.id, { expectedPriceMinor: cad, priceCurrency: "CAD", expectedCadMinor: cad });
  return c;
}

Deno.test("AUDIT MONEY — exact decimal parsing, no float drift or silent rounding", () => {
  assertEquals(parseMoneyToMinor("16"), 1600);
  assertEquals(parseMoneyToMinor("16.5"), 1650);
  assertEquals(parseMoneyToMinor("1.005"), null, "3 decimals is rejected, never rounded");
  assertEquals(parseMoneyToMinor("0.29"), 29); // 0.29 * 100 === 28.999999999999996 in floats
  assertEquals(parseMoneyToMinor("-5"), null);
  assertEquals(parseMoneyToMinor("abc"), null);
  assertEquals(parseTonToNano("12.5"), 12_500_000_000);
  assertEquals(parseTonToNano("0.000000001"), 1);
});

Deno.test("AUDIT TREASURY — settlement must be in the base currency and can only happen once", async () => {
  const kv = await setupTestEnvironment();
  try {
    await assertRejects(() =>
      recordWithdrawalWithSettlement({
        starsQuantity: 100, tonReceivedNano: 1_000_000_000, adminId: ADMIN,
        settlement: { settlementDate: new Date().toISOString(), amountExchangedTonNano: 1, currencyReceived: "USD",
          netFundsReceivedMinor: 5000, effectiveRate: 1, feeMinor: 0 },
      }), Error, "CAD");
    assertEquals((await getTreasuryOverview()).settledNetCashCadMinor, 0, "nothing credited by the rejected settlement");

    const w = await recordWithdrawalWithSettlement({ starsQuantity: 100, tonReceivedNano: 1_000_000_000, adminId: ADMIN });
    assertEquals(w.status, "requested");
    const settlement = { settlementDate: new Date().toISOString(), amountExchangedTonNano: 1, currencyReceived: "CAD",
      netFundsReceivedMinor: 5000, effectiveRate: 1, feeMinor: 0 };
    await Promise.allSettled([settleWithdrawal(w.id, settlement, ADMIN), settleWithdrawal(w.id, settlement, ADMIN)]);
    const o = await getTreasuryOverview();
    assertEquals(o.settledNetCashCadMinor, 5000, "credited once despite two concurrent attempts");
    assertEquals((await getAllJournalBalances()).settled_cash, 5000);
  } finally {
    await kv.close();
  }
});

Deno.test("AUDIT TREASURY — duplicate withdrawal reference and identical double-submit are refused", async () => {
  const kv = await setupTestEnvironment();
  try {
    await settle(10000, "FRAG-9");
    await assertRejects(() => settle(10000, "FRAG-9"), Error, "already recorded");
    await settle(7777); // first unreferenced one is fine
    await assertRejects(() => settle(7777), Error, "retrait identique");
    assertEquals((await getTreasuryOverview()).settledNetCashCadMinor, 10000 + 7777);
  } finally {
    await kv.close();
  }
});

Deno.test("AUDIT TREASURY — allocation percentages apply prospectively and are journaled", async () => {
  const kv = await setupTestEnvironment();
  try {
    await settle(10000, "A");
    await saveTreasuryAllocations({ acquisitionPct: 40, operationsPct: 40, reservePct: 20, effectiveDate: new Date().toISOString() });
    await settle(5000, "B", 500);
    const o = await getTreasuryOverview();
    assertEquals(o.allocatedAcquisitionsCadMinor, 6000 + 2000);
    assertEquals(o.allocatedOperationsCadMinor, 2500 + 2000);
    assertEquals(o.allocatedReserveCadMinor, 1500 + 1000);
    assertEquals(o.allocatedAcquisitionsCadMinor + o.allocatedOperationsCadMinor + o.allocatedReserveCadMinor, 15000);
    // odd cents never leak: the reserve takes the remainder
    await settle(1001, "C", 10);
    const o2 = await getTreasuryOverview();
    assertEquals(o2.allocatedAcquisitionsCadMinor + o2.allocatedOperationsCadMinor + o2.allocatedReserveCadMinor, 16001);
    const entries = await listJournalEntries();
    assert(entries.every((e) => e.id && e.timestamp), "append-only entries are fully stamped");
  } finally {
    await kv.close();
  }
});

Deno.test("AUDIT TREASURY — totals are never truncated by list limits", async () => {
  const kv = await setupTestEnvironment();
  try {
    for (let i = 0; i < 2100; i++) {
      await recordStarTransaction({
        telegramTxId: `bulk_${i}`, starsAmount: 10, txType: "subscription", txTimestamp: new Date().toISOString(),
        holdingPeriodEndsAt: new Date(Date.now() + 1e9).toISOString(), status: "pending",
        estimatedRewardUsdCents: 0, estimatedRewardCadCents: 0, source: "telegram_api",
      });
    }
    assertEquals((await getTreasuryOverview()).totalStarsReceived, 21000);
  } finally {
    await kv.close();
  }
});

Deno.test("AUDIT TREASURY — refunded Stars are excluded; only withdrawable Stars are marked withdrawn", async () => {
  const kv = await setupTestEnvironment();
  try {
    const mk = (id: string, status: "pending" | "withdrawable_estimate", ageDays: number) =>
      recordStarTransaction({
        telegramTxId: id, starsAmount: 100, txType: "subscription",
        txTimestamp: new Date(Date.now() - ageDays * 86400000).toISOString(),
        holdingPeriodEndsAt: new Date(Date.now() - ageDays * 86400000 + 21 * 86400000).toISOString(),
        status, estimatedRewardUsdCents: 0, estimatedRewardCadCents: 0, source: "webhook_event",
      });
    await mk("old", "withdrawable_estimate", 40);
    await mk("mid", "withdrawable_estimate", 30);
    await mk("new", "pending", 1);
    await markStarTransactionRefunded("mid");

    let o = await getTreasuryOverview();
    assertEquals(o.totalStarsReceived, 200);
    assertEquals(o.refundedStars, 100);

    await settle(1234, "W1", 300); // asks for more than is withdrawable
    o = await getTreasuryOverview();
    assertEquals(o.withdrawnStars, 100, "only the withdrawable (non-refunded) Stars");
    assertEquals(o.pendingStars, 100, "pending Stars are never marked withdrawn");
  } finally {
    await kv.close();
  }
});

Deno.test("AUDIT TREASURY — getStarTransactions: newest-first paging, refunds, withdrawals, idempotent re-runs", async () => {
  const kv = await setupTestEnvironment();
  try {
    const tg = await createFakeTelegram();
    const now = Math.floor(Date.now() / 1000);
    const incoming = (id: string, amount: number, ageSec: number) => ({
      id, amount, date: now - ageSec, source: { type: "user", transaction_type: "invoice_payment", user: { id: 42 }, subscription_period: 2592000 },
    });
    // Telegram returns newest first
    tg.starTransactions = [
      incoming("t3", 750, 10),
      { id: "w1", amount: 500, date: now - 20, receiver: { type: "fragment" } },
      { id: "t2", amount: 750, date: now - 30, receiver: { type: "user", user: { id: 42 } } }, // refund of t2
      incoming("t2", 750, 40),
      incoming("t1", 750, 50),
    ];
    const r1 = await reconcileStarTransactionsFromApi(tg.bot.api, { limit: 2 }); // forces several pages
    assertEquals(r1.errors, []);
    let o = await getTreasuryOverview();
    assertEquals(o.totalStarsReceived, 750 + 750, "t1 + t3; t2 was refunded");
    assertEquals(o.refundedStars, 750);
    assertEquals(o.telegramWithdrawnStars, 500);
    assertEquals(o.withdrawnStars, 0, "a Fragment withdrawal is not revenue");

    // A new payment appears at the TOP of the list: the old offset-checkpoint design missed these
    tg.starTransactions = [incoming("t4", 750, 1), ...(tg.starTransactions as unknown[])];
    const r2 = await reconcileStarTransactionsFromApi(tg.bot.api, { limit: 2 });
    assertEquals(r2.newTransactionsRecorded, 1);
    // and a third run changes nothing
    const r3 = await reconcileStarTransactionsFromApi(tg.bot.api, { limit: 2 });
    assertEquals(r3.newTransactionsRecorded + r3.refundsApplied + r3.withdrawalsObserved, 0);
    o = await getTreasuryOverview();
    assertEquals(o.totalStarsReceived, 750 * 3);
    assertEquals((await listStarTransactions()).filter((t) => t.telegramTxId === "t3").length, 1);
  } finally {
    await kv.close();
  }
});

Deno.test("AUDIT TREASURY — payments tracked via webhook and via API reconcile to ONE record", async () => {
  const kv = await setupTestEnvironment();
  try {
    const tg = await createFakeTelegram();
    const provider = new TelegramStarsProvider();
    await provider.handleSuccessfulPayment({
      currency: "XTR", total_amount: 750, invoice_payload: TelegramStarsProvider.buildInvoicePayload(5), telegram_payment_charge_id: "same_id",
      provider_payment_charge_id: "p",
    }, 5);
    tg.starTransactions = [{ id: "same_id", amount: 750, date: Math.floor(Date.now() / 1000), source: { type: "user", user: { id: 5 } } }];
    const r = await reconcileStarTransactionsFromApi(tg.bot.api);
    assertEquals(r.newTransactionsRecorded, 0);
    assertEquals((await getTreasuryOverview()).totalStarsReceived, 750);
  } finally {
    await kv.close();
  }
});

Deno.test("AUDIT TREASURY — currencies: unsupported/unknown rejected, provenance stored, rounding symmetric", async () => {
  const kv = await setupTestEnvironment();
  try {
    await assertRejects(() => recordExpenseWithJournal({
      description: "x", originalAmountMinor: 1000, originalCurrency: "JPY", category: "other",
      status: "paid", payer: "club_funds", actorId: ADMIN }), Error, "Devise non prise en charge");
    await assertRejects(() => getRate("XYZ", "CAD"), Error, "Aucun taux de change");
    await assertRejects(() => recordExpenseWithJournal({
      description: "x", originalAmountMinor: 1000, originalCurrency: "CAD", category: "bogus" as never,
      status: "paid", payer: "club_funds", actorId: ADMIN }), Error, "Catégorie");
    await assertRejects(() => recordExpenseWithJournal({
      description: "x", originalAmountMinor: 1000, originalCurrency: "CAD", category: "other",
      status: "paid", payer: "nobody" as never, actorId: ADMIN }), Error, "Payeur");

    const e = await recordExpenseWithJournal({
      description: "EU hosting", originalAmountMinor: 1999, originalCurrency: "eur", category: "platform_operations",
      status: "paid", payer: "club_funds", actorId: ADMIN });
    assertEquals(e.originalCurrency, "EUR");
    assert(e.fxRate && e.fxRate > 1, "EUR->CAD rate recorded");
    assert(e.fxRateSource, "rate source recorded");
    assertEquals(e.cadAmountMinor, Math.round(1999 * e.fxRate!));
    const c = await convertToBaseCurrency(1000, "USD");
    assertEquals(c.cadAmountMinor, 1360);
    assertEquals(c.usdAmountMinor, 1000);
  } finally {
    await kv.close();
  }
});

Deno.test("AUDIT TREASURY — refunds are linked adjustments; ledger and overview stay in agreement", async () => {
  const kv = await setupTestEnvironment();
  try {
    await settle(100000, "R");
    const e = await recordExpenseWithJournal({
      description: "Pack", originalAmountMinor: 5000, originalCurrency: "CAD", category: "creator_content_license",
      status: "paid", payer: "club_funds", actorId: ADMIN });
    const part = await refundExpense({ expenseId: e.id, amountMinor: 1500, actorId: ADMIN });
    assertEquals(part.adjustmentOfId, e.id);
    assertEquals(part.cadAmountMinor, -1500);
    let o = await getTreasuryOverview();
    assertEquals(o.paidAcquisitionsCadMinor, 3500);
    assertEquals(o.cashOnHandCadMinor, 100000 - 3500);

    await refundExpense({ expenseId: e.id, actorId: ADMIN }); // remainder
    await assertRejects(() => refundExpense({ expenseId: e.id, actorId: ADMIN }), Error, "entièrement remboursée");
    await assertRejects(() => refundExpense({ expenseId: e.id, amountMinor: 1, actorId: ADMIN }), Error);
    o = await getTreasuryOverview();
    assertEquals(o.paidAcquisitionsCadMinor, 0);
    assertEquals(o.availableAcquisitionBudgetCadMinor, 60000);
    const j = await getAllJournalBalances();
    assertEquals(j.acquisition_fund, o.allocatedAcquisitionsCadMinor - o.paidAcquisitionsCadMinor);
    assertEquals(j.settled_cash, o.cashOnHandCadMinor);
    // original record is untouched
    assertEquals((await listExpenses()).find((x) => x.id === e.id)!.status, "paid");
  } finally {
    await kv.close();
  }
});

Deno.test("AUDIT TREASURY — reimbursement happens exactly once and is net of refunds", async () => {
  const kv = await setupTestEnvironment();
  try {
    await settle(50000, "RB");
    const e = await recordExpenseWithJournal({
      description: "Personal", originalAmountMinor: 2000, originalCurrency: "CAD", category: "creator_subscription",
      status: "paid", payer: "admin_personal", paidByAdminId: ADMIN, actorId: ADMIN });
    await refundExpense({ expenseId: e.id, amountMinor: 500, actorId: ADMIN });
    let o = await getTreasuryOverview();
    assertEquals(o.adminReimbursementsOwedCadMinor, 1500);

    const results = await Promise.allSettled([reimburseAdminExpense(e.id, ADMIN), reimburseAdminExpense(e.id, ADMIN)]);
    assertEquals(results.filter((r) => r.status === "fulfilled").length, 1, "double click reimburses once");
    o = await getTreasuryOverview();
    assertEquals(o.adminReimbursementsOwedCadMinor, 0);
    assertEquals(o.cashOnHandCadMinor, 50000 - 1500);
    const j = await getAllJournalBalances();
    assertEquals(j.admin_liability, 0);
    assertEquals(j.settled_cash, 50000 - 1500);
  } finally {
    await kv.close();
  }
});

Deno.test("AUDIT ACQUISITIONS — unpriced, wrong-status and double approvals are refused; commitments never double count", async () => {
  const kv = await setupTestEnvironment();
  try {
    await settle(100000, "AQ"); // acquisitions budget = 60000
    const unpriced = await createWantedCandidate({ name: "NoPrice", normalizedName: "noprice", status: "selected", suggestedBy: 1, supportCount: 1 });
    await assertRejects(() => approveCandidateAcquisition(unpriced.id, ADMIN), Error, "pas de prix vérifié");

    const voting = await pricedCandidate("OnBallot", 1000);
    await updateCandidatePricing(voting.id, { expectedPriceMinor: 1000, priceCurrency: "CAD", expectedCadMinor: 1000 });
    const { updateWantedStatus } = await import("../src/db/wanted.ts");
    await updateWantedStatus(voting.id, "voting");
    await assertRejects(() => approveCandidateAcquisition(voting.id, ADMIN), Error, "ne peut pas être approuvé");

    const a = await pricedCandidate("A", 40000);
    const b = await pricedCandidate("B", 40000);
    // Both are individually affordable (60000) but not together: only one may be reserved,
    // even when approved at the same instant.
    const res = await Promise.allSettled([approveCandidateAcquisition(a.id, ADMIN), approveCandidateAcquisition(b.id, ADMIN)]);
    assertEquals(res.filter((r) => r.status === "fulfilled").length, 1);
    const o = await getTreasuryOverview();
    assertEquals(o.committedAcquisitionsCadMinor, 40000);

    // Re-approving the same candidate does not add a second commitment
    const winner = (res[0].status === "fulfilled" ? a : b);
    await assertRejects(() => approveCandidateAcquisition(winner.id, ADMIN));
    assertEquals((await getTreasuryOverview()).committedAcquisitionsCadMinor, 40000);

    // Cancelling releases the budget and returns the candidate to "selected"
    await cancelCandidateAcquisition(winner.id, ADMIN);
    assertEquals((await getTreasuryOverview()).committedAcquisitionsCadMinor, 0);
    assertEquals((await getWantedCandidate(winner.id))!.status, "selected");
    // and it can be approved again afterwards
    await approveCandidateAcquisition(winner.id, ADMIN);
    assertEquals((await getTreasuryOverview()).committedAcquisitionsCadMinor, 40000);
  } finally {
    await kv.close();
  }
});

Deno.test("AUDIT ACQUISITIONS — confirming payment is exactly-once, uses the ACTUAL amount, and books personal payments correctly", async () => {
  const kv = await setupTestEnvironment();
  try {
    await settle(100000, "AP");
    const c = await pricedCandidate("Real", 2500);
    await approveCandidateAcquisition(c.id, ADMIN);

    const first = await Promise.allSettled([
      confirmCandidateAcquisitionPaid({ candidateId: c.id, payer: "admin_personal", actualAmountMinor: 2800, currency: "CAD", adminId: ADMIN }),
      confirmCandidateAcquisitionPaid({ candidateId: c.id, payer: "admin_personal", actualAmountMinor: 2800, currency: "CAD", adminId: ADMIN }),
    ]);
    assertEquals(first.filter((r) => r.status === "fulfilled").length, 1, "second confirmation fails instead of double-posting");
    const expenses = await listExpenses({ candidateId: c.id });
    assertEquals(expenses.length, 1);
    assertEquals(expenses[0].status, "paid");
    assertEquals(expenses[0].cadAmountMinor, 2800, "actual price replaces the estimate");
    assertEquals(expenses[0].payer, "admin_personal");
    assertEquals(expenses[0].reimbursementStatus, "pending");

    const o = await getTreasuryOverview();
    assertEquals(o.paidAcquisitionsCadMinor, 2800);
    assertEquals(o.committedAcquisitionsCadMinor, 0);
    assertEquals(o.adminReimbursementsOwedCadMinor, 2800);
    assertEquals(o.cashOnHandCadMinor, 100000, "club cash untouched until reimbursed");

    await assertRejects(() => confirmCandidateAcquisitionPaid({ candidateId: c.id, payer: "club_funds", adminId: ADMIN }), Error, "déjà été acquis");
  } finally {
    await kv.close();
  }
});

Deno.test("AUDIT TREASURY — cancelled and planned expenses never count as spend", async () => {
  const kv = await setupTestEnvironment();
  try {
    await settle(10000, "CP");
    const planned = await recordExpenseWithJournal({ description: "later", originalAmountMinor: 900, originalCurrency: "CAD",
      category: "marketing", status: "planned", payer: "club_funds", actorId: ADMIN });
    assertEquals((await getTreasuryOverview()).totalPaidExpensesCadMinor, 0);
    await cancelExpense(planned.id, ADMIN);
    await assertRejects(() => cancelExpense(planned.id, ADMIN));
    assertEquals((await getTreasuryOverview()).totalPaidExpensesCadMinor, 0);
  } finally {
    await kv.close();
  }
});

Deno.test("AUDIT REPORTS — monthly report separates in-period flows from balances", async () => {
  const kv = await setupTestEnvironment();
  try {
    await settle(10000, "MR");
    await recordExpenseWithJournal({ description: "now", originalAmountMinor: 1000, originalCurrency: "CAD",
      category: "platform_operations", status: "paid", payer: "club_funds", actorId: ADMIN });
    await recordExpenseWithJournal({ description: "long ago", originalAmountMinor: 3000, originalCurrency: "CAD",
      category: "platform_operations", status: "paid", payer: "club_funds", actorId: ADMIN,
      expenseDate: "2020-01-15T12:00:00.000Z" });
    const thisMonth = await generateMonthlyTreasuryReport();
    assertEquals(thisMonth.periodActivity!.paidExpensesCadMinor, 1000);
    assertEquals(thisMonth.periodActivity!.settledCashCadMinor, 10000);
    const jan2020 = await generateMonthlyTreasuryReport("2020-01");
    assertEquals(jan2020.periodActivity!.paidExpensesCadMinor, 3000);
    assertEquals(jan2020.periodActivity!.settledCashCadMinor, 0);
    assertEquals(jan2020.overview.totalPaidExpensesCadMinor, 4000, "balances are as-of-now");
    await assertRejects(() => generateMonthlyTreasuryReport("2020-13"), Error, "Invalid report period");
  } finally {
    await kv.close();
  }
});

Deno.test("AUDIT TREASURY — withdrawal journal and allocation entries are posted atomically", async () => {
  const kv = await setupTestEnvironment();
  try {
    const w = await recordWithdrawal({ withdrawalDate: new Date().toISOString(), starsQuantity: 10, tonReceivedNano: 1, networkFeeNano: 0, status: "requested" });
    await settleWithdrawal(w.id, { settlementDate: new Date().toISOString(), amountExchangedTonNano: 1, currencyReceived: "CAD",
      netFundsReceivedMinor: 1000, effectiveRate: 1, feeMinor: 0 }, ADMIN);
    const entries = (await listJournalEntries()).filter((e) => e.referenceId === w.id);
    assertEquals(entries.length, 4);
    assertEquals(entries.reduce((s, e) => s + (e.category === "settled_cash" ? 0 : e.amountMinor), 0), 1000);
    void MOCK_CONFIG;
  } finally {
    await kv.close();
  }
});
