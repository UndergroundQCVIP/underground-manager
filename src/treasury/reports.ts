/**
 * Underground Manager — Treasury Reporting Engine
 * Phase UG-03: Treasury, Expenses & Final Automation
 */

import { Api } from "grammy";
import { formatTorontoDate } from "../util/time.ts";
import { getConfig } from "../config.ts";
import { logAuditEvent } from "../db/audit.ts";
import {
  countActiveComplimentaryMembers,
  countActivePaidSubscribers,
} from "../db/entitlements.ts";
import { listStarTransactions, listWithdrawals, saveTreasuryReport } from "../db/treasury.ts";
import { listExpenses } from "../db/expenses.ts";
import { escapeMd } from "../util/markdown.ts";
import { torontoMonthCycle } from "../util/time.ts";
import { listWantedCandidates } from "../db/wanted.ts";
import { TreasuryMonthlyReport, WantedCandidate } from "../types.ts";
import { formatMoney } from "./conversion.ts";
import { getTreasuryOverview } from "./service.ts";

/**
 * Generate a complete Treasury Monthly Report.
 */
export async function generateMonthlyTreasuryReport(
  period?: string
): Promise<TreasuryMonthlyReport> {
  const currentPeriod = period ?? torontoMonthCycle(); // "YYYY-MM" in America/Toronto
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(currentPeriod)) {
    throw new Error(`Invalid report period "${currentPeriod}" (expected YYYY-MM)`);
  }
  const overview = await getTreasuryOverview();
  const inPeriod = (iso: string) => torontoMonthCycle(new Date(iso)) === currentPeriod;

  // Flows inside the period (the overview holds balances as of now).
  const [stars, withdrawals, expenses] = await Promise.all([
    listStarTransactions(),
    listWithdrawals(),
    listExpenses(),
  ]);
  const periodActivity = {
    starsReceived: stars
      .filter((t) => t.starsAmount > 0 && t.status !== "refunded" && inPeriod(t.txTimestamp))
      .reduce((sum, t) => sum + t.starsAmount, 0),
    settledCashCadMinor: withdrawals
      .filter((w) => w.status === "completed" && w.settlement && inPeriod(w.settlement.settlementDate))
      .reduce((sum, w) => sum + (w.settlement?.netFundsReceivedMinor ?? 0), 0),
    paidExpensesCadMinor: expenses
      .filter((e) => (e.status === "paid" || (e.adjustmentOfId && e.status === "refunded")) && inPeriod(e.expenseDate))
      .reduce((sum, e) => sum + e.cadAmountMinor, 0),
  };

  const [activePaidSubscribersCount, complimentaryMembersCount, allCandidates] =
    await Promise.all([
      countActivePaidSubscribers(),
      countActiveComplimentaryMembers(),
      listWantedCandidates(),
    ]);

  // Filter creators acquired in this month
  const acquiredCandidates = allCandidates.filter(
    (c: WantedCandidate) =>
      (c.status === "acquired" || c.status === "available") &&
      inPeriod(c.updatedAt)
  );
  const creatorsAcquiredThisMonth = acquiredCandidates.map((c: WantedCandidate) => c.name);

  // Filter nominations created this month
  const newNominationsCount = allCandidates.filter((c: WantedCandidate) =>
    inPeriod(c.createdAt)
  ).length;

  const id = crypto.randomUUID();
  const report: TreasuryMonthlyReport = {
    id,
    period: currentPeriod,
    overview,
    activePaidSubscribersCount,
    complimentaryMembersCount,
    creatorsAcquiredThisMonth,
    newNominationsCount,
    periodActivity,
    generatedAt: new Date().toISOString(),
  };

  await saveTreasuryReport(report);

  await logAuditEvent(
    "treasury_report_generated",
    {
      period: report.period,
      settledNetCash: formatMoney(overview.settledNetCashCadMinor, "CAD"),
      availableAcquisitionBudget: formatMoney(
        overview.availableAcquisitionBudgetCadMinor,
        "CAD"
      ),
    },
    0
  );

  return report;
}

/**
 * Format transparent Member Report for private channel publication.
 */
export function formatPrivateMemberReport(report: TreasuryMonthlyReport): string {
  const o = report.overview;

  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const [yearStr, monthStr] = report.period.split("-");
  const monthIdx = parseInt(monthStr, 10) - 1;
  const periodLabel = `${monthNames[monthIdx] ?? monthStr} ${yearStr}`;

  const acquiredList =
    report.creatorsAcquiredThisMonth.length > 0
      ? report.creatorsAcquiredThisMonth.map(escapeMd).join(", ")
      : "None this cycle";

  return (
    `🏛️ *UNDERGROUND TREASURY REPORT*\n` +
    `📅 *${periodLabel}*\n\n` +
    (report.periodActivity
      ? `📆 *This Month:*\n` +
        `• Stars Received: *${report.periodActivity.starsReceived.toLocaleString()} ⭐*\n` +
        `• Cash Settled: *${formatMoney(report.periodActivity.settledCashCadMinor, "CAD")}*\n` +
        `• Expenses Paid: *${formatMoney(report.periodActivity.paidExpensesCadMinor, "CAD")}*\n\n`
      : "") +
    `💰 *Revenue & Inflows (all time):*\n` +
    `• Stars Received: *${o.totalStarsReceived.toLocaleString()} ⭐*\n` +
    `• Pending Settlement (21-Day Hold): *${o.pendingStars.toLocaleString()} ⭐* (~${formatMoney(o.estimatedPendingRewardsCadMinor, "CAD")} est.)\n` +
    `• Potentially Withdrawable: *${o.potentiallyWithdrawableStars.toLocaleString()} ⭐* (~${formatMoney(o.estimatedWithdrawableRewardsCadMinor, "CAD")} est.)\n` +
    `• Confirmed Settled Cash: *${formatMoney(o.settledNetCashCadMinor, "CAD")}*\n` +
    `• Cash On Hand: *${formatMoney(o.cashOnHandCadMinor, "CAD")}*\n\n` +
    `💸 *Expenses & Commitments:*\n` +
    `• Creator Acquisitions: *${formatMoney(o.paidAcquisitionsCadMinor, "CAD")}*\n` +
    `• Platform Operations & Mktg: *${formatMoney(o.paidOperationsCadMinor, "CAD")}*\n` +
    `• Active Commitments: *${formatMoney(o.committedAcquisitionsCadMinor, "CAD")}*\n\n` +
    `🎯 *Budget & Allocations:*\n` +
    `• Acquisition Budget Available: *${formatMoney(o.availableAcquisitionBudgetCadMinor, "CAD")}*\n` +
    `• Operations Allocation: *${formatMoney(o.allocatedOperationsCadMinor, "CAD")}*\n` +
    `• Protected Contingency Reserve: *${formatMoney(o.allocatedReserveCadMinor, "CAD")}*\n\n` +
    `👥 *Community & Governance:*\n` +
    `• Active Paying Subscribers: *${report.activePaidSubscribersCount}*\n` +
    `• Complimentary Members: *${report.complimentaryMembersCount}*\n` +
    `• Creators Acquired: *${acquiredList}*\n` +
    `• New Nominations: *${report.newNominationsCount}*\n\n` +
    `_All acquisition decisions are governed by active subscriber votes._`
  );
}

/**
 * Format detailed Administrator Audit Report.
 */
export function formatDetailedAdminReport(report: TreasuryMonthlyReport): string {
  const o = report.overview;

  return (
    `📊 *DETAILED TREASURY AUDIT REPORT*\n` +
    `*Period:* ${report.period} | *Generated:* ${formatTorontoDate(report.generatedAt, { dateStyle: "medium", timeStyle: "short" })}\n\n` +
    `*1. Telegram Stars Breakdown:*\n` +
    `• Total Stars Received: ${o.totalStarsReceived} ⭐\n` +
    `• Pending Stars (< 21 days): ${o.pendingStars} ⭐ (${formatMoney(o.estimatedPendingRewardsCadMinor, "CAD")} est.)\n` +
    `• Withdrawable Stars (>= 21 days): ${o.potentiallyWithdrawableStars} ⭐ (${formatMoney(o.estimatedWithdrawableRewardsCadMinor, "CAD")} est.)\n` +
    `• Withdrawn Stars: ${o.withdrawnStars} ⭐ (recorded withdrawals: ${o.recordedWithdrawalStars} ⭐, Telegram reports: ${o.telegramWithdrawnStars} ⭐)\n` +
    `• Refunded Stars (excluded): ${o.refundedStars} ⭐\n\n` +
    `*2. Settled Fiat Cash (CAD):*\n` +
    `• Total Settled Cash: ${formatMoney(o.settledNetCashCadMinor, "CAD")}\n` +
    `• Allocated to Acquisitions: ${formatMoney(o.allocatedAcquisitionsCadMinor, "CAD")}\n` +
    `• Allocated to Operations: ${formatMoney(o.allocatedOperationsCadMinor, "CAD")}\n` +
    `• Allocated to Reserve: ${formatMoney(o.allocatedReserveCadMinor, "CAD")}\n\n` +
    `*3. Outlays & Obligations:*\n` +
    `• Paid Acquisitions: ${formatMoney(o.paidAcquisitionsCadMinor, "CAD")}\n` +
    `• Paid Operations: ${formatMoney(o.paidOperationsCadMinor, "CAD")}\n` +
    `• Paid Other: ${formatMoney(o.paidOtherCadMinor, "CAD")}\n` +
    `• Total Paid: ${formatMoney(o.totalPaidExpensesCadMinor, "CAD")}\n` +
    `• Active Commitments: ${formatMoney(o.committedAcquisitionsCadMinor, "CAD")}\n` +
    `• Unreimbursed Admin Outlays: ${formatMoney(o.adminReimbursementsOwedCadMinor, "CAD")}\n\n` +
    `*4. Net Acquisition Purchasing Power:*\n` +
    `• Available Acquisition Budget: *${formatMoney(o.availableAcquisitionBudgetCadMinor, "CAD")}*`
  );
}

/**
 * Publish the monthly report to the configured private Telegram channel.
 */
export async function publishMonthlyReportToChannel(
  api: Api,
  report: TreasuryMonthlyReport
): Promise<boolean> {
  const config = getConfig();
  const targetChatId =
    config.TREASURY_REPORT_CHANNEL_ID !== 0
      ? config.TREASURY_REPORT_CHANNEL_ID
      : config.WANTED_LIST_CHAT_ID;

  if (!targetChatId) {
    console.warn("[Treasury] No channel configured for Treasury report publication.");
    return false;
  }

  const text = formatPrivateMemberReport(report);

  try {
    const sent = await api.sendMessage(targetChatId, text, {
      parse_mode: "Markdown",
    });

    report.publishedMessageId = sent.message_id;
    await saveTreasuryReport(report);
    return true;
  } catch (err) {
    console.error(`[Treasury] Failed to publish report to channel ${targetChatId}:`, err);
    return false;
  }
}
