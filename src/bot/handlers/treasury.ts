/**
 * Underground Manager — Treasury, Expenses & Financial Automation Handlers
 * Phase UG-03: Treasury, Expenses & Final Automation
 */

import { Composer, InlineKeyboard } from "grammy";
import { adminRouteGuard } from "../middleware/auth.ts";
import {
  treasuryAllocationsKeyboard,
  treasuryExpenseCategoryKeyboard,
  treasuryExpensePayerKeyboard,
  treasuryMenuKeyboard,
  treasuryReportsKeyboard,
} from "../keyboards.ts";
import { formatMoney } from "../../treasury/conversion.ts";
import {
  approveCandidateAcquisition,
  cancelExpense,
  confirmCandidateAcquisitionPaid,
  evaluateCandidateAffordability,
  getTreasuryOverview,
  recordExpenseWithJournal,
  recordWithdrawalWithSettlement,
  refundExpense,
  reimburseAdminExpense,
} from "../../treasury/service.ts";
import { parseMoneyToMinor, parseTonToNano } from "../../util/money.ts";
import { escapeMd } from "../../util/markdown.ts";
import { getKv } from "../../db/kv.ts";
import { isSupportedExpenseCurrency, normalizeCurrency } from "../../treasury/conversion.ts";
import { EXPENSE_CATEGORY_LABELS } from "../../types.ts";
import {
  reconcileStarHoldingStatuses,
  reconcileStarTransactionsFromApi,
} from "../../treasury/stars_tracking.ts";
import {
  formatDetailedAdminReport,
  formatPrivateMemberReport,
  generateMonthlyTreasuryReport,
  publishMonthlyReportToChannel,
} from "../../treasury/reports.ts";
import { listExpenses, updateCandidatePricing } from "../../db/expenses.ts";
import {
  getTreasuryAllocations,
  getValuationConfig,
  saveTreasuryAllocations,
  getTreasuryReport,
} from "../../db/treasury.ts";
import {
  CurrencyCode,
  ExpenseCategory,
  ExpensePayer,
  ExpenseStatus,
} from "../../types.ts";
import { getWantedCandidate } from "../../db/wanted.ts";

export const treasuryComposer = new Composer();

// All treasury routes require administrator authorization (scoped; see adminRouteGuard)
treasuryComposer.use(
  adminRouteGuard([
    "treasury",
    "record_expense",
    "record_withdrawal",
    "price",
    "refund_expense",
    "cancel_expense",
    "approve_acquisition",
    "acquisition_paid",
  ])
);

// Pending expense confirmations live in KV (not process memory): Deno Deploy may route
// the confirm tap to a different isolate, and the draft must be claimable exactly once.
interface ExpenseDraft {
  description: string;
  originalAmountMinor: number;
  originalCurrency: CurrencyCode;
  category: ExpenseCategory;
  payer: ExpensePayer;
  candidateId?: string;
  adminId: number;
}
const DRAFT_TTL_MS = 60 * 60 * 1000;

async function saveExpenseDraft(draft: ExpenseDraft): Promise<string> {
  const kv = await getKv();
  const id = crypto.randomUUID();
  await kv.set(["expense_drafts", id], draft, { expireIn: DRAFT_TTL_MS });
  return id;
}

/** Atomically takes the draft: a double-tap on "Confirm" yields exactly one expense. */
async function claimExpenseDraft(id: string, adminId: number): Promise<ExpenseDraft | null> {
  const kv = await getKv();
  const res = await kv.get<ExpenseDraft>(["expense_drafts", id]);
  if (!res.value || res.value.adminId !== adminId) return null;
  const del = await kv.atomic().check(res).delete(["expense_drafts", id]).commit();
  return del.ok ? res.value : null;
}

// ==============================================================================
// 1. Treasury Overview
// ==============================================================================

async function renderTreasuryOverviewText(): Promise<string> {
  const o = await getTreasuryOverview();

  return (
    `💰 *UNDERGROUND TREASURY OVERVIEW*\n\n` +
    `*1. Telegram Stars Holdings:*\n` +
    `• Total Stars Received: *${o.totalStarsReceived.toLocaleString()} ⭐*\n` +
    `• Pending Holding (< 21 days): *${o.pendingStars.toLocaleString()} ⭐* (~${formatMoney(o.estimatedPendingRewardsCadMinor, "CAD")} est.)\n` +
    `• Potentially Withdrawable: *${o.potentiallyWithdrawableStars.toLocaleString()} ⭐* (~${formatMoney(o.estimatedWithdrawableRewardsCadMinor, "CAD")} est.)\n` +
    `• Withdrawn: *${o.withdrawnStars.toLocaleString()} ⭐*\n\n` +
    `*2. Settled Fiat Cash (CAD):*\n` +
    `• Net Cash in Bank/Wallet: *${formatMoney(o.settledNetCashCadMinor, "CAD")}*\n` +
    `• Allocated to Acquisitions: ${formatMoney(o.allocatedAcquisitionsCadMinor, "CAD")}\n` +
    `• Allocated to Operations: ${formatMoney(o.allocatedOperationsCadMinor, "CAD")}\n` +
    `• Contingency Reserve: ${formatMoney(o.allocatedReserveCadMinor, "CAD")}\n\n` +
    `*3. Outlays & Available Budget:*\n` +
    `• Paid Creator Acquisitions: ${formatMoney(o.paidAcquisitionsCadMinor, "CAD")}\n` +
    `• Outstanding Commitments: ${formatMoney(o.committedAcquisitionsCadMinor, "CAD")}\n` +
    `• Total Paid Expenses: ${formatMoney(o.totalPaidExpensesCadMinor, "CAD")}\n` +
    `• Unreimbursed Admin Outlays: ${formatMoney(o.adminReimbursementsOwedCadMinor, "CAD")}\n\n` +
    `🎯 *Available Acquisition Budget:* *${formatMoney(o.availableAcquisitionBudgetCadMinor, "CAD")}*`
  );
}

treasuryComposer.command("treasury", async (ctx) => {
  const text = await renderTreasuryOverviewText();
  await ctx.reply(text, {
    parse_mode: "Markdown",
    reply_markup: treasuryMenuKeyboard(),
  });
});

treasuryComposer.callbackQuery("admin:treasury_menu", async (ctx) => {
  await ctx.answerCallbackQuery();
  const text = await renderTreasuryOverviewText();
  await ctx.editMessageText(text, {
    parse_mode: "Markdown",
    reply_markup: treasuryMenuKeyboard(),
  });
});

// ==============================================================================
// 2. View Expenses & Reimbursements
// ==============================================================================

treasuryComposer.callbackQuery("admin:treasury_expenses", async (ctx) => {
  const expenses = await listExpenses({ limit: 10 });
  const kb = new InlineKeyboard();

  let text = `📋 *RECENT EXPENSES & OUTLAYS*\n\n`;
  if (expenses.length === 0) {
    text += `_No expenses recorded yet._\n`;
  } else {
    for (const exp of expenses) {
      const payerBadge = exp.payer === "admin_personal" ? "[Personal]" : "[Club]";
      const statusBadge = `[${exp.status.toUpperCase()}]`;
      text += `• *${exp.description}*\n  ${formatMoney(exp.cadAmountMinor, "CAD")} ${statusBadge} ${payerBadge}\n`;

      if (exp.payer === "admin_personal" && exp.reimbursementStatus === "pending") {
        text += `  ⚠️ _Pending Reimbursement_\n`;
        kb.text(`Reimburse: ${exp.description.slice(0, 15)}`, `admin:reimburse:${exp.id}`).row();
      }
    }
  }

  kb.text("➕ Add Expense", "admin:treasury_add_exp")
    .text("⬅️ Treasury Menu", "admin:treasury_menu");

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(text, {
    parse_mode: "Markdown",
    reply_markup: kb,
  });
});

treasuryComposer.callbackQuery(/^admin:reimburse:([a-f0-9-]+)$/, async (ctx) => {
  const expenseId = ctx.match[1];
  try {
    const updated = await reimburseAdminExpense(expenseId, ctx.from!.id);
    await ctx.answerCallbackQuery({
      text: `Reimbursed ${formatMoney(updated.cadAmountMinor, "CAD")}!`,
      show_alert: true,
    });
    // Refresh expenses view
    const expenses = await listExpenses({ limit: 10 });
    const kb = new InlineKeyboard().text("⬅️ Treasury Menu", "admin:treasury_menu");
    await ctx.editMessageText(
      `✅ *Expense Reimbursed:*\n${updated.description} (${formatMoney(updated.cadAmountMinor, "CAD")})\n\nSettled cash was debited and admin liability cleared.`,
      { parse_mode: "Markdown", reply_markup: kb }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.answerCallbackQuery({ text: `Failed: ${msg}`, show_alert: true });
  }
});

// ==============================================================================
// 3. Add Expense Wizard & Confirmation
// ==============================================================================

treasuryComposer.callbackQuery("admin:treasury_add_exp", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `➕ *RECORD NEW EXPENSE*\n\nSelect the expense category:`,
    {
      parse_mode: "Markdown",
      reply_markup: treasuryExpenseCategoryKeyboard(),
    }
  );
});

treasuryComposer.callbackQuery(/^admin:exp_cat:([a-z_]+)$/, async (ctx) => {
  const category = ctx.match[1];
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `➕ *RECORD EXPENSE — ${category.toUpperCase()}*\n\nWho paid for this expense?`,
    {
      parse_mode: "Markdown",
      reply_markup: treasuryExpensePayerKeyboard(category),
    }
  );
});

treasuryComposer.callbackQuery(/^admin:exp_pyr:([a-z_]+):([a-z_]+)$/, async (ctx) => {
  const category = ctx.match[1];
  const payer = ctx.match[2];

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `➕ *RECORD EXPENSE: ${category} (${payer})*\n\n` +
    `Please send the command with amount, currency, and description:\n\n` +
    `*Command format:*\n` +
    `\`/record_expense <amount> <currency> <category> <payer> <description>\`\n\n` +
    `*Example:*\n` +
    `\`/record_expense 16 CAD ${category} ${payer} Aria Monthly Subscription\``,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard().text("⬅️ Treasury Menu", "admin:treasury_menu"),
    }
  );
});

treasuryComposer.command("record_expense", async (ctx) => {
  const text = ctx.message?.text ?? "";
  const parts = text.trim().split(/\s+/).slice(1);

  if (parts.length < 5) {
    await ctx.reply(
      `⚠️ *Usage:* \`/record_expense <amount> <currency> <category> <payer> <description>\`\n\n` +
      `Example: \`/record_expense 16.00 CAD creator_subscription club_funds Aria OnlyFans\`\n` +
      `Categories: ${Object.keys(EXPENSE_CATEGORY_LABELS).join(", ")}\n` +
      `Payers: club_funds, admin_personal`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  const amountMinor = parseMoneyToMinor(parts[0]);
  const currency = normalizeCurrency(parts[1]) as CurrencyCode;
  const category = parts[2] as ExpenseCategory;
  const payer = parts[3] as ExpensePayer;
  const description = parts.slice(4).join(" ");

  if (amountMinor === null || amountMinor <= 0) {
    await ctx.reply("⚠️ Amount must be a positive number with at most 2 decimals (e.g. 16.50).");
    return;
  }
  if (!isSupportedExpenseCurrency(currency)) {
    await ctx.reply("⚠️ Unsupported currency. Supported: CAD, USD, EUR, GBP.");
    return;
  }
  if (!(category in EXPENSE_CATEGORY_LABELS)) {
    await ctx.reply(`⚠️ Unknown category. Use one of: ${Object.keys(EXPENSE_CATEGORY_LABELS).join(", ")}`);
    return;
  }
  if (payer !== "club_funds" && payer !== "admin_personal") {
    await ctx.reply("⚠️ Payer must be `club_funds` or `admin_personal`.", { parse_mode: "Markdown" });
    return;
  }

  const draftId = await saveExpenseDraft({
    description,
    originalAmountMinor: amountMinor,
    originalCurrency: currency,
    category,
    payer,
    adminId: ctx.from!.id,
  });

  const { convertToBaseCurrency } = await import("../../treasury/conversion.ts");
  let conv;
  try {
    conv = await convertToBaseCurrency(amountMinor, currency);
  } catch (err) {
    await ctx.reply(`⚠️ ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const { cadAmountMinor, usdAmountMinor, indicativeStars } = conv;

  const kb = new InlineKeyboard()
    .text("✅ Confirm Expense", `admin:exp_cfm:${draftId}`)
    .row()
    .text("❌ Cancel", "admin:treasury_menu");

  await ctx.reply(
    `📝 *CONFIRM EXPENSE ENTRY*\n\n` +
    `• *Description:* ${escapeMd(description)}\n` +
    `• *Amount:* ${formatMoney(amountMinor, currency)}\n` +
    `• *Base Reporting (CAD):* ${formatMoney(cadAmountMinor, "CAD")}\n` +
    `• *FX:* ${conv.rateToCad} (${conv.rateSource ?? "n/a"} ${conv.rateDate ?? ""})\n` +
    `• *USD Equivalent:* ${formatMoney(usdAmountMinor, "USD")}\n` +
    `• *Indicative Stars:* ~${indicativeStars.toLocaleString()} ⭐ (Informational)\n` +
    `• *Category:* ${category}\n` +
    `• *Payer:* ${payer === "club_funds" ? "🏦 Club Funds" : "👤 Admin Personal"}\n\n` +
    `Confirm to record this expense into the financial ledger:`,
    {
      parse_mode: "Markdown",
      reply_markup: kb,
    }
  );
});

treasuryComposer.callbackQuery(/^admin:exp_cfm:([a-f0-9-]+)$/, async (ctx) => {
  const draftId = ctx.match[1];
  const draft = await claimExpenseDraft(draftId, ctx.from!.id);

  if (!draft) {
    await ctx.answerCallbackQuery({ text: "Draft expired or already processed.", show_alert: true });
    return;
  }

  try {
    const expense = await recordExpenseWithJournal({
      description: draft.description,
      originalAmountMinor: draft.originalAmountMinor,
      originalCurrency: draft.originalCurrency,
      category: draft.category,
      status: "paid",
      payer: draft.payer,
      paidByAdminId: draft.payer === "admin_personal" ? draft.adminId : undefined,
      actorId: ctx.from!.id,
    });

    await ctx.answerCallbackQuery({ text: "Expense recorded successfully!" });
    await ctx.editMessageText(
      `✅ *EXPENSE RECORDED SUCCESSFULLY!*\n\n` +
      `• *ID:* \`${expense.id}\`\n` +
      `• *Description:* ${escapeMd(expense.description)}\n` +
      `• *Amount:* ${formatMoney(expense.cadAmountMinor, "CAD")}\n` +
      `• *Payer:* ${expense.payer}\n` +
      `• *Status:* ${expense.status.toUpperCase()}`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("📋 View Expenses", "admin:treasury_expenses"),
      }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.answerCallbackQuery({ text: `Failed: ${msg}`, show_alert: true });
  }
});

// ==============================================================================
// 4. Record Withdrawal & Settlement
// ==============================================================================

treasuryComposer.callbackQuery("admin:treasury_withdraw", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `📤 *RECORD WITHDRAWAL & SETTLEMENT*\n\n` +
    `To record a Stars withdrawal and its settled fiat proceeds, send:\n\n` +
    `*Command format:*\n` +
    `\`/record_withdrawal <stars> <tonReceived> [netCadSettled]\`\n\n` +
    `*Example:*\n` +
    `\`/record_withdrawal 5000 12.5 85.00\``,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard().text("⬅️ Treasury Menu", "admin:treasury_menu"),
    }
  );
});

treasuryComposer.command("record_withdrawal", async (ctx) => {
  const parts = (ctx.message?.text ?? "").trim().split(/\s+/).slice(1);
  if (parts.length < 2) {
    await ctx.reply(
      `⚠️ *Usage:* \`/record_withdrawal <stars> <tonReceived> [netCadSettled] [fragmentRef]\`\n\n` +
      `Example: \`/record_withdrawal 5000 12.5 85.00 FRAG123\`\n` +
      `Omit the CAD amount until the TON has actually been converted to cash.`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  const starsQuantity = /^\d+$/.test(parts[0]) ? Number(parts[0]) : NaN;
  const tonNano = parseTonToNano(parts[1]);
  const netMinor = parts[2] ? parseMoneyToMinor(parts[2]) : undefined;
  const fragmentReference = parts[3];

  if (!Number.isInteger(starsQuantity) || starsQuantity <= 0 || tonNano === null || tonNano <= 0) {
    await ctx.reply("⚠️ Stars must be a whole number and TON a positive number (max 9 decimals).");
    return;
  }
  if (parts[2] && (netMinor === null || netMinor === undefined || netMinor <= 0)) {
    await ctx.reply("⚠️ Settled CAD must be a positive amount with at most 2 decimals.");
    return;
  }

  const settlement = netMinor
    ? {
        settlementDate: new Date().toISOString(),
        amountExchangedTonNano: tonNano,
        currencyReceived: "CAD",
        netFundsReceivedMinor: netMinor,
        // CAD per TON, informational only (cash is the entered net amount)
        effectiveRate: netMinor / 100 / (tonNano / 1_000_000_000),
        feeMinor: 0,
      }
    : undefined;

  try {
    const record = await recordWithdrawalWithSettlement({
      starsQuantity,
      tonReceivedNano: tonNano,
      fragmentReference,
      settlement,
      adminId: ctx.from!.id,
    });

    let msg = `✅ *WITHDRAWAL RECORDED!*\n\n• *Stars Withdrawn:* ${record.starsQuantity} ⭐\n• *TON Received:* ${tonNano / 1_000_000_000} TON\n• *Status:* ${record.status.toUpperCase()}\n`;
    if (record.settlement) {
      msg += `• *Net Settled Cash:* ${formatMoney(record.settlement.netFundsReceivedMinor, "CAD")}\n\nAllocated funds have been credited to acquisitions, operations, and reserve!`;
    } else {
      msg += `\n_No cash is counted until the proceeds are settled._`;
    }

    await ctx.reply(msg, {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard().text("💰 Treasury Overview", "admin:treasury_menu"),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.reply(`⚠️ Failed to record withdrawal: ${msg}`);
  }
});

// ==============================================================================
// 5. Reconcile Stars Holding Period
// ==============================================================================

treasuryComposer.callbackQuery("admin:treasury_reconcile", async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Reconciling Stars transactions..." });

  const holdingResult = await reconcileStarHoldingStatuses();
  const apiResult = await reconcileStarTransactionsFromApi(ctx.api);

  await ctx.reply(
    `🔄 *STARS RECONCILIATION COMPLETE*\n\n` +
    `• *Eligible 21-Day Transitions:* ${holdingResult.transitionedCount} transactions advanced to withdrawable\n` +
    `• *Currently Pending (<21 days):* ${holdingResult.totalPendingCount} transactions\n` +
    `• *Withdrawable Estimate (>=21 days):* ${holdingResult.totalWithdrawableCount} transactions\n` +
    `• *New API Transactions Recorded:* ${apiResult.newTransactionsRecorded}\n` +
    `• *Refunds Applied:* ${apiResult.refundsApplied}\n` +
    `• *Withdrawals Observed:* ${apiResult.withdrawalsObserved}\n` +
    `• *Duplicates Skipped:* ${apiResult.duplicatesSkipped}` +
    (apiResult.errors.length ? `\n⚠️ ${apiResult.errors.join("; ")}` : ""),
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard().text("💰 Treasury Overview", "admin:treasury_menu"),
    }
  );
});

// ==============================================================================
// 6. Monthly Reports
// ==============================================================================

treasuryComposer.callbackQuery("admin:treasury_reports", async (ctx) => {
  await ctx.answerCallbackQuery();
  const report = await generateMonthlyTreasuryReport();
  const preview = formatPrivateMemberReport(report);

  await ctx.editMessageText(
    `📊 *MONTHLY TREASURY REPORT PREVIEW*\n\n${preview}`,
    {
      parse_mode: "Markdown",
      reply_markup: treasuryReportsKeyboard(report.period),
    }
  );
});

treasuryComposer.callbackQuery(/^admin:report_pub:([0-9-]+)$/, async (ctx) => {
  const period = ctx.match[1];
  const report = await getTreasuryReport(period);
  if (!report) {
    await ctx.answerCallbackQuery({ text: "Report not found.", show_alert: true });
    return;
  }

  const success = await publishMonthlyReportToChannel(ctx.api, report);
  if (success) {
    await ctx.answerCallbackQuery({ text: "Report published to channel!" });
    await ctx.reply(`📢 *Monthly Treasury Report for ${period} successfully published to channel!*`);
  } else {
    await ctx.answerCallbackQuery({ text: "Failed to publish report to channel.", show_alert: true });
  }
});

treasuryComposer.callbackQuery(/^admin:report_audit:([0-9-]+)$/, async (ctx) => {
  const period = ctx.match[1];
  const report = await getTreasuryReport(period);
  if (!report) {
    await ctx.answerCallbackQuery({ text: "Report not found.", show_alert: true });
    return;
  }

  await ctx.answerCallbackQuery();
  const detailed = formatDetailedAdminReport(report);
  await ctx.reply(detailed, {
    parse_mode: "Markdown",
    reply_markup: new InlineKeyboard().text("⬅️ Treasury Menu", "admin:treasury_menu"),
  });
});

// ==============================================================================
// 7. Allocations & Valuation Settings
// ==============================================================================

treasuryComposer.callbackQuery("admin:treasury_allocations", async (ctx) => {
  const [alloc, val] = await Promise.all([
    getTreasuryAllocations(),
    getValuationConfig(),
  ]);

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `⚙️ *TREASURY ALLOCATIONS & VALUATION*\n\n` +
    `*Current Fund Allocation Percentages:*\n` +
    `• Creator Acquisitions: *${alloc.acquisitionPct}%*\n` +
    `• Platform Operations: *${alloc.operationsPct}%*\n` +
    `• Protected Reserve: *${alloc.reservePct}%*\n\n` +
    `*Stars Reward Reporting Valuation:*\n` +
    `• Current Reference: *US$${val.starsRewardValuationUsd} / Star*\n\n` +
    `Select a preset to adjust future allocation distributions:`,
    {
      parse_mode: "Markdown",
      reply_markup: treasuryAllocationsKeyboard(),
    }
  );
});

treasuryComposer.callbackQuery(/^admin:alloc_preset:([0-9_]+)$/, async (ctx) => {
  const preset = ctx.match[1];
  const [acq, ops, res] = preset.split("_").map((n) => parseInt(n, 10));

  await saveTreasuryAllocations({
    acquisitionPct: acq,
    operationsPct: ops,
    reservePct: res,
    effectiveDate: new Date().toISOString(),
    updatedBy: ctx.from!.id,
  });

  await ctx.answerCallbackQuery({ text: `Allocations updated to ${acq}/${ops}/${res}%!` });
  await ctx.editMessageText(
    `✅ *TREASURY ALLOCATIONS UPDATED!*\n\n` +
    `• Acquisitions: *${acq}%*\n` +
    `• Operations: *${ops}%*\n` +
    `• Contingency Reserve: *${res}%*\n\n` +
    `This allocation rule applies prospectively to all new settlements.`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard().text("💰 Treasury Overview", "admin:treasury_menu"),
    }
  );
});

// ==============================================================================
// 8. Candidate Pricing Command
// ==============================================================================

treasuryComposer.command("price", async (ctx) => {
  const parts = (ctx.message?.text ?? "").trim().split(/\s+/).slice(1);
  if (parts.length < 2) {
    await ctx.reply(
      `⚠️ *Usage:* \`/price <candidateId> <amount> [currency]\`\n\n` +
      `Example: \`/price 1234-abcd 20.00 CAD\``,
      { parse_mode: "Markdown" }
    );
    return;
  }

  const candidateId = parts[0];
  const amountMinor = parseMoneyToMinor(parts[1]);
  const currency = normalizeCurrency(parts[2] ?? "CAD");

  if (amountMinor === null || amountMinor <= 0) {
    await ctx.reply("⚠️ Amount must be a positive number with at most 2 decimals.");
    return;
  }
  if (!isSupportedExpenseCurrency(currency)) {
    await ctx.reply("⚠️ Unsupported currency. Supported: CAD, USD, EUR, GBP.");
    return;
  }

  const candidate = await getWantedCandidate(candidateId);
  if (!candidate) {
    await ctx.reply(`⚠️ Candidate with ID \`${candidateId}\` not found.`);
    return;
  }

  const { convertToBaseCurrency } = await import("../../treasury/conversion.ts");
  const { cadAmountMinor } = await convertToBaseCurrency(amountMinor, currency);

  await updateCandidatePricing(candidateId, {
    expectedPriceMinor: amountMinor,
    priceCurrency: currency,
    expectedCadMinor: cadAmountMinor,
    // Rights must be confirmed explicitly by the administrator, never implied by pricing.
    rightsVerified: candidate.rightsVerified ?? false,
  });

  const afford = await evaluateCandidateAffordability(candidateId);

  await ctx.reply(
    `🏷️ *CANDIDATE PRICING UPDATED*\n\n` +
    `• *Creator:* ${escapeMd(candidate.name)}\n` +
    `• *Expected Price:* ${formatMoney(amountMinor, currency)} (${formatMoney(cadAmountMinor, "CAD")})\n` +
    `• *Affordability:* ${afford.affordable ? "✅ Affordable within Budget" : `❌ Shortfall: ${formatMoney(afford.shortfallMinor, "CAD")}`}\n` +
    `• *Available Acquisition Budget:* ${formatMoney(afford.availableBudgetCadMinor, "CAD")}`,
    { parse_mode: "Markdown" }
  );
});

// ==============================================================================
// 9. Expense corrections & acquisition workflow
// ==============================================================================

treasuryComposer.command("refund_expense", async (ctx) => {
  const parts = (ctx.message?.text ?? "").trim().split(/\s+/).slice(1);
  if (parts.length < 1) {
    await ctx.reply("Usage: `/refund_expense <expenseId> [amount]` (omit amount for a full refund)", {
      parse_mode: "Markdown",
    });
    return;
  }
  const amountMinor = parts[1] ? parseMoneyToMinor(parts[1]) : undefined;
  if (parts[1] && (amountMinor === null || amountMinor === undefined)) {
    await ctx.reply("⚠️ Invalid refund amount.");
    return;
  }
  try {
    const adj = await refundExpense({
      expenseId: parts[0],
      amountMinor: amountMinor ?? undefined,
      actorId: ctx.from!.id,
    });
    await ctx.reply(`✅ Refund of ${formatMoney(-adj.cadAmountMinor, "CAD")} recorded against expense \`${parts[0]}\`.`, {
      parse_mode: "Markdown",
    });
  } catch (err) {
    await ctx.reply(`⚠️ ${err instanceof Error ? err.message : String(err)}`);
  }
});

treasuryComposer.command("cancel_expense", async (ctx) => {
  const id = (ctx.message?.text ?? "").trim().split(/\s+/)[1];
  if (!id) {
    await ctx.reply("Usage: `/cancel_expense <expenseId>`", { parse_mode: "Markdown" });
    return;
  }
  try {
    await cancelExpense(id, ctx.from!.id);
    await ctx.reply("✅ Expense cancelled and any reserved budget released.");
  } catch (err) {
    await ctx.reply(`⚠️ ${err instanceof Error ? err.message : String(err)}`);
  }
});

// Approve the winning candidate: reserves budget (no purchase happens automatically).
treasuryComposer.callbackQuery(/^admin:acq_approve:([a-f0-9-]+)$/, async (ctx) => {
  try {
    const { candidate, commitmentExpense } = await approveCandidateAcquisition(
      ctx.match[1],
      ctx.from!.id
    );
    await ctx.answerCallbackQuery({ text: "Budget reserved." });
    await ctx.reply(
      `✅ *Acquisition approved:* ${escapeMd(candidate.name)}\n` +
      `Reserved ${formatMoney(commitmentExpense.cadAmountMinor, "CAD")} of the acquisition budget.\n\n` +
      `_Nothing has been purchased. Buy it yourself, then confirm payment below._`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard()
          .text("💳 Paid from club funds", `admin:acq_paid:${candidate.id}:club_funds`)
          .row()
          .text("👤 I paid personally", `admin:acq_paid:${candidate.id}:admin_personal`)
          .row()
          .text("↩️ Cancel & release budget", `admin:acq_cancel:${candidate.id}`),
      }
    );
  } catch (err) {
    await ctx.answerCallbackQuery({
      text: `Failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 190),
      show_alert: true,
    });
  }
});

treasuryComposer.callbackQuery(/^admin:acq_paid:([a-f0-9-]+):(club_funds|admin_personal)$/, async (ctx) => {
  try {
    const { candidate, expense } = await confirmCandidateAcquisitionPaid({
      candidateId: ctx.match[1],
      payer: ctx.match[2] as ExpensePayer,
      adminId: ctx.from!.id,
    });
    await ctx.answerCallbackQuery({ text: "Payment confirmed." });
    await ctx.reply(
      `🎉 *${escapeMd(candidate.name)}* marked acquired. Paid ${formatMoney(expense.cadAmountMinor, "CAD")} ` +
      `(${expense.payer === "club_funds" ? "club funds" : "admin personal — reimbursement pending"}).`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    await ctx.answerCallbackQuery({
      text: `Failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 190),
      show_alert: true,
    });
  }
});

treasuryComposer.callbackQuery(/^admin:acq_cancel:([a-f0-9-]+)$/, async (ctx) => {
  try {
    const { cancelCandidateAcquisition } = await import("../../treasury/service.ts");
    const candidate = await cancelCandidateAcquisition(ctx.match[1], ctx.from!.id);
    await ctx.answerCallbackQuery({ text: "Commitment released." });
    await ctx.reply(`↩️ Commitment for *${escapeMd(candidate.name)}* released.`, { parse_mode: "Markdown" });
  } catch (err) {
    await ctx.answerCallbackQuery({
      text: `Failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 190),
      show_alert: true,
    });
  }
});
