/**
 * Underground Manager — Expense Management & Journal Automated Tests
 * Phase UG-03: Treasury, Expenses & Final Automation
 */

import { assertEquals } from "@std/assert";
import { setupTestEnvironment } from "./test_helpers.ts";
import {
  getExpense,
  listExpenses,
  recordExpenseAdjustment,
  recordRecurringTemplate,
  updateRecurringTemplate,
} from "../src/db/expenses.ts";
import {
  getJournalBalanceByCategory,
  recordJournalEntry,
} from "../src/db/treasury.ts";
import {
  recordExpenseWithJournal,
  reimburseAdminExpense,
} from "../src/treasury/service.ts";

Deno.test("TREASURY EXPENSES — Paid from club funds reduces cash balance and allocation fund", async () => {
  await setupTestEnvironment();

  // Seed settled cash: $500.00 CAD (50000 cents)
  await recordJournalEntry({
    entryType: "revenue_settled",
    category: "settled_cash",
    amountMinor: 50000,
    referenceId: "seed_01",
    notes: "Initial settled funds",
  });
  await recordJournalEntry({
    entryType: "allocation",
    category: "operations_fund",
    amountMinor: 12500,
    referenceId: "seed_01",
    notes: "Operations 25%",
  });

  const expense = await recordExpenseWithJournal({
    description: "Server Hosting (Deno Deploy)",
    originalAmountMinor: 2000, // $20.00 CAD
    originalCurrency: "CAD",
    category: "platform_operations",
    status: "paid",
    payer: "club_funds",
    actorId: 111111,
  });

  assertEquals(expense.status, "paid");
  assertEquals(expense.payer, "club_funds");

  // Cash balance should be 50000 - 2000 = 48000 cents
  const cashBal = await getJournalBalanceByCategory("settled_cash");
  assertEquals(cashBal, 48000);

  // Operations fund should be 12500 - 2000 = 10500 cents
  const opsBal = await getJournalBalanceByCategory("operations_fund");
  assertEquals(opsBal, 10500);
});

Deno.test("TREASURY EXPENSES — Paid personally by admin creates liability without reducing cash until reimbursed", async () => {
  await setupTestEnvironment();

  // Initial cash: $200.00 CAD
  await recordJournalEntry({
    entryType: "revenue_settled",
    category: "settled_cash",
    amountMinor: 20000,
    referenceId: "seed_02",
    notes: "Settled cash",
  });

  // Admin pays $16.00 CAD for Aria subscription out of pocket
  const expense = await recordExpenseWithJournal({
    description: "Aria Subscription (Personal outlay)",
    originalAmountMinor: 1600,
    originalCurrency: "CAD",
    category: "creator_subscription",
    status: "paid",
    payer: "admin_personal",
    paidByAdminId: 111111,
    actorId: 111111,
  });

  assertEquals(expense.reimbursementStatus, "pending");

  // Club cash must NOT be reduced yet!
  const cashBefore = await getJournalBalanceByCategory("settled_cash");
  assertEquals(cashBefore, 20000);

  // Liability owed to admin must be $16.00 (1600 cents)
  const liabilityBefore = await getJournalBalanceByCategory("admin_liability");
  assertEquals(liabilityBefore, 1600);

  // Now, club reimburses admin
  const reimbursed = await reimburseAdminExpense(expense.id, 222222);
  assertEquals(reimbursed.reimbursementStatus, "reimbursed");

  // After reimbursement: cash is reduced, liability is cleared
  const cashAfter = await getJournalBalanceByCategory("settled_cash");
  assertEquals(cashAfter, 18400);

  const liabilityAfter = await getJournalBalanceByCategory("admin_liability");
  assertEquals(liabilityAfter, 0);
});

Deno.test("TREASURY EXPENSES — Expense adjustment preserves finalized history with linked reference", async () => {
  await setupTestEnvironment();

  const original = await recordExpenseWithJournal({
    description: "Photo Pack Batch 1",
    originalAmountMinor: 5000,
    originalCurrency: "CAD",
    category: "creator_content_license",
    status: "paid",
    payer: "club_funds",
    actorId: 111111,
  });

  // Partial refund or cost correction via adjustment
  const adjustment = await recordExpenseAdjustment(original.id, {
    description: "Partial refund on Photo Pack Batch 1",
    originalAmountMinor: -1500, // -$15.00
    originalCurrency: "CAD",
    cadAmountMinor: -1500,
    usdAmountMinor: -1100,
    indicativeStarsAmount: 0,
    category: "creator_content_license",
    status: "refunded",
    payer: "club_funds",
    expenseDate: new Date().toISOString(),
  });

  assertEquals(adjustment.adjustmentOfId, original.id);

  // Original expense remains unmodified and finalized
  const fetchedOriginal = await getExpense(original.id);
  assertEquals(fetchedOriginal!.originalAmountMinor, 5000);
  assertEquals(fetchedOriginal!.status, "paid");
});

Deno.test("TREASURY EXPENSES — Recurring expense template creation and updating", async () => {
  await setupTestEnvironment();

  const template = await recordRecurringTemplate({
    description: "Aria VIP Monthly Renewal",
    expectedAmountMinor: 1600,
    currency: "CAD",
    category: "creator_subscription",
    frequency: "monthly",
    dayOfMonth: 15,
    status: "active",
    nextDueDate: "2026-11-15",
  });

  assertEquals(template.status, "active");
  assertEquals(template.expectedAmountMinor, 1600);

  const updated = await updateRecurringTemplate(template.id, {
    status: "paused",
  });
  assertEquals(updated!.status, "paused");
});
