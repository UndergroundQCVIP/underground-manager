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
    "janvier", "février", "mars", "avril", "mai", "juin",
    "juillet", "août", "septembre", "octobre", "novembre", "décembre",
  ];
  const [yearStr, monthStr] = report.period.split("-");
  const monthIdx = parseInt(monthStr, 10) - 1;
  const periodLabel = `${monthNames[monthIdx] ?? monthStr} ${yearStr}`;

  const acquiredList =
    report.creatorsAcquiredThisMonth.length > 0
      ? report.creatorsAcquiredThisMonth.map(escapeMd).join(", ")
      : "Aucun ce cycle";

  return (
    `🏛️ *RAPPORT DE TRÉSORERIE UNDERGROUND*\n` +
    `📅 *${periodLabel}*\n\n` +
    (report.periodActivity
      ? `📆 *Ce mois-ci :*\n` +
        `• Étoiles reçues : *${report.periodActivity.starsReceived.toLocaleString()} ⭐*\n` +
        `• Encaisse réglée : *${formatMoney(report.periodActivity.settledCashCadMinor, "CAD")}*\n` +
        `• Dépenses payées : *${formatMoney(report.periodActivity.paidExpensesCadMinor, "CAD")}*\n\n`
      : "") +
    `💰 *Revenus et entrées de fonds (cumulatif) :*\n` +
    `• Étoiles reçues : *${o.totalStarsReceived.toLocaleString()} ⭐*\n` +
    `• En attente de règlement (détention de 21 jours) : *${o.pendingStars.toLocaleString()} ⭐* (~${formatMoney(o.estimatedPendingRewardsCadMinor, "CAD")} env.)\n` +
    `• Potentiellement retirables : *${o.potentiallyWithdrawableStars.toLocaleString()} ⭐* (~${formatMoney(o.estimatedWithdrawableRewardsCadMinor, "CAD")} env.)\n` +
    `• Encaisse réglée confirmée : *${formatMoney(o.settledNetCashCadMinor, "CAD")}*\n` +
    `• Encaisse disponible : *${formatMoney(o.cashOnHandCadMinor, "CAD")}*\n\n` +
    `💸 *Dépenses et engagements :*\n` +
    `• Acquisitions de créateurs : *${formatMoney(o.paidAcquisitionsCadMinor, "CAD")}*\n` +
    `• Exploitation de la plateforme et marketing : *${formatMoney(o.paidOperationsCadMinor, "CAD")}*\n` +
    `• Engagements actifs : *${formatMoney(o.committedAcquisitionsCadMinor, "CAD")}*\n\n` +
    `🎯 *Budget et répartition :*\n` +
    `• Budget d'acquisition disponible : *${formatMoney(o.availableAcquisitionBudgetCadMinor, "CAD")}*\n` +
    `• Répartition à l'exploitation : *${formatMoney(o.allocatedOperationsCadMinor, "CAD")}*\n` +
    `• Réserve de prévoyance protégée : *${formatMoney(o.allocatedReserveCadMinor, "CAD")}*\n\n` +
    `👥 *Communauté et gouvernance :*\n` +
    `• Abonnés payants actifs : *${report.activePaidSubscribersCount}*\n` +
    `• Membres avec accès gratuit : *${report.complimentaryMembersCount}*\n` +
    `• Créateurs acquis : *${acquiredList}*\n` +
    `• Nouvelles candidatures : *${report.newNominationsCount}*\n\n` +
    `_Toutes les décisions d'acquisition sont régies par les votes des abonnés actifs._`
  );
}

/**
 * Format detailed Administrator Audit Report.
 */
export function formatDetailedAdminReport(report: TreasuryMonthlyReport): string {
  const o = report.overview;

  return (
    `📊 *RAPPORT D'AUDIT DÉTAILLÉ DE LA TRÉSORERIE*\n` +
    `*Période :* ${report.period} | *Généré le :* ${formatTorontoDate(report.generatedAt, { dateStyle: "medium", timeStyle: "short" })}\n\n` +
    `*1. Ventilation des Étoiles Telegram :*\n` +
    `• Total des Étoiles reçues : ${o.totalStarsReceived} ⭐\n` +
    `• Étoiles en attente (< 21 jours) : ${o.pendingStars} ⭐ (${formatMoney(o.estimatedPendingRewardsCadMinor, "CAD")} env.)\n` +
    `• Étoiles retirables (≥ 21 jours) : ${o.potentiallyWithdrawableStars} ⭐ (${formatMoney(o.estimatedWithdrawableRewardsCadMinor, "CAD")} env.)\n` +
    `• Étoiles retirées : ${o.withdrawnStars} ⭐ (retraits enregistrés : ${o.recordedWithdrawalStars} ⭐, selon Telegram : ${o.telegramWithdrawnStars} ⭐)\n` +
    `• Étoiles remboursées (exclues) : ${o.refundedStars} ⭐\n\n` +
    `*2. Encaisse réglée en monnaie fiduciaire (CAD) :*\n` +
    `• Total de l'encaisse réglée : ${formatMoney(o.settledNetCashCadMinor, "CAD")}\n` +
    `• Affecté aux acquisitions : ${formatMoney(o.allocatedAcquisitionsCadMinor, "CAD")}\n` +
    `• Affecté à l'exploitation : ${formatMoney(o.allocatedOperationsCadMinor, "CAD")}\n` +
    `• Affecté à la réserve : ${formatMoney(o.allocatedReserveCadMinor, "CAD")}\n\n` +
    `*3. Débours et obligations :*\n` +
    `• Acquisitions payées : ${formatMoney(o.paidAcquisitionsCadMinor, "CAD")}\n` +
    `• Exploitation payée : ${formatMoney(o.paidOperationsCadMinor, "CAD")}\n` +
    `• Autres dépenses payées : ${formatMoney(o.paidOtherCadMinor, "CAD")}\n` +
    `• Total payé : ${formatMoney(o.totalPaidExpensesCadMinor, "CAD")}\n` +
    `• Engagements actifs : ${formatMoney(o.committedAcquisitionsCadMinor, "CAD")}\n` +
    `• Débours d'administrateurs non remboursés : ${formatMoney(o.adminReimbursementsOwedCadMinor, "CAD")}\n\n` +
    `*4. Pouvoir d'achat net pour les acquisitions :*\n` +
    `• Budget d'acquisition disponible : *${formatMoney(o.availableAcquisitionBudgetCadMinor, "CAD")}*`
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
