/**
 * Underground Manager — Expense & Budget Repository
 * Phase UG-03: Treasury, Expenses & Final Automation
 */

import { getKv } from "./kv.ts";
import { JournalDraft, stageBudgetVersionBump, stageJournalEntries } from "./treasury.ts";
import {
  ExpenseCategory,
  ExpenseRecord,
  ExpenseStatus,
  RecurringExpenseTemplate,
  WantedCandidate,
} from "../types.ts";

export interface ExpenseFilter {
  status?: ExpenseStatus;
  category?: ExpenseCategory;
  creatorId?: string;
  candidateId?: string;
  payer?: "club_funds" | "admin_personal";
  month?: string; // YYYY-MM
  limit?: number;
}

// ==============================================================================
// 1. Expense Records
// ==============================================================================

export interface RecordExpenseOptions {
  /** Ledger postings committed atomically with the expense (may depend on the generated id). */
  journal?: JournalDraft[] | ((expense: ExpenseRecord) => JournalDraft[]);
  /** When set, the commit fails if this key already exists (single-commitment guard). */
  uniqueKey?: Deno.KvKey;
  /** When set, the commit fails if the budget changed since this versionstamp. */
  expectedBudgetVersion?: string | null;
}

export async function recordExpense(
  data: Omit<ExpenseRecord, "id" | "createdAt" | "updatedAt">,
  options: RecordExpenseOptions = {}
): Promise<ExpenseRecord> {
  const kv = await getKv();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const record: ExpenseRecord = {
    ...data,
    id,
    createdAt: now,
    updatedAt: now,
  };

  const atomic = kv.atomic();
  atomic.set(["expenses", id], record);
  atomic.set(["expenses_by_status", record.status, id], record);
  atomic.set(["expenses_by_category", record.category, id], record);
  atomic.set(["expenses_by_date", record.expenseDate, id], record);

  if (record.creatorId) {
    atomic.set(["expenses_by_creator", record.creatorId, id], record);
  }
  if (record.candidateId) {
    atomic.set(["expenses_by_candidate", record.candidateId, id], record);
  }
  if (record.adjustmentOfId) {
    atomic.set(["expenses_adjustments", record.adjustmentOfId, id], record);
  }
  if (options.uniqueKey) {
    atomic.check({ key: options.uniqueKey, versionstamp: null });
    atomic.set(options.uniqueKey, id);
  }
  if (options.expectedBudgetVersion !== undefined) {
    atomic.check({
      key: ["treasury_budget_version"],
      versionstamp: options.expectedBudgetVersion,
    });
  }
  const drafts =
    typeof options.journal === "function" ? options.journal(record) : options.journal ?? [];
  if (drafts.length) {
    stageJournalEntries(atomic, drafts);
  }
  stageBudgetVersionBump(atomic);

  const res = await atomic.commit();
  if (!res.ok) {
    throw new Error(
      options.uniqueKey || options.expectedBudgetVersion !== undefined
        ? "Expense was not recorded: a concurrent budget change or duplicate commitment was detected. Please retry."
        : "Failed to record expense"
    );
  }

  return record;
}

export async function getExpense(id: string): Promise<ExpenseRecord | null> {
  const kv = await getKv();
  const res = await kv.get<ExpenseRecord>(["expenses", id]);
  return res.value ?? null;
}

export async function listExpenses(filter?: ExpenseFilter): Promise<ExpenseRecord[]> {
  const kv = await getKv();
  // No cap at the storage layer: financial totals are derived from this list.
  // `filter.limit` only trims the (newest-first) result for display purposes.
  const listOptions = undefined;

  let iter: Deno.KvListIterator<ExpenseRecord>;
  if (filter?.status) {
    iter = kv.list<ExpenseRecord>({ prefix: ["expenses_by_status", filter.status] }, listOptions);
  } else if (filter?.category) {
    iter = kv.list<ExpenseRecord>({ prefix: ["expenses_by_category", filter.category] }, listOptions);
  } else if (filter?.creatorId) {
    iter = kv.list<ExpenseRecord>({ prefix: ["expenses_by_creator", filter.creatorId] }, listOptions);
  } else if (filter?.candidateId) {
    iter = kv.list<ExpenseRecord>({ prefix: ["expenses_by_candidate", filter.candidateId] }, listOptions);
  } else {
    iter = kv.list<ExpenseRecord>({ prefix: ["expenses"] }, listOptions);
  }

  const expenses: ExpenseRecord[] = [];
  for await (const entry of iter) {
    if (entry.value) {
      const exp = entry.value;
      if (filter?.payer && exp.payer !== filter.payer) continue;
      if (filter?.month && !exp.expenseDate.startsWith(filter.month)) continue;
      expenses.push(exp);
    }
  }

  expenses.sort(
    (a, b) => new Date(b.expenseDate).getTime() - new Date(a.expenseDate).getTime()
  );
  return filter?.limit ? expenses.slice(0, filter.limit) : expenses;
}

export async function updateExpenseStatus(
  id: string,
  newStatus: ExpenseStatus
): Promise<ExpenseRecord | null> {
  const kv = await getKv();
  const res = await kv.get<ExpenseRecord>(["expenses", id]);
  if (!res.value) return null;

  const old = res.value;
  if (old.status === newStatus) return old;

  const now = new Date().toISOString();
  const updated: ExpenseRecord = {
    ...old,
    status: newStatus,
    updatedAt: now,
  };

  const atomic = kv.atomic();
  atomic.check(res);
  atomic.set(["expenses", id], updated);
  atomic.delete(["expenses_by_status", old.status, id]);
  atomic.set(["expenses_by_status", newStatus, id], updated);
  atomic.set(["expenses_by_category", updated.category, id], updated);

  if (updated.candidateId) {
    atomic.set(["expenses_by_candidate", updated.candidateId, id], updated);
  }
  if (updated.creatorId) {
    atomic.set(["expenses_by_creator", updated.creatorId, id], updated);
  }
  stageBudgetVersionBump(atomic);

  const resCommit = await atomic.commit();
  if (!resCommit.ok) {
    throw new Error(`Failed to update status for expense ${id}`);
  }

  return updated;
}

/**
 * Atomically moves an expense from `expectedStatus` to a new status while
 * applying field changes and ledger postings in the same commit. Fails (instead
 * of double-posting) when the expense is no longer in `expectedStatus`.
 */
export async function transitionExpense(
  id: string,
  expectedStatus: ExpenseStatus,
  newStatus: ExpenseStatus,
  patch: Partial<ExpenseRecord>,
  journal: JournalDraft[] = []
): Promise<ExpenseRecord> {
  const kv = await getKv();
  const res = await kv.get<ExpenseRecord>(["expenses", id]);
  const old = res.value;
  if (!old) throw new Error(`Expense ${id} not found`);
  if (old.status !== expectedStatus) {
    throw new Error(`Expense ${id} is ${old.status}, expected ${expectedStatus}`);
  }

  const updated: ExpenseRecord = {
    ...old,
    ...patch,
    id: old.id,
    status: newStatus,
    updatedAt: new Date().toISOString(),
  };

  const atomic = kv.atomic();
  atomic.check(res);
  atomic.set(["expenses", id], updated);
  atomic.delete(["expenses_by_status", old.status, id]);
  atomic.set(["expenses_by_status", newStatus, id], updated);
  atomic.set(["expenses_by_category", updated.category, id], updated);
  if (updated.candidateId) atomic.set(["expenses_by_candidate", updated.candidateId, id], updated);
  if (updated.creatorId) atomic.set(["expenses_by_creator", updated.creatorId, id], updated);
  stageJournalEntries(atomic, journal);
  stageBudgetVersionBump(atomic);

  const commit = await atomic.commit();
  if (!commit.ok) {
    throw new Error(`Expense ${id} changed concurrently; transition not applied`);
  }
  return updated;
}

export async function listExpenseAdjustments(originalId: string): Promise<ExpenseRecord[]> {
  const kv = await getKv();
  const iter = kv.list<ExpenseRecord>({ prefix: ["expenses_adjustments", originalId] });
  const out: ExpenseRecord[] = [];
  for await (const entry of iter) {
    if (entry.value) out.push(entry.value);
  }
  return out;
}

/**
 * Marks an administrator-paid expense as reimbursed exactly once; the ledger
 * postings are committed in the same atomic operation.
 */
export async function markExpenseReimbursed(
  id: string,
  journal: JournalDraft[] = []
): Promise<ExpenseRecord | null> {
  const kv = await getKv();
  const res = await kv.get<ExpenseRecord>(["expenses", id]);
  if (!res.value) return null;

  const old = res.value;
  if (old.payer !== "admin_personal") {
    throw new Error(`Expense ${id} was not paid personally by an administrator`);
  }
  if (old.status !== "paid") {
    throw new Error(`Expense ${id} is ${old.status}; only paid expenses can be reimbursed`);
  }
  if (old.reimbursementStatus !== "pending") {
    throw new Error(`Expense ${id} reimbursement is already ${old.reimbursementStatus ?? "settled"}`);
  }

  const now = new Date().toISOString();
  const updated: ExpenseRecord = {
    ...old,
    reimbursementStatus: "reimbursed",
    reimbursedAt: now,
    updatedAt: now,
  };

  const atomic = kv.atomic();
  atomic.check(res);
  atomic.set(["expenses", id], updated);
  atomic.set(["expenses_by_status", updated.status, id], updated);
  if (updated.candidateId) {
    atomic.set(["expenses_by_candidate", updated.candidateId, id], updated);
  }
  if (updated.creatorId) {
    atomic.set(["expenses_by_creator", updated.creatorId, id], updated);
  }
  stageJournalEntries(atomic, journal);
  stageBudgetVersionBump(atomic);
  const resCommit = await atomic.commit();
  if (!resCommit.ok) {
    throw new Error(`Failed to mark expense ${id} as reimbursed (concurrent change)`);
  }

  return updated;
}

export async function recordExpenseAdjustment(
  originalExpenseId: string,
  data: Omit<ExpenseRecord, "id" | "createdAt" | "updatedAt" | "adjustmentOfId">,
  options: RecordExpenseOptions = {}
): Promise<ExpenseRecord> {
  const original = await getExpense(originalExpenseId);
  if (!original) {
    throw new Error(`Original expense ${originalExpenseId} not found`);
  }

  return await recordExpense(
    {
      ...data,
      adjustmentOfId: originalExpenseId,
    },
    options
  );
}

// ==============================================================================
// 2. Recurring Expense Templates
// ==============================================================================

export async function recordRecurringTemplate(
  data: Omit<RecurringExpenseTemplate, "id" | "createdAt" | "updatedAt">
): Promise<RecurringExpenseTemplate> {
  const kv = await getKv();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const record: RecurringExpenseTemplate = {
    ...data,
    id,
    createdAt: now,
    updatedAt: now,
  };

  const atomic = kv.atomic();
  atomic.set(["recurring_expense_templates", id], record);
  atomic.set(["recurring_expense_by_status", record.status, id], record);
  const res = await atomic.commit();
  if (!res.ok) {
    throw new Error("Failed to record recurring expense template");
  }

  return record;
}

export async function getRecurringTemplate(id: string): Promise<RecurringExpenseTemplate | null> {
  const kv = await getKv();
  const res = await kv.get<RecurringExpenseTemplate>(["recurring_expense_templates", id]);
  return res.value ?? null;
}

export async function listRecurringTemplates(): Promise<RecurringExpenseTemplate[]> {
  const kv = await getKv();
  const iter = kv.list<RecurringExpenseTemplate>({ prefix: ["recurring_expense_templates"] });
  const templates: RecurringExpenseTemplate[] = [];
  for await (const entry of iter) {
    if (entry.value) {
      templates.push(entry.value);
    }
  }
  return templates;
}

export async function updateRecurringTemplate(
  id: string,
  patch: Partial<Omit<RecurringExpenseTemplate, "id" | "createdAt">>
): Promise<RecurringExpenseTemplate | null> {
  const current = await getRecurringTemplate(id);
  if (!current) return null;

  const now = new Date().toISOString();
  const updated: RecurringExpenseTemplate = {
    ...current,
    ...patch,
    updatedAt: now,
  };

  const kv = await getKv();
  const atomic = kv.atomic();
  atomic.set(["recurring_expense_templates", id], updated);
  if (patch.status && patch.status !== current.status) {
    atomic.delete(["recurring_expense_by_status", current.status, id]);
    atomic.set(["recurring_expense_by_status", patch.status, id], updated);
  }

  const res = await atomic.commit();
  if (!res.ok) {
    throw new Error(`Failed to update recurring expense template ${id}`);
  }

  return updated;
}

// ==============================================================================
// 3. Wanted Candidate Pricing Integration
// ==============================================================================

export interface CandidatePricingUpdate {
  expectedPriceMinor: number;
  priceCurrency: string;
  expectedCadMinor: number;
  recurringCostMinor?: number;
  rightsVerified?: boolean;
  notes?: string;
}

export async function updateCandidatePricing(
  candidateId: string,
  pricing: CandidatePricingUpdate
): Promise<WantedCandidate | null> {
  const kv = await getKv();
  const res = await kv.get<WantedCandidate>(["wanted_candidates", candidateId]);
  if (!res.value) return null;

  const candidate = res.value;
  const now = new Date().toISOString();

  const updated: WantedCandidate = {
    ...candidate,
    expectedPriceMinor: pricing.expectedPriceMinor,
    priceCurrency: pricing.priceCurrency.toUpperCase(),
    expectedCadMinor: pricing.expectedCadMinor,
    recurringCostMinor: pricing.recurringCostMinor,
    rightsVerified: pricing.rightsVerified ?? candidate.rightsVerified ?? false,
    pricingVerifiedAt: now,
    notes: pricing.notes ?? candidate.notes,
    updatedAt: now,
  };

  const atomic = kv.atomic();
  atomic.set(["wanted_candidates", candidateId], updated);
  atomic.set(["wanted_by_status", updated.status, candidateId], updated);
  const commitRes = await atomic.commit();
  if (!commitRes.ok) {
    throw new Error(`Failed to update pricing for candidate ${candidateId}`);
  }

  return updated;
}
