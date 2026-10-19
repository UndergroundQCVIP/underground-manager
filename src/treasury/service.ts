/**
 * LA CONFRÉRIE — Core Treasury Service & Financial Workflows
 * Phase UG-03: Treasury, Expenses & Final Automation
 *
 * Ledger rules (all amounts are integer minor units of the base currency, CAD):
 *  - Stars are NOT cash. Only a completed settlement credits `settled_cash`.
 *  - A settlement is split into the acquisition / operations / reserve funds
 *    using the percentages in force *at settlement time*; the split is journaled
 *    and never recomputed, so changing percentages is strictly prospective.
 *  - Journal entries are append-only and committed in the same atomic operation
 *    as the business record they belong to.
 *  - Commitments are reservations (not spend); converting one to paid replaces
 *    it, so a creator is never counted twice.
 *  - Refunds / corrections are new linked adjustment records, never edits.
 */

import { getConfig } from "../config.ts";
import { logAuditEvent } from "../db/audit.ts";
import {
  getExpense,
  listExpenseAdjustments,
  listExpenses,
  markExpenseReimbursed,
  recordExpense,
  transitionExpense,
} from "../db/expenses.ts";
import {
  getBudgetVersionstamp,
  JournalDraft,
  listJournalEntries,
  getTreasuryAllocations,
  getWithdrawal,
  listStarTransactions,
  listWithdrawals,
  recordWithdrawal,
  recordWithdrawalSettlement,
  updateStarTransactionStatus,
} from "../db/treasury.ts";
import { getKv } from "../db/kv.ts";
import { getWantedCandidate, patchWantedCandidate } from "../db/wanted.ts";
import {
  CurrencyCode,
  EXPENSE_CATEGORY_LABELS,
  ExpenseCategory,
  ExpensePayer,
  ExpenseRecord,
  ExpenseStatus,
  TreasuryOverview,
  WANTED_STATUS_LABELS,
  WantedCandidate,
  WithdrawalRecord,
  WithdrawalSettlement,
} from "../types.ts";
import {
  convertCurrency,
  convertToBaseCurrency,
  formatMoney,
  isSupportedExpenseCurrency,
  normalizeCurrency,
} from "./conversion.ts";

const ACQUISITION_CATEGORIES: ExpenseCategory[] = [
  "creator_subscription",
  "creator_content_license",
];

export function isAcquisitionCategory(category: ExpenseCategory): boolean {
  return ACQUISITION_CATEGORIES.includes(category);
}

function fundFor(category: ExpenseCategory): "acquisition_fund" | "operations_fund" {
  return isAcquisitionCategory(category) ? "acquisition_fund" : "operations_fund";
}

function isPositiveInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n > 0;
}

/**
 * Compile a comprehensive, real-time Treasury overview. Derived purely from
 * stored records (no caching, no estimates mixed into cash figures).
 */
export async function getTreasuryOverview(): Promise<TreasuryOverview> {
  const [transactions, withdrawals, expenses, journal] = await Promise.all([
    listStarTransactions(),
    listWithdrawals(),
    listExpenses(),
    listJournalEntries(),
  ]);

  let totalStarsReceived = 0;
  let pendingStars = 0;
  let potentiallyWithdrawableStars = 0;
  let withdrawnStars = 0;
  let refundedStars = 0;
  let telegramWithdrawnStars = 0;
  let estimatedPendingRewardsCadMinor = 0;
  let estimatedWithdrawableRewardsCadMinor = 0;

  for (const tx of transactions) {
    if (tx.txType === "withdrawal") {
      // Informational cross-check of what Telegram says was withdrawn.
      telegramWithdrawnStars += Math.abs(tx.starsAmount);
      continue;
    }
    if (tx.starsAmount <= 0) continue; // outgoing / non-revenue records

    if (tx.status === "refunded") {
      refundedStars += tx.starsAmount;
      continue;
    }

    totalStarsReceived += tx.starsAmount;
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

  // Settled net cash: real fiat received through completed settlements only.
  let settledNetCashCadMinor = 0;
  let recordedWithdrawalStars = 0;
  for (const w of withdrawals) {
    if (w.status === "cancelled") continue;
    recordedWithdrawalStars += w.starsQuantity;
    if (w.status === "completed" && w.settlement) {
      settledNetCashCadMinor += w.settlement.netFundsReceivedMinor;
    }
  }

  // Allocations are the journaled splits made at each settlement.
  let allocatedAcquisitionsCadMinor = 0;
  let allocatedOperationsCadMinor = 0;
  let allocatedReserveCadMinor = 0;
  for (const entry of journal) {
    if (entry.entryType !== "allocation") continue;
    if (entry.category === "acquisition_fund") allocatedAcquisitionsCadMinor += entry.amountMinor;
    else if (entry.category === "operations_fund") allocatedOperationsCadMinor += entry.amountMinor;
    else if (entry.category === "reserve_fund") allocatedReserveCadMinor += entry.amountMinor;
  }

  // Expenses: originals plus their signed adjustments.
  const byId = new Map(expenses.map((e) => [e.id, e]));
  const adjustmentsByOriginal = new Map<string, ExpenseRecord[]>();
  for (const e of expenses) {
    if (e.adjustmentOfId) {
      const list = adjustmentsByOriginal.get(e.adjustmentOfId) ?? [];
      list.push(e);
      adjustmentsByOriginal.set(e.adjustmentOfId, list);
    }
  }

  let paidAcquisitionsCadMinor = 0;
  let paidOperationsCadMinor = 0;
  let paidOtherCadMinor = 0;
  let committedAcquisitionsCadMinor = 0;
  let adminReimbursementsOwedCadMinor = 0;
  let clubCashOutflowCadMinor = 0;

  const addPaid = (category: ExpenseCategory, amount: number) => {
    if (isAcquisitionCategory(category)) paidAcquisitionsCadMinor += amount;
    else if (
      category === "platform_operations" ||
      category === "marketing" ||
      category === "transaction_fees"
    ) paidOperationsCadMinor += amount;
    else paidOtherCadMinor += amount;
  };

  for (const exp of expenses) {
    if (exp.adjustmentOfId) {
      const original = byId.get(exp.adjustmentOfId);
      if (exp.status === "paid" || exp.status === "refunded") {
        addPaid(exp.category, exp.cadAmountMinor);
        if (original?.payer === "admin_personal" && original.reimbursementStatus === "pending") {
          adminReimbursementsOwedCadMinor += exp.cadAmountMinor;
        }
      }
      continue;
    }

    if (exp.status === "paid") {
      addPaid(exp.category, exp.cadAmountMinor);

      const net =
        exp.cadAmountMinor +
        (adjustmentsByOriginal.get(exp.id) ?? [])
          .filter((a) => a.status === "paid" || a.status === "refunded")
          .reduce((sum, a) => sum + a.cadAmountMinor, 0);

      if (exp.payer === "club_funds") {
        clubCashOutflowCadMinor += net;
      } else if (exp.reimbursementStatus === "pending") {
        adminReimbursementsOwedCadMinor += exp.cadAmountMinor;
      } else if (exp.reimbursementStatus === "reimbursed") {
        clubCashOutflowCadMinor += net;
      }
    } else if (exp.status === "committed" && isAcquisitionCategory(exp.category)) {
      committedAcquisitionsCadMinor += exp.cadAmountMinor;
    }
  }

  const totalPaidExpensesCadMinor =
    paidAcquisitionsCadMinor + paidOperationsCadMinor + paidOtherCadMinor;

  // Available Acquisition Budget:
  // (allocated to acquisitions) - (acquisition expenses paid) - (approved commitments)
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
    cashOnHandCadMinor: settledNetCashCadMinor - clubCashOutflowCadMinor,
    telegramWithdrawnStars,
    recordedWithdrawalStars,
    refundedStars,
  };
}

/** Splits a settlement across funds using the percentages in force right now. */
export async function buildSettlementJournal(
  withdrawalId: string,
  netMinor: number,
  starsQuantity: number,
  currency: string
): Promise<JournalDraft[]> {
  const alloc = await getTreasuryAllocations();
  const acquisitions = Math.round((netMinor * alloc.acquisitionPct) / 100);
  const operations = Math.round((netMinor * alloc.operationsPct) / 100);
  // Reserve takes the remainder so the split always sums to the cent.
  const reserve = netMinor - acquisitions - operations;
  const note = `${alloc.acquisitionPct}/${alloc.operationsPct}/${alloc.reservePct} split`;

  return [
    {
      entryType: "revenue_settled",
      category: "settled_cash",
      amountMinor: netMinor,
      referenceId: withdrawalId,
      notes: `Withdrawal settlement for ${starsQuantity} Stars: ${formatMoney(netMinor, currency)}`,
    },
    {
      entryType: "allocation",
      category: "acquisition_fund",
      amountMinor: acquisitions,
      referenceId: withdrawalId,
      notes: `Acquisitions ${alloc.acquisitionPct}% (${note})`,
    },
    {
      entryType: "allocation",
      category: "operations_fund",
      amountMinor: operations,
      referenceId: withdrawalId,
      notes: `Operations ${alloc.operationsPct}% (${note})`,
    },
    {
      entryType: "allocation",
      category: "reserve_fund",
      amountMinor: reserve,
      referenceId: withdrawalId,
      notes: `Reserve ${alloc.reservePct}% (${note})`,
    },
  ];
}

/** Marks the oldest withdrawable Star transactions as withdrawn (never pending ones). */
async function markStarsWithdrawn(starsQuantity: number): Promise<number> {
  const txs = (await listStarTransactions())
    .filter((t) => t.status === "withdrawable_estimate" && t.starsAmount > 0)
    .sort((a, b) => new Date(a.txTimestamp).getTime() - new Date(b.txTimestamp).getTime());

  let remaining = starsQuantity;
  for (const tx of txs) {
    if (remaining <= 0) break;
    if (tx.starsAmount <= remaining) {
      await updateStarTransactionStatus(tx.id, "withdrawn");
      remaining -= tx.starsAmount;
    }
  }
  return starsQuantity - remaining;
}

function validateSettlement(settlement: WithdrawalSettlement): void {
  const base = getConfig().BASE_CURRENCY;
  if (normalizeCurrency(settlement.currencyReceived) !== normalizeCurrency(base)) {
    throw new Error(
      `Le produit du règlement doit être saisi en ${base} (la devise de présentation); reçu : ${settlement.currencyReceived}. ` +
        `Convertissez au taux de change réel obtenu avant d'enregistrer.`
    );
  }
  if (!isPositiveInt(settlement.netFundsReceivedMinor)) {
    throw new Error("Les fonds nets réglés doivent être un nombre entier positif d'unités mineures");
  }
}

/**
 * Credit the proceeds of a withdrawal that has been converted to spendable
 * base-currency cash. Idempotent: a withdrawal can be settled only once.
 */
export async function settleWithdrawal(
  withdrawalId: string,
  settlement: WithdrawalSettlement,
  adminId: number
): Promise<WithdrawalRecord> {
  validateSettlement(settlement);

  const withdrawal = await getWithdrawal(withdrawalId);
  if (!withdrawal) throw new Error(`Retrait ${withdrawalId} introuvable`);

  const journal = await buildSettlementJournal(
    withdrawal.id,
    settlement.netFundsReceivedMinor,
    withdrawal.starsQuantity,
    settlement.currencyReceived
  );

  // CAS inside: throws if already settled or changed concurrently.
  const settled = await recordWithdrawalSettlement(withdrawalId, settlement, journal);
  if (!settled) throw new Error(`Retrait ${withdrawalId} introuvable`);

  await logAuditEvent(
    "withdrawal_settled",
    {
      withdrawalId,
      starsQuantity: withdrawal.starsQuantity,
      netFundsReceivedMinor: settlement.netFundsReceivedMinor,
      currencyReceived: settlement.currencyReceived,
    },
    adminId
  );

  await markStarsWithdrawn(withdrawal.starsQuantity);
  return settled;
}

/**
 * Record a withdrawal of Stars and, when supplied, its actual settlement proceeds.
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
  if (!isPositiveInt(params.starsQuantity)) {
    throw new Error("La quantité d'Étoiles doit être un nombre entier positif");
  }
  if (!Number.isInteger(params.tonReceivedNano) || params.tonReceivedNano < 0) {
    throw new Error("Le TON reçu doit être un nombre entier non négatif de nanoTON");
  }
  // Reject a bad settlement BEFORE anything is recorded (no orphan "requested" row).
  if (params.settlement) validateSettlement(params.settlement);

  // Without a Fragment reference, treat an identical entry within 10 minutes as
  // an accidental double submission rather than a second real withdrawal.
  if (!params.fragmentReference) {
    const recent = (await listWithdrawals()).find(
      (w) =>
        w.status !== "cancelled" &&
        w.starsQuantity === params.starsQuantity &&
        w.tonReceivedNano === params.tonReceivedNano &&
        (w.settlement?.netFundsReceivedMinor ?? null) ===
          (params.settlement?.netFundsReceivedMinor ?? null) &&
        Date.now() - new Date(w.createdAt).getTime() < 10 * 60 * 1000
    );
    if (recent) {
      throw new Error(
        `Un retrait identique a été enregistré il y a quelques instants (${recent.id}). ` +
          `S'il s'agit réellement d'un retrait distinct, indiquez sa référence Fragment.`
      );
    }
  }

  const withdrawal = await recordWithdrawal({
    withdrawalDate: params.withdrawalDate ?? new Date().toISOString(),
    starsQuantity: params.starsQuantity,
    fragmentReference: params.fragmentReference,
    tonReceivedNano: params.tonReceivedNano,
    networkFeeNano: params.networkFeeNano ?? 0,
    status: "requested",
    notes: params.notes,
  });

  if (!params.settlement) return withdrawal;
  return await settleWithdrawal(withdrawal.id, params.settlement, params.adminId);
}

/** Ledger postings for an expense that has been paid. */
export function paidExpenseJournal(
  expense: Pick<ExpenseRecord, "id" | "description" | "category" | "payer" | "cadAmountMinor">
): JournalDraft[] {
  const amount = expense.cadAmountMinor;
  const drafts: JournalDraft[] = [
    {
      entryType: "expense_paid",
      category: fundFor(expense.category),
      amountMinor: -amount,
      referenceId: expense.id,
      notes: `Fund deduction for: ${expense.description}`,
    },
  ];
  if (expense.payer === "club_funds") {
    drafts.unshift({
      entryType: "expense_paid",
      category: "settled_cash",
      amountMinor: -amount,
      referenceId: expense.id,
      notes: `Paid from club funds: ${expense.description}`,
    });
  } else {
    drafts.unshift({
      entryType: "adjustment",
      category: "admin_liability",
      amountMinor: amount,
      referenceId: expense.id,
      notes: `Admin outlay liability: ${expense.description}`,
    });
  }
  return drafts;
}

const EXPENSE_PAYERS: ExpensePayer[] = ["club_funds", "admin_personal"];
const RECORDABLE_STATUSES: ExpenseStatus[] = ["planned", "committed", "paid"];

/**
 * Record a new expense with currency conversion; paid expenses are journaled in
 * the same atomic commit.
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
  /** Internal: single-commitment guard for acquisitions. */
  uniqueKey?: Deno.KvKey;
  expectedBudgetVersion?: string | null;
}): Promise<ExpenseRecord> {
  if (!isPositiveInt(params.originalAmountMinor)) {
    throw new Error("Le montant de la dépense doit être un nombre entier positif d'unités mineures");
  }
  if (!(params.category in EXPENSE_CATEGORY_LABELS)) {
    throw new Error(`Catégorie de dépense inconnue « ${params.category} »`);
  }
  if (!EXPENSE_PAYERS.includes(params.payer)) {
    throw new Error(`Payeur inconnu « ${params.payer} »`);
  }
  if (!RECORDABLE_STATUSES.includes(params.status)) {
    throw new Error(`Impossible d'enregistrer des dépenses avec le statut « ${params.status} »`);
  }
  if (!isSupportedExpenseCurrency(params.originalCurrency)) {
    throw new Error(`Devise non prise en charge « ${params.originalCurrency} »`);
  }
  const currency = normalizeCurrency(params.originalCurrency);

  const conv = await convertToBaseCurrency(params.originalAmountMinor, currency);

  const draft = {
    description: params.description.trim(),
    originalAmountMinor: params.originalAmountMinor,
    originalCurrency: currency,
    cadAmountMinor: conv.cadAmountMinor,
    usdAmountMinor: conv.usdAmountMinor,
    indicativeStarsAmount: conv.indicativeStars,
    fxRate: conv.rateToCad,
    fxRateDate: conv.rateDate,
    fxRateSource: conv.rateSource,
    category: params.category,
    creatorId: params.creatorId,
    candidateId: params.candidateId,
    expenseDate: params.expenseDate ?? new Date().toISOString(),
    status: params.status,
    payer: params.payer,
    paidByAdminId:
      params.payer === "admin_personal" ? params.paidByAdminId ?? params.actorId : undefined,
    reimbursementStatus: params.payer === "admin_personal" ? ("pending" as const) : undefined,
    receiptFileId: params.receiptFileId,
    notes: params.notes,
  };

  return await recordExpense(draft as Omit<ExpenseRecord, "id" | "createdAt" | "updatedAt">, {
    uniqueKey: params.uniqueKey,
    expectedBudgetVersion: params.expectedBudgetVersion,
    journal: params.status === "paid" ? (exp) => paidExpenseJournal(exp) : undefined,
  }).then(async (expense) => {
    await logAuditEvent(
      params.status === "committed" ? "expense_committed" : "expense_created",
      {
        expenseId: expense.id,
        amount: formatMoney(expense.cadAmountMinor, "CAD"),
        status: expense.status,
        payer: expense.payer,
        fx: `${expense.fxRate} (${expense.fxRateSource} ${expense.fxRateDate})`,
      },
      params.actorId
    );
    return expense;
  });
}

/** Net CAD amount of an expense after its linked adjustments (refunds/corrections). */
export async function getNetExpenseCad(expense: ExpenseRecord): Promise<number> {
  const adjustments = await listExpenseAdjustments(expense.id);
  return (
    expense.cadAmountMinor +
    adjustments
      .filter((a) => a.status === "paid" || a.status === "refunded")
      .reduce((sum, a) => sum + a.cadAmountMinor, 0)
  );
}

/**
 * Reimburse an administrator for an authorized personal outlay (exactly once;
 * the ledger postings commit with the state change).
 */
export async function reimburseAdminExpense(
  expenseId: string,
  adminActorId: number
): Promise<ExpenseRecord> {
  const current = await getExpense(expenseId);
  if (!current) throw new Error(`Dépense ${expenseId} introuvable`);

  const net = await getNetExpenseCad(current);
  const updated = await markExpenseReimbursed(expenseId, [
    {
      entryType: "reimbursement",
      category: "settled_cash",
      amountMinor: -net,
      referenceId: expenseId,
      notes: `Reimbursement paid for expense: ${current.description}`,
    },
    {
      entryType: "reimbursement",
      category: "admin_liability",
      amountMinor: -net,
      referenceId: expenseId,
      notes: `Admin liability cleared for: ${current.description}`,
    },
  ]);
  if (!updated) {
    throw new Error(`La dépense ${expenseId} n'a pas pu être marquée comme remboursée`);
  }

  await logAuditEvent(
    "expense_reimbursed",
    { expenseId: updated.id, reimbursedAmount: formatMoney(net, "CAD") },
    adminActorId
  );

  return updated;
}

/**
 * Refund (fully or partially) a paid expense. Appends a negative, linked
 * adjustment and reversing journal entries; the original stays untouched.
 */
export async function refundExpense(params: {
  expenseId: string;
  /** Refund amount in the expense's original currency; defaults to the whole remaining amount. */
  amountMinor?: number;
  reason?: string;
  actorId: number;
}): Promise<ExpenseRecord> {
  const original = await getExpense(params.expenseId);
  if (!original) throw new Error(`Dépense ${params.expenseId} introuvable`);
  if (original.adjustmentOfId) throw new Error("Remboursez la dépense d'origine, et non un ajustement");
  if (original.status !== "paid") throw new Error(`Seules les dépenses payées peuvent être remboursées (statut : ${original.status})`);

  const adjustments = (await listExpenseAdjustments(original.id)).filter(
    (a) => a.status === "paid" || a.status === "refunded"
  );
  const alreadyRefundedOrig = -adjustments.reduce((s, a) => s + a.originalAmountMinor, 0);
  const alreadyRefundedCad = -adjustments.reduce((s, a) => s + a.cadAmountMinor, 0);
  const remainingOrig = original.originalAmountMinor - alreadyRefundedOrig;
  if (remainingOrig <= 0) throw new Error("La dépense a déjà été entièrement remboursée");

  const refundOrig = params.amountMinor ?? remainingOrig;
  if (!isPositiveInt(refundOrig) || refundOrig > remainingOrig) {
    throw new Error(
      `Le remboursement doit être compris entre 1 et ${remainingOrig} unités mineures en ${original.originalCurrency}`
    );
  }

  const isFinal = refundOrig === remainingOrig;
  // The final refund takes the exact CAD remainder so net always returns to zero.
  const refundCad = isFinal
    ? original.cadAmountMinor - alreadyRefundedCad
    : Math.round((original.cadAmountMinor * refundOrig) / original.originalAmountMinor);
  const refundUsd = Math.round((original.usdAmountMinor * refundOrig) / original.originalAmountMinor);

  const fund = fundFor(original.category);
  const journal: JournalDraft[] = [
    {
      entryType: "adjustment",
      category: fund,
      amountMinor: refundCad,
      referenceId: original.id,
      notes: `Refund returned to fund: ${original.description}`,
    },
  ];
  if (original.payer === "club_funds" || original.reimbursementStatus === "reimbursed") {
    journal.unshift({
      entryType: "adjustment",
      category: "settled_cash",
      amountMinor: refundCad,
      referenceId: original.id,
      notes: `Refund received: ${original.description}`,
    });
  } else {
    journal.unshift({
      entryType: "adjustment",
      category: "admin_liability",
      amountMinor: -refundCad,
      referenceId: original.id,
      notes: `Admin liability reduced by refund: ${original.description}`,
    });
  }

  const adjustment = await recordExpense(
    {
      description: `Refund: ${original.description}${params.reason ? ` (${params.reason})` : ""}`,
      originalAmountMinor: -refundOrig,
      originalCurrency: original.originalCurrency,
      cadAmountMinor: -refundCad,
      usdAmountMinor: -refundUsd,
      indicativeStarsAmount: 0,
      fxRate: original.fxRate,
      fxRateDate: original.fxRateDate,
      fxRateSource: original.fxRateSource,
      category: original.category,
      creatorId: original.creatorId,
      candidateId: original.candidateId,
      expenseDate: new Date().toISOString(),
      status: "refunded",
      payer: original.payer,
      paidByAdminId: original.paidByAdminId,
      adjustmentOfId: original.id,
    },
    // Negative journal amounts above are stored as positive credits; the
    // adjustment record carries the negative expense amount.
    { journal }
  );

  await logAuditEvent(
    "expense_refunded",
    {
      expenseId: original.id,
      adjustmentId: adjustment.id,
      refunded: formatMoney(refundCad, "CAD"),
      reason: params.reason,
    },
    params.actorId
  );
  return adjustment;
}

/** Cancel a planned/committed expense (releases any reserved budget). */
export async function cancelExpense(expenseId: string, actorId: number): Promise<ExpenseRecord> {
  const expense = await getExpense(expenseId);
  if (!expense) throw new Error(`Dépense ${expenseId} introuvable`);
  if (expense.status !== "planned" && expense.status !== "committed") {
    throw new Error(`Seules les dépenses planifiées ou engagées peuvent être annulées (statut : ${expense.status})`);
  }
  const cancelled = await transitionExpense(expenseId, expense.status, "cancelled", {});
  if (expense.candidateId) {
    const kv = await getKv();
    await kv.delete(["candidate_commitment", expense.candidateId]);
  }
  await logAuditEvent("expense_created", { expenseId, cancelled: true }, actorId);
  return cancelled;
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
    throw new Error(`Candidat ${candidateId} introuvable`);
  }

  const expectedCadMinor = candidate.expectedCadMinor ?? 0;
  const overview = await getTreasuryOverview();
  const availableBudgetCadMinor = overview.availableAcquisitionBudgetCadMinor;

  // An unpriced candidate is never "affordable": a 0 CAD commitment would
  // reserve nothing and hide the real cost.
  const affordable = expectedCadMinor > 0 && availableBudgetCadMinor >= expectedCadMinor;
  const shortfallMinor = affordable ? 0 : Math.max(0, expectedCadMinor - availableBudgetCadMinor);

  return {
    candidate,
    affordable,
    expectedCadMinor,
    availableBudgetCadMinor,
    shortfallMinor,
  };
}

const NON_APPROVABLE_STATUSES = new Set([
  "voting",
  "acquisition_pending",
  "acquired",
  "available",
  "rejected_unavailable",
]);

/**
 * Approve a winning candidate acquisition: reserves budget via a committed
 * expense. Exactly one commitment can exist per candidate, and the budget check
 * and the reservation commit atomically (a concurrent spend invalidates it).
 */
export async function approveCandidateAcquisition(
  candidateId: string,
  adminId: number
): Promise<{
  candidate: WantedCandidate;
  commitmentExpense: ExpenseRecord;
}> {
  const existing = await getWantedCandidate(candidateId);
  if (!existing) throw new Error(`Candidat ${candidateId} introuvable`);
  if (NON_APPROVABLE_STATUSES.has(existing.status)) {
    throw new Error(`Le candidat « ${existing.name} » ne peut pas être approuvé à partir du statut « ${WANTED_STATUS_LABELS[existing.status]} ».`);
  }
  if (!existing.expectedCadMinor || existing.expectedCadMinor <= 0) {
    throw new Error(`Le candidat « ${existing.name} » n'a pas de prix vérifié. Utilisez d'abord /price.`);
  }

  // Read the budget version BEFORE computing affordability; the commit fails if
  // any other budget-affecting write lands in between.
  const budgetVersion = await getBudgetVersionstamp();
  const evalResult = await evaluateCandidateAffordability(candidateId);
  if (!evalResult.affordable) {
    throw new Error(
      `Budget d'acquisition insuffisant. Requis : ${formatMoney(evalResult.expectedCadMinor, "CAD")}, disponible : ${formatMoney(evalResult.availableBudgetCadMinor, "CAD")}. Manque : ${formatMoney(evalResult.shortfallMinor, "CAD")}`
    );
  }

  const candidate = evalResult.candidate;
  const base = getConfig().BASE_CURRENCY;
  const usd = await convertCurrency(candidate.expectedCadMinor ?? 0, base, "USD");

  const commitmentExpense = await recordExpense(
    {
      description: `Acquisition Commitment: ${candidate.name}`,
      originalAmountMinor: candidate.expectedPriceMinor ?? candidate.expectedCadMinor ?? 0,
      originalCurrency: candidate.priceCurrency ?? base,
      cadAmountMinor: candidate.expectedCadMinor ?? 0,
      usdAmountMinor: usd.convertedAmountMinor,
      indicativeStarsAmount: 0,
      category: "creator_subscription",
      candidateId: candidate.id,
      expenseDate: new Date().toISOString(),
      status: "committed",
      payer: "club_funds",
    },
    {
      uniqueKey: ["candidate_commitment", candidate.id],
      expectedBudgetVersion: budgetVersion,
    }
  );

  const updatedCandidate = await patchWantedCandidate(candidate.id, {
    status: "acquisition_pending",
    notes: `Approved by admin ${adminId}`,
    commitmentExpenseId: commitmentExpense.id,
  });

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
 * Release the reserved budget of a pending acquisition and return the candidate
 * to the "selected" state.
 */
export async function cancelCandidateAcquisition(
  candidateId: string,
  adminId: number
): Promise<WantedCandidate> {
  const candidate = await getWantedCandidate(candidateId);
  if (!candidate) throw new Error(`Candidat ${candidateId} introuvable`);
  const committed = await listExpenses({ candidateId, status: "committed" });
  if (committed.length === 0) throw new Error("Aucun engagement actif pour ce candidat");
  for (const exp of committed) {
    await cancelExpense(exp.id, adminId);
  }
  const updated = await patchWantedCandidate(candidateId, {
    status: "selected",
    notes: `Acquisition cancelled by admin ${adminId}`,
    commitmentExpenseId: undefined,
  });
  return updated ?? candidate;
}

/**
 * Confirm that candidate acquisition payment has been made by an administrator.
 * Converts the commitment to paid (exactly once), journals the actual amounts,
 * and moves the candidate to acquired.
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
    throw new Error(`Candidat ${params.candidateId} introuvable`);
  }
  if (!EXPENSE_PAYERS.includes(params.payer)) {
    throw new Error(`Payeur inconnu « ${params.payer} »`);
  }
  if (candidate.status === "acquired" || candidate.status === "available") {
    throw new Error(`« ${candidate.name} » a déjà été acquis.`);
  }
  if (candidate.status === "rejected_unavailable") {
    throw new Error(`« ${candidate.name} » est marqué comme non disponible.`);
  }

  const committed = await listExpenses({ candidateId: candidate.id, status: "committed" });
  let expense: ExpenseRecord;

  if (committed.length > 0) {
    const commitment = committed[0];
    const patch: Partial<ExpenseRecord> = {
      payer: params.payer,
      paidByAdminId: params.payer === "admin_personal" ? params.adminId : undefined,
      reimbursementStatus: params.payer === "admin_personal" ? "pending" : undefined,
      expenseDate: new Date().toISOString(),
    };

    if (params.actualAmountMinor !== undefined) {
      if (!isPositiveInt(params.actualAmountMinor)) {
        throw new Error("Le montant réel doit être un nombre entier positif d'unités mineures");
      }
      const currency = normalizeCurrency(
        params.currency ?? candidate.priceCurrency ?? getConfig().BASE_CURRENCY
      );
      if (!isSupportedExpenseCurrency(currency)) throw new Error(`Devise non prise en charge « ${currency} »`);
      const conv = await convertToBaseCurrency(params.actualAmountMinor, currency);
      Object.assign(patch, {
        originalAmountMinor: params.actualAmountMinor,
        originalCurrency: currency,
        cadAmountMinor: conv.cadAmountMinor,
        usdAmountMinor: conv.usdAmountMinor,
        indicativeStarsAmount: conv.indicativeStars,
        fxRate: conv.rateToCad,
        fxRateDate: conv.rateDate,
        fxRateSource: conv.rateSource,
      });
    }

    const finalView = { ...commitment, ...patch } as ExpenseRecord;
    // Compare-and-set: a second confirmation finds no committed expense and fails
    // instead of posting the payment twice.
    expense = await transitionExpense(
      commitment.id,
      "committed",
      "paid",
      patch,
      paidExpenseJournal({
        id: commitment.id,
        description: `Acquisition paid: ${candidate.name}`,
        category: finalView.category,
        payer: params.payer,
        cadAmountMinor: finalView.cadAmountMinor,
      })
    );
  } else {
    // Not committed previously: record directly as paid, still within budget.
    const amountMinor = params.actualAmountMinor ?? candidate.expectedPriceMinor ?? 0;
    const currency = params.currency ?? candidate.priceCurrency ?? getConfig().BASE_CURRENCY;
    if (!isPositiveInt(amountMinor)) {
      throw new Error("Aucun prix enregistré : indiquez le montant réel payé.");
    }
    if (params.payer === "club_funds") {
      const conv = await convertToBaseCurrency(amountMinor, currency);
      const overview = await getTreasuryOverview();
      if (conv.cadAmountMinor > overview.availableAcquisitionBudgetCadMinor) {
        throw new Error(
          `Budget d'acquisition insuffisant pour un paiement avec les fonds du club de ${formatMoney(conv.cadAmountMinor, "CAD")}.`
        );
      }
    }

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
      uniqueKey: ["candidate_commitment", candidate.id],
    });
  }

  const updatedCandidate = await patchWantedCandidate(candidate.id, {
    status: "acquired",
    notes: `Acquisition confirmed by admin ${params.adminId}`,
  });

  await logAuditEvent(
    "expense_paid",
    { expenseId: expense.id, candidateId: candidate.id, amount: formatMoney(expense.cadAmountMinor, "CAD") },
    params.adminId
  );

  return {
    candidate: updatedCandidate ?? candidate,
    expense,
  };
}
