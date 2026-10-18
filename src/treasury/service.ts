/**
 * Underground Manager — Core Treasury Service & Financial Workflows
 * Phase UG-03: Treasury, Expenses & Final Automation
 */

import { logAuditEvent } from "../db/audit.ts";
import {
  listExpenses,
  markExpenseReimbursed,
  recordExpense,
  updateCandidatePricing,
  updateExpenseStatus,
} from "../db/expenses.ts";
import {
  getAllJournalBalances,
  getTreasuryAllocations,
  listStarTransactions,
  listWithdrawals,
  recordJournalEntry,
  recordWithdrawal,
  recordWithdrawalSettlement,
  updateStarTransactionStatus,
} from "../db/treasury.ts";
import { getWantedCandidate, updateWantedStatus } from "../db/wanted.ts";
import {
  CurrencyCode,
  ExpenseCategory,
  ExpensePayer,
  ExpenseRecord,
  ExpenseStatus,
  TreasuryOverview,
  WantedCandidate,
  WithdrawalRecord,
  WithdrawalSettlement,
} from "../types.ts";
import { convertToBaseCurrency, formatMoney } from "./conversion.ts";

/**
 * Compile a comprehensive, real-time Treasury overview.
 */
export async function getTreasuryOverview(): Promise<TreasuryOverview> {
  const [transactions, withdrawals, expenses, allocations] = await Promise.all([
    listStarTransactions(2000),
    listWithdrawals(500),
    listExpenses({ limit: 1000 }),
    getTreasuryAllocations(),
  ]);

  let totalStarsReceived = 0;
  let pendingStars = 0;
  let potentiallyWithdrawableStars = 0;
  let withdrawnStars = 0;
  let estimatedPendingRewardsCadMinor = 0;
  let estimatedWithdrawableRewardsCadMinor = 0;

  for (const tx of transactions) {
    if (tx.starsAmount > 0) {
      totalStarsReceived += tx.starsAmount;
    }

    if (tx.status === "pending") {
      pendingStars += tx.starsAmount;
      estimatedPendingRewardsCadMinor += tx.estimatedRewardCadCents;
    } else if (tx.status === "withdrawable_estimate") {
      potentiallyWithdrawableStars += tx.starsAmount;
      estimatedWithdrawableRewardsCadMinor += tx.estimatedRewardCadCents;
    } else if (tx.status === "withdrawn") {
      withdrawnStars += tx.starsAmount;
    }
  }

  // Settled Net Cash (Real fiat cash received from completed settlements)
  let settledNetCashCadMinor = 0;
  for (const w of withdrawals) {
    if (w.status === "completed" && w.settlement) {
      settledNetCashCadMinor += w.settlement.netFundsReceivedMinor;
    }
  }

  // Allocation splits applied strictly to actual settled net receipts
  const allocatedAcquisitionsCadMinor = Math.round(
    settledNetCashCadMinor * (allocations.acquisitionPct / 100)
  );
  const allocatedOperationsCadMinor = Math.round(
    settledNetCashCadMinor * (allocations.operationsPct / 100)
  );
  // Ensure reserve gets exact remainder to avoid cent-rounding drift
  const allocatedReserveCadMinor =
    settledNetCashCadMinor - allocatedAcquisitionsCadMinor - allocatedOperationsCadMinor;

  // Expenses categorization
  let paidAcquisitionsCadMinor = 0;
  let paidOperationsCadMinor = 0;
  let paidOtherCadMinor = 0;
  let committedAcquisitionsCadMinor = 0;
  let adminReimbursementsOwedCadMinor = 0;

  for (const exp of expenses) {
    if (exp.status === "paid") {
      if (
        exp.category === "creator_subscription" ||
        exp.category === "creator_content_license"
      ) {
        paidAcquisitionsCadMinor += exp.cadAmountMinor;
      } else if (
        exp.category === "platform_operations" ||
        exp.category === "marketing" ||
        exp.category === "transaction_fees"
      ) {
        paidOperationsCadMinor += exp.cadAmountMinor;
      } else {
        paidOtherCadMinor += exp.cadAmountMinor;
      }
    } else if (
      exp.status === "committed" &&
      (exp.category === "creator_subscription" || exp.category === "creator_content_license")
    ) {
      committedAcquisitionsCadMinor += exp.cadAmountMinor;
    }

    if (
      exp.payer === "admin_personal" &&
      exp.reimbursementStatus === "pending" &&
      exp.status === "paid"
    ) {
      adminReimbursementsOwedCadMinor += exp.cadAmountMinor;
    }
  }

  const totalPaidExpensesCadMinor =
    paidAcquisitionsCadMinor + paidOperationsCadMinor + paidOtherCadMinor;

  // Available Acquisition Budget Formula:
  // (Settled allocated to acquisitions) - (Acquisition expenses paid) - (Approved commitments)
  const availableAcquisitionBudgetCadMinor = Math.max(
    0,
    allocatedAcquisitionsCadMinor - paidAcquisitionsCadMinor - committedAcquisitionsCadMinor
  );

  return {
    reportingCurrency: "CAD",
    totalStarsReceived,
    pendingStars,
    potentiallyWithdrawableStars,
    withdrawnStars,
    estimatedPendingRewardsCadMinor,
    estimatedWithdrawableRewardsCadMinor,
    settledNetCashCadMinor,
    allocatedAcquisitionsCadMinor,
    allocatedOperationsCadMinor,
    allocatedReserveCadMinor,
    paidAcquisitionsCadMinor,
    paidOperationsCadMinor,
    paidOtherCadMinor,
    totalPaidExpensesCadMinor,
    committedAcquisitionsCadMinor,
    availableAcquisitionBudgetCadMinor,
    adminReimbursementsOwedCadMinor,
  };
}

/**
 * Record a withdrawal of Stars and its actual settlement proceeds.
 */
export async function recordWithdrawalWithSettlement(params: {
  starsQuantity: number;
  withdrawalDate?: string;
  fragmentReference?: string;
  tonReceivedNano: number;
  networkFeeNano?: number;
  settlement?: WithdrawalSettlement;
  notes?: string;
  adminId: number;
}): Promise<WithdrawalRecord> {
  const withdrawal = await recordWithdrawal({
    withdrawalDate: params.withdrawalDate ?? new Date().toISOString(),
    starsQuantity: params.starsQuantity,
    fragmentReference: params.fragmentReference,
    tonReceivedNano: params.tonReceivedNano,
    networkFeeNano: params.networkFeeNano ?? 0,
    status: params.settlement ? "completed" : "requested",
    settlement: params.settlement,
    notes: params.notes,
  });

  // If settlement funds were received, credit the financial journal
  if (params.settlement) {
    const netCents = params.settlement.netFundsReceivedMinor;

    // 1. Credit settled cash
    await recordJournalEntry({
      entryType: "revenue_settled",
      category: "settled_cash",
      amountMinor: netCents,
      referenceId: withdrawal.id,
      notes: `Withdrawal settlement for ${params.starsQuantity} Stars: ${formatMoney(netCents, params.settlement.currencyReceived)}`,
    });

    // 2. Audit event
    await logAuditEvent(
      "withdrawal_settled",
      {
        withdrawalId: withdrawal.id,
        starsQuantity: params.starsQuantity,
        netFundsReceivedMinor: netCents,
        currencyReceived: params.settlement.currencyReceived,
      },
      params.adminId
    );

    // 3. Update eligible Star transactions to "withdrawn" up to starsQuantity
    const txs = await listStarTransactions(1000);
    let remainingToMark = params.starsQuantity;
    for (const tx of txs) {
      if (remainingToMark <= 0) break;
      if (tx.status === "withdrawable_estimate" || tx.status === "pending") {
        if (tx.starsAmount <= remainingToMark) {
          await updateStarTransactionStatus(tx.id, "withdrawn");
          remainingToMark -= tx.starsAmount;
        }
      }
    }
  }

  return withdrawal;
}

/**
 * Record a new expense with currency conversion and journal integration.
 */
export async function recordExpenseWithJournal(params: {
  description: string;
  originalAmountMinor: number;
  originalCurrency: CurrencyCode;
  category: ExpenseCategory;
  creatorId?: string;
  candidateId?: string;
  expenseDate?: string;
  status: ExpenseStatus;
  payer: ExpensePayer;
  paidByAdminId?: number;
  receiptFileId?: string;
  notes?: string;
  actorId: number;
}): Promise<ExpenseRecord> {
  const { cadAmountMinor, usdAmountMinor, indicativeStars } =
    await convertToBaseCurrency(params.originalAmountMinor, params.originalCurrency);

  const expense = await recordExpense({
    description: params.description,
    originalAmountMinor: params.originalAmountMinor,
    originalCurrency: params.originalCurrency,
    cadAmountMinor,
    usdAmountMinor,
    indicativeStarsAmount: indicativeStars,
    category: params.category,
    creatorId: params.creatorId,
    candidateId: params.candidateId,
    expenseDate: params.expenseDate ?? new Date().toISOString(),
    status: params.status,
    payer: params.payer,
    paidByAdminId: params.paidByAdminId,
    reimbursementStatus: params.payer === "admin_personal" ? "pending" : undefined,
    receiptFileId: params.receiptFileId,
    notes: params.notes,
  });

  // Journal posting if expense is paid
  if (params.status === "paid") {
    if (params.payer === "club_funds") {
      // Reduce club settled cash
      await recordJournalEntry({
        entryType: "expense_paid",
        category: "settled_cash",
        amountMinor: -cadAmountMinor,
        referenceId: expense.id,
        notes: `Paid from club funds: ${expense.description}`,
      });

      // Reduce allocated category fund
      const fundCategory =
        params.category === "creator_subscription" ||
        params.category === "creator_content_license"
          ? "acquisition_fund"
          : "operations_fund";

      await recordJournalEntry({
        entryType: "expense_paid",
        category: fundCategory,
        amountMinor: -cadAmountMinor,
        referenceId: expense.id,
        notes: `Fund deduction for: ${expense.description}`,
      });
    } else {
      // Admin personal payment: increases liability
      await recordJournalEntry({
        entryType: "adjustment",
        category: "admin_liability",
        amountMinor: cadAmountMinor,
        referenceId: expense.id,
        notes: `Admin outlay liability: ${expense.description}`,
      });
    }
  }

  await logAuditEvent(
    params.status === "committed" ? "expense_committed" : "expense_created",
    {
      expenseId: expense.id,
      amount: formatMoney(cadAmountMinor, "CAD"),
      status: expense.status,
      payer: expense.payer,
    },
    params.actorId
  );

  return expense;
}

/**
 * Reimburse an administrator for an authorized personal outlay.
 */
export async function reimburseAdminExpense(
  expenseId: string,
  adminActorId: number
): Promise<ExpenseRecord> {
  const updated = await markExpenseReimbursed(expenseId);
  if (!updated) {
    throw new Error(`Expense ${expenseId} could not be marked as reimbursed`);
  }

  // Deduct settled club cash and relieve admin liability
  await recordJournalEntry({
    entryType: "reimbursement",
    category: "settled_cash",
    amountMinor: -updated.cadAmountMinor,
    referenceId: updated.id,
    notes: `Reimbursement paid for expense: ${updated.description}`,
  });

  await recordJournalEntry({
    entryType: "reimbursement",
    category: "admin_liability",
    amountMinor: -updated.cadAmountMinor,
    referenceId: updated.id,
    notes: `Admin liability cleared for: ${updated.description}`,
  });

  await logAuditEvent(
    "expense_reimbursed",
    {
      expenseId: updated.id,
      reimbursedAmount: formatMoney(updated.cadAmountMinor, "CAD"),
    },
    adminActorId
  );

  return updated;
}

/**
 * Evaluate whether a candidate's expected price can be covered by the available acquisition budget.
 */
export async function evaluateCandidateAffordability(candidateId: string): Promise<{
  candidate: WantedCandidate;
  affordable: boolean;
  expectedCadMinor: number;
  availableBudgetCadMinor: number;
  shortfallMinor: number;
}> {
  const candidate = await getWantedCandidate(candidateId);
  if (!candidate) {
    throw new Error(`Candidate ${candidateId} not found`);
  }

  const expectedCadMinor = candidate.expectedCadMinor ?? 0;
  const overview = await getTreasuryOverview();
  const availableBudgetCadMinor = overview.availableAcquisitionBudgetCadMinor;

  const affordable = availableBudgetCadMinor >= expectedCadMinor;
  const shortfallMinor = affordable ? 0 : expectedCadMinor - availableBudgetCadMinor;

  return {
    candidate,
    affordable,
    expectedCadMinor,
    availableBudgetCadMinor,
    shortfallMinor,
  };
}

/**
 * Approve a winning candidate acquisition: reserves budget via a committed expense.
 */
export async function approveCandidateAcquisition(
  candidateId: string,
  adminId: number
): Promise<{
  candidate: WantedCandidate;
  commitmentExpense: ExpenseRecord;
}> {
  const evalResult = await evaluateCandidateAffordability(candidateId);
  if (!evalResult.affordable) {
    throw new Error(
      `Insufficient acquisition budget. Need ${formatMoney(evalResult.expectedCadMinor, "CAD")}, available ${formatMoney(evalResult.availableBudgetCadMinor, "CAD")}. Shortfall: ${formatMoney(evalResult.shortfallMinor, "CAD")}`
    );
  }

  const candidate = evalResult.candidate;

  // Record commitment expense to reserve the budget
  const commitmentExpense = await recordExpense({
    description: `Acquisition Commitment: ${candidate.name}`,
    originalAmountMinor: candidate.expectedPriceMinor ?? 0,
    originalCurrency: candidate.priceCurrency ?? "CAD",
    cadAmountMinor: candidate.expectedCadMinor ?? 0,
    usdAmountMinor: candidate.expectedCadMinor ?? 0,
    indicativeStarsAmount: 0,
    category: "creator_subscription",
    candidateId: candidate.id,
    expenseDate: new Date().toISOString(),
    status: "committed",
    payer: "club_funds",
  });

  // Transition candidate status to acquisition_pending
  const updatedCandidate = await updateWantedStatus(
    candidate.id,
    "acquisition_pending",
    `Approved by admin ${adminId}`
  );

  // Link commitment expense ID
  if (updatedCandidate) {
    await updateCandidatePricing(candidate.id, {
      expectedPriceMinor: candidate.expectedPriceMinor ?? 0,
      priceCurrency: candidate.priceCurrency ?? "CAD",
      expectedCadMinor: candidate.expectedCadMinor ?? 0,
      rightsVerified: candidate.rightsVerified,
      notes: candidate.notes,
    });
  }

  await logAuditEvent(
    "acquisition_approved",
    {
      candidateId: candidate.id,
      candidateName: candidate.name,
      commitmentAmount: formatMoney(commitmentExpense.cadAmountMinor, "CAD"),
    },
    adminId
  );

  return {
    candidate: updatedCandidate ?? candidate,
    commitmentExpense,
  };
}

/**
 * Confirm that candidate acquisition payment has been made by an administrator.
 * Converts commitment expense to paid, records journal entries, and updates candidate to acquired.
 */
export async function confirmCandidateAcquisitionPaid(params: {
  candidateId: string;
  actualAmountMinor?: number;
  currency?: CurrencyCode;
  payer: ExpensePayer;
  adminId: number;
}): Promise<{
  candidate: WantedCandidate;
  expense: ExpenseRecord;
}> {
  const candidate = await getWantedCandidate(params.candidateId);
  if (!candidate) {
    throw new Error(`Candidate ${params.candidateId} not found`);
  }

  // Find existing commitment expense
  const expenses = await listExpenses({ candidateId: candidate.id, status: "committed" });
  let expense: ExpenseRecord;

  if (expenses.length > 0) {
    const updated = await updateExpenseStatus(expenses[0].id, "paid");
    expense = updated ?? expenses[0];

    // Journal posting for payment
    if (params.payer === "club_funds") {
      await recordJournalEntry({
        entryType: "expense_paid",
        category: "settled_cash",
        amountMinor: -expense.cadAmountMinor,
        referenceId: expense.id,
        notes: `Acquisition paid: ${candidate.name}`,
      });
      await recordJournalEntry({
        entryType: "expense_paid",
        category: "acquisition_fund",
        amountMinor: -expense.cadAmountMinor,
        referenceId: expense.id,
        notes: `Acquisition fund deduction: ${candidate.name}`,
      });
    } else {
      await recordJournalEntry({
        entryType: "adjustment",
        category: "admin_liability",
        amountMinor: expense.cadAmountMinor,
        referenceId: expense.id,
        notes: `Admin outlay liability for: ${candidate.name}`,
      });
    }
  } else {
    // If not committed previously, record directly as paid
    const amountMinor = params.actualAmountMinor ?? candidate.expectedPriceMinor ?? 0;
    const currency = params.currency ?? candidate.priceCurrency ?? "CAD";

    expense = await recordExpenseWithJournal({
      description: `Acquisition Payment: ${candidate.name}`,
      originalAmountMinor: amountMinor,
      originalCurrency: currency,
      category: "creator_subscription",
      candidateId: candidate.id,
      status: "paid",
      payer: params.payer,
      paidByAdminId: params.payer === "admin_personal" ? params.adminId : undefined,
      actorId: params.adminId,
    });
  }

  // Update candidate status to acquired
  const updatedCandidate = await updateWantedStatus(
    candidate.id,
    "acquired",
    `Acquisition confirmed by admin ${params.adminId}`
  );

  return {
    candidate: updatedCandidate ?? candidate,
    expense,
  };
}
