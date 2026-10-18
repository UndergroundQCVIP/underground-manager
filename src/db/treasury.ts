/**
 * Underground Manager — Treasury, Stars & Financial Journal Repository
 * Phase UG-03: Treasury, Expenses & Final Automation
 */

import { getKv } from "./kv.ts";
import {
  FinancialJournalEntry,
  JournalCategory,
  StarHoldingStatus,
  StarTransactionRecord,
  TreasuryAllocations,
  TreasuryMonthlyReport,
  TreasuryValuationConfig,
  WithdrawalRecord,
  WithdrawalSettlement,
} from "../types.ts";

export interface RecordStarTxResult {
  success: boolean;
  duplicate: boolean;
  record?: StarTransactionRecord;
  error?: string;
}

// ==============================================================================
// 1. Telegram Stars Transactions
// ==============================================================================

export async function recordStarTransaction(
  data: Omit<StarTransactionRecord, "id" | "createdAt">
): Promise<RecordStarTxResult> {
  const kv = await getKv();

  // Deduplication check via Telegram transaction ID
  const existingIdx = await kv.get<string>(["star_tx_by_telegram_id", data.telegramTxId]);
  if (existingIdx.value) {
    const existing = await kv.get<StarTransactionRecord>(["star_transactions", existingIdx.value]);
    return {
      success: false,
      duplicate: true,
      record: existing.value ?? undefined,
      error: `Duplicate Star transaction identifier: ${data.telegramTxId}`,
    };
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const record: StarTransactionRecord = {
    ...data,
    id,
    createdAt: now,
  };

  const atomic = kv.atomic();
  atomic.check({ key: ["star_tx_by_telegram_id", data.telegramTxId], versionstamp: null });
  atomic.set(["star_transactions", id], record);
  atomic.set(["star_tx_by_telegram_id", data.telegramTxId], id);
  if (data.userId) {
    atomic.set(["star_tx_by_user", data.userId, id], record);
  }
  atomic.set(["star_tx_by_status", data.status, id], record);

  const res = await atomic.commit();
  if (!res.ok) {
    const retryIdx = await kv.get<string>(["star_tx_by_telegram_id", data.telegramTxId]);
    if (retryIdx.value) {
      const existing = await kv.get<StarTransactionRecord>(["star_transactions", retryIdx.value]);
      return {
        success: false,
        duplicate: true,
        record: existing.value ?? undefined,
        error: `Concurrent duplicate Star transaction: ${data.telegramTxId}`,
      };
    }
    return {
      success: false,
      duplicate: false,
      error: "Atomic commit failed while saving Star transaction",
    };
  }

  return { success: true, duplicate: false, record };
}

export async function getStarTransaction(id: string): Promise<StarTransactionRecord | null> {
  const kv = await getKv();
  const res = await kv.get<StarTransactionRecord>(["star_transactions", id]);
  return res.value ?? null;
}

export async function getStarTransactionByTelegramId(
  telegramTxId: string
): Promise<StarTransactionRecord | null> {
  const kv = await getKv();
  const idx = await kv.get<string>(["star_tx_by_telegram_id", telegramTxId]);
  if (!idx.value) return null;
  return await getStarTransaction(idx.value);
}

/** Lists Star transactions; without `limit` every record is returned (totals must never be truncated). */
export async function listStarTransactions(limit?: number): Promise<StarTransactionRecord[]> {
  const kv = await getKv();
  const iter = kv.list<StarTransactionRecord>(
    { prefix: ["star_transactions"] },
    limit ? { limit } : undefined
  );
  const records: StarTransactionRecord[] = [];
  for await (const entry of iter) {
    if (entry.value) {
      records.push(entry.value);
    }
  }
  return records.sort(
    (a, b) => new Date(b.txTimestamp).getTime() - new Date(a.txTimestamp).getTime()
  );
}

export async function updateStarTransactionStatus(
  id: string,
  newStatus: StarHoldingStatus
): Promise<StarTransactionRecord | null> {
  const kv = await getKv();
  const res = await kv.get<StarTransactionRecord>(["star_transactions", id]);
  if (!res.value) return null;

  const oldRecord = res.value;
  if (oldRecord.status === newStatus) return oldRecord;

  const updated: StarTransactionRecord = {
    ...oldRecord,
    status: newStatus,
  };

  const atomic = kv.atomic();
  atomic.check(res);
  atomic.set(["star_transactions", id], updated);
  atomic.delete(["star_tx_by_status", oldRecord.status, id]);
  atomic.set(["star_tx_by_status", newStatus, id], updated);
  if (updated.userId) {
    atomic.set(["star_tx_by_user", updated.userId, id], updated);
  }

  const commitRes = await atomic.commit();
  if (!commitRes.ok) {
    throw new Error(`Failed to update status for Star transaction ${id}`);
  }

  return updated;
}

// ==============================================================================
// 2. Stars Reconciliation Checkpoints
// ==============================================================================

export interface StarCheckpoint {
  offset: number;
  lastReconciledAt: string;
  totalSyncedCount: number;
}

export async function getStarReconciliationCheckpoint(): Promise<StarCheckpoint> {
  const kv = await getKv();
  const res = await kv.get<StarCheckpoint>(["treasury_checkpoints", "stars_offset"]);
  return (
    res.value ?? {
      offset: 0,
      lastReconciledAt: new Date(0).toISOString(),
      totalSyncedCount: 0,
    }
  );
}

export async function saveStarReconciliationCheckpoint(checkpoint: StarCheckpoint): Promise<void> {
  const kv = await getKv();
  await kv.set(["treasury_checkpoints", "stars_offset"], checkpoint);
}

// ==============================================================================
// 3. Withdrawals & Settlements
// ==============================================================================

export async function recordWithdrawal(
  data: Omit<WithdrawalRecord, "id" | "createdAt" | "updatedAt">
): Promise<WithdrawalRecord> {
  const kv = await getKv();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const record: WithdrawalRecord = {
    ...data,
    id,
    createdAt: now,
    updatedAt: now,
  };

  const atomic = kv.atomic();
  if (record.fragmentReference) {
    // A Fragment/TON withdrawal reference identifies one withdrawal: refuse re-entry
    // (double submission would otherwise credit the same proceeds twice).
    const refKey = ["withdrawals_by_reference", record.fragmentReference];
    atomic.check({ key: refKey, versionstamp: null });
    atomic.set(refKey, id);
  }
  atomic.set(["withdrawals", id], record);
  atomic.set(["withdrawals_by_date", record.withdrawalDate, id], record);
  const res = await atomic.commit();
  if (!res.ok) {
    throw new Error(
      record.fragmentReference
        ? `Withdrawal with reference ${record.fragmentReference} is already recorded`
        : "Failed to record withdrawal"
    );
  }

  return record;
}

export async function getWithdrawal(id: string): Promise<WithdrawalRecord | null> {
  const kv = await getKv();
  const res = await kv.get<WithdrawalRecord>(["withdrawals", id]);
  return res.value ?? null;
}

export async function listWithdrawals(limit?: number): Promise<WithdrawalRecord[]> {
  const kv = await getKv();
  const iter = kv.list<WithdrawalRecord>(
    { prefix: ["withdrawals"] },
    limit ? { limit } : undefined
  );
  const records: WithdrawalRecord[] = [];
  for await (const entry of iter) {
    if (entry.value) {
      records.push(entry.value);
    }
  }
  return records.sort(
    (a, b) => new Date(b.withdrawalDate).getTime() - new Date(a.withdrawalDate).getTime()
  );
}

export async function recordWithdrawalSettlement(
  withdrawalId: string,
  settlement: WithdrawalSettlement,
  journal: JournalDraft[] = []
): Promise<WithdrawalRecord | null> {
  const kv = await getKv();
  const currentRes = await kv.get<WithdrawalRecord>(["withdrawals", withdrawalId]);
  const current = currentRes.value;
  if (!current) return null;
  if (current.status === "completed") {
    throw new Error(`Withdrawal ${withdrawalId} is already settled`);
  }

  const now = new Date().toISOString();
  const updated: WithdrawalRecord = {
    ...current,
    status: "completed",
    settlement,
    updatedAt: now,
  };

  const atomic = kv.atomic();
  atomic.check(currentRes);
  atomic.set(["withdrawals", withdrawalId], updated);
  atomic.set(["withdrawals_by_date", updated.withdrawalDate, withdrawalId], updated);
  stageJournalEntries(atomic, journal);
  stageBudgetVersionBump(atomic);
  const res = await atomic.commit();
  if (!res.ok) {
    throw new Error(`Failed to commit settlement for withdrawal ${withdrawalId}`);
  }

  return updated;
}

// ==============================================================================
// 4. Financial Journal (Append-Only)
// ==============================================================================

export type JournalDraft = Omit<FinancialJournalEntry, "id" | "timestamp">;

/** Version stamp key bumped by every commit that changes available budget. */
export const BUDGET_VERSION_KEY: Deno.KvKey = ["treasury_budget_version"];

/** Stages a budget-version bump on an atomic operation (optimistic budget lock). */
export function stageBudgetVersionBump(atomic: Deno.AtomicOperation): void {
  atomic.set(BUDGET_VERSION_KEY, crypto.randomUUID());
}

export async function getBudgetVersionstamp(): Promise<string | null> {
  const kv = await getKv();
  const res = await kv.get(BUDGET_VERSION_KEY);
  return res.versionstamp;
}

/**
 * Stages append-only journal entries on an existing atomic operation so that
 * business records and their ledger postings commit (or fail) together.
 */
export function stageJournalEntries(
  atomic: Deno.AtomicOperation,
  drafts: JournalDraft[]
): FinancialJournalEntry[] {
  const timestamp = new Date().toISOString();
  return drafts.map((draft) => {
    const entry: FinancialJournalEntry = { ...draft, id: crypto.randomUUID(), timestamp };
    atomic.set(["journal_entries", entry.id], entry);
    atomic.set(["journal_by_category", entry.category, entry.id], entry);
    atomic.set(["journal_by_timestamp", entry.timestamp, entry.id], entry);
    return entry;
  });
}

export async function recordJournalEntry(
  data: JournalDraft
): Promise<FinancialJournalEntry> {
  const kv = await getKv();
  const atomic = kv.atomic();
  const [entry] = stageJournalEntries(atomic, [data]);
  stageBudgetVersionBump(atomic);

  const res = await atomic.commit();
  if (!res.ok) {
    throw new Error("Failed to record financial journal entry");
  }

  return entry;
}

export async function listJournalEntries(limit?: number): Promise<FinancialJournalEntry[]> {
  const kv = await getKv();
  const iter = kv.list<FinancialJournalEntry>(
    { prefix: ["journal_entries"] },
    limit ? { limit } : undefined
  );
  const entries: FinancialJournalEntry[] = [];
  for await (const item of iter) {
    if (item.value) {
      entries.push(item.value);
    }
  }
  return entries.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
}

export async function getJournalBalanceByCategory(category: JournalCategory): Promise<number> {
  const kv = await getKv();
  const iter = kv.list<FinancialJournalEntry>({ prefix: ["journal_by_category", category] });
  let totalMinor = 0;
  for await (const item of iter) {
    if (item.value) {
      totalMinor += item.value.amountMinor;
    }
  }
  return totalMinor;
}

export async function getAllJournalBalances(): Promise<Record<JournalCategory, number>> {
  const categories: JournalCategory[] = [
    "settled_cash",
    "acquisition_fund",
    "operations_fund",
    "reserve_fund",
    "admin_liability",
  ];
  const balances: Record<JournalCategory, number> = {
    settled_cash: 0,
    acquisition_fund: 0,
    operations_fund: 0,
    reserve_fund: 0,
    admin_liability: 0,
  };

  for (const cat of categories) {
    balances[cat] = await getJournalBalanceByCategory(cat);
  }
  return balances;
}

// ==============================================================================
// 5. Allocations & Valuation Configuration
// ==============================================================================

export async function getTreasuryAllocations(): Promise<TreasuryAllocations> {
  const kv = await getKv();
  const res = await kv.get<TreasuryAllocations>(["treasury_settings", "allocations"]);
  if (res.value) return res.value;

  // Defaults: 60% acquisitions, 25% operations, 15% reserve
  return {
    acquisitionPct: 60,
    operationsPct: 25,
    reservePct: 15,
    effectiveDate: new Date().toISOString(),
  };
}

export async function saveTreasuryAllocations(
  allocations: TreasuryAllocations
): Promise<void> {
  const parts = [allocations.acquisitionPct, allocations.operationsPct, allocations.reservePct];
  if (parts.some((p) => !Number.isInteger(p) || p < 0)) {
    throw new Error("Treasury allocation percentages must be non-negative whole numbers");
  }
  const total = parts[0] + parts[1] + parts[2];
  if (total !== 100) {
    throw new Error(`Treasury allocations must sum exactly to 100% (currently ${total}%)`);
  }

  const kv = await getKv();
  const atomic = kv.atomic();
  atomic.set(["treasury_settings", "allocations"], allocations);
  atomic.set(["treasury_allocations_history", allocations.effectiveDate], allocations);
  const res = await atomic.commit();
  if (!res.ok) {
    throw new Error("Failed to save treasury allocations");
  }
}

export async function getValuationConfig(): Promise<TreasuryValuationConfig> {
  const kv = await getKv();
  const res = await kv.get<TreasuryValuationConfig>(["treasury_settings", "valuation"]);
  if (res.value) return res.value;

  // Default published developer reward reference: US$0.013 per Star
  return {
    starsRewardValuationUsd: 0.013,
    effectiveDate: new Date().toISOString(),
    notes: "Default Telegram developer reward assumption (US$0.013/Star)",
  };
}

export async function saveValuationConfig(config: TreasuryValuationConfig): Promise<void> {
  if (config.starsRewardValuationUsd <= 0) {
    throw new Error("Stars reward valuation must be positive");
  }
  const kv = await getKv();
  await kv.set(["treasury_settings", "valuation"], config);
}

// ==============================================================================
// 6. Monthly Reports
// ==============================================================================

export async function saveTreasuryReport(report: TreasuryMonthlyReport): Promise<void> {
  const kv = await getKv();
  const atomic = kv.atomic();
  atomic.set(["treasury_reports", report.period], report);
  atomic.set(["treasury_reports_by_id", report.id], report);
  const res = await atomic.commit();
  if (!res.ok) {
    throw new Error(`Failed to save treasury report for period ${report.period}`);
  }
}

export async function getTreasuryReport(period: string): Promise<TreasuryMonthlyReport | null> {
  const kv = await getKv();
  const res = await kv.get<TreasuryMonthlyReport>(["treasury_reports", period]);
  return res.value ?? null;
}

export async function listTreasuryReports(limit = 24): Promise<TreasuryMonthlyReport[]> {
  const kv = await getKv();
  const iter = kv.list<TreasuryMonthlyReport>({ prefix: ["treasury_reports"] }, { limit });
  const reports: TreasuryMonthlyReport[] = [];
  for await (const entry of iter) {
    if (entry.value) {
      reports.push(entry.value);
    }
  }
  return reports.sort((a, b) => b.period.localeCompare(a.period));
}
