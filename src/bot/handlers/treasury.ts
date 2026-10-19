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
    `💰 *APERÇU DE LA TRÉSORERIE UNDERGROUND*\n\n` +
    `*1. Avoirs en Étoiles Telegram :*\n` +
    `• Total des Étoiles reçues : *${o.totalStarsReceived.toLocaleString()} ⭐*\n` +
    `• En période de détention (< 21 jours) : *${o.pendingStars.toLocaleString()} ⭐* (~${formatMoney(o.estimatedPendingRewardsCadMinor, "CAD")} env.)\n` +
    `• Potentiellement retirables : *${o.potentiallyWithdrawableStars.toLocaleString()} ⭐* (~${formatMoney(o.estimatedWithdrawableRewardsCadMinor, "CAD")} env.)\n` +
    `• Retirées : *${o.withdrawnStars.toLocaleString()} ⭐*\n\n` +
    `*2. Encaisse réglée en monnaie fiduciaire (CAD) :*\n` +
    `• Encaisse nette en banque/portefeuille : *${formatMoney(o.settledNetCashCadMinor, "CAD")}*\n` +
    `• Affecté aux acquisitions : ${formatMoney(o.allocatedAcquisitionsCadMinor, "CAD")}\n` +
    `• Affecté à l'exploitation : ${formatMoney(o.allocatedOperationsCadMinor, "CAD")}\n` +
    `• Réserve de prévoyance : ${formatMoney(o.allocatedReserveCadMinor, "CAD")}\n\n` +
    `*3. Débours et budget disponible :*\n` +
    `• Acquisitions de créateurs payées : ${formatMoney(o.paidAcquisitionsCadMinor, "CAD")}\n` +
    `• Engagements en cours : ${formatMoney(o.committedAcquisitionsCadMinor, "CAD")}\n` +
    `• Total des dépenses payées : ${formatMoney(o.totalPaidExpensesCadMinor, "CAD")}\n` +
    `• Débours d'administrateurs non remboursés : ${formatMoney(o.adminReimbursementsOwedCadMinor, "CAD")}\n\n` +
    `🎯 *Budget d'acquisition disponible :* *${formatMoney(o.availableAcquisitionBudgetCadMinor, "CAD")}*`
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

  let text = `📋 *DÉPENSES ET DÉBOURS RÉCENTS*\n\n`;
  if (expenses.length === 0) {
    text += `_Aucune dépense enregistrée pour le moment._\n`;
  } else {
    for (const exp of expenses) {
      const payerBadge = exp.payer === "admin_personal" ? "[Personnel]" : "[Club]";
      const statusBadge = `[${exp.status.toUpperCase()}]`;
      text += `• *${exp.description}*\n  ${formatMoney(exp.cadAmountMinor, "CAD")} ${statusBadge} ${payerBadge}\n`;

      if (exp.payer === "admin_personal" && exp.reimbursementStatus === "pending") {
        text += `  ⚠️ _Remboursement en attente_\n`;
        kb.text(`Rembourser : ${exp.description.slice(0, 15)}`, `admin:reimburse:${exp.id}`).row();
      }
    }
  }

  kb.text("➕ Ajouter une dépense", "admin:treasury_add_exp")
    .text("⬅️ Menu de la trésorerie", "admin:treasury_menu");

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
      text: `${formatMoney(updated.cadAmountMinor, "CAD")} remboursé !`,
      show_alert: true,
    });
    // Refresh expenses view
    const expenses = await listExpenses({ limit: 10 });
    const kb = new InlineKeyboard().text("⬅️ Menu de la trésorerie", "admin:treasury_menu");
    await ctx.editMessageText(
      `✅ *Dépense remboursée :*\n${updated.description} (${formatMoney(updated.cadAmountMinor, "CAD")})\n\nL'encaisse réglée a été débitée et la dette envers l'administrateur a été effacée.`,
      { parse_mode: "Markdown", reply_markup: kb }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.answerCallbackQuery({ text: `Échec : ${msg}`, show_alert: true });
  }
});

// ==============================================================================
// 3. Add Expense Wizard & Confirmation
// ==============================================================================

treasuryComposer.callbackQuery("admin:treasury_add_exp", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `➕ *ENREGISTRER UNE NOUVELLE DÉPENSE*\n\nChoisissez la catégorie de dépense :`,
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
    `➕ *ENREGISTRER UNE DÉPENSE — ${category.toUpperCase()}*\n\nQui a payé cette dépense ?`,
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
    `➕ *ENREGISTRER UNE DÉPENSE : ${category} (${payer})*\n\n` +
    `Veuillez envoyer la commande avec le montant, la devise et la description :\n\n` +
    `*Format de la commande :*\n` +
    `\`/record_expense <amount> <currency> <category> <payer> <description>\`\n\n` +
    `*Exemple :*\n` +
    `\`/record_expense 16 CAD ${category} ${payer} Aria Monthly Subscription\``,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard().text("⬅️ Menu de la trésorerie", "admin:treasury_menu"),
    }
  );
});

treasuryComposer.command("record_expense", async (ctx) => {
  const text = ctx.message?.text ?? "";
  const parts = text.trim().split(/\s+/).slice(1);

  if (parts.length < 5) {
    await ctx.reply(
      `⚠️ *Utilisation :* \`/record_expense <amount> <currency> <category> <payer> <description>\`\n\n` +
      `Exemple : \`/record_expense 16.00 CAD creator_subscription club_funds Aria OnlyFans\`\n` +
      `Catégories : ${Object.keys(EXPENSE_CATEGORY_LABELS).join(", ")}\n` +
      `Payeurs : club_funds, admin_personal`,
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
    await ctx.reply("⚠️ Le montant doit être un nombre positif avec au plus 2 décimales (p. ex. 16,50).");
    return;
  }
  if (!isSupportedExpenseCurrency(currency)) {
    await ctx.reply("⚠️ Devise non prise en charge. Devises acceptées : CAD, USD, EUR, GBP.");
    return;
  }
  if (!(category in EXPENSE_CATEGORY_LABELS)) {
    await ctx.reply(`⚠️ Catégorie inconnue. Utilisez l'une des suivantes : ${Object.keys(EXPENSE_CATEGORY_LABELS).join(", ")}`);
    return;
  }
  if (payer !== "club_funds" && payer !== "admin_personal") {
    await ctx.reply("⚠️ Le payeur doit être `club_funds` ou `admin_personal`.", { parse_mode: "Markdown" });
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
    .text("✅ Confirmer la dépense", `admin:exp_cfm:${draftId}`)
    .row()
    .text("❌ Annuler", "admin:treasury_menu");

  await ctx.reply(
    `📝 *CONFIRMER L'ENTRÉE DE DÉPENSE*\n\n` +
    `• *Description :* ${escapeMd(description)}\n` +
    `• *Montant :* ${formatMoney(amountMinor, currency)}\n` +
    `• *Devise de présentation (CAD) :* ${formatMoney(cadAmountMinor, "CAD")}\n` +
    `• *Taux de change :* ${conv.rateToCad} (${conv.rateSource ?? "n/a"} ${conv.rateDate ?? ""})\n` +
    `• *Équivalent en USD :* ${formatMoney(usdAmountMinor, "USD")}\n` +
    `• *Étoiles indicatives :* ~${indicativeStars.toLocaleString()} ⭐ (à titre informatif)\n` +
    `• *Catégorie :* ${category}\n` +
    `• *Payeur :* ${payer === "club_funds" ? "🏦 Fonds du club" : "👤 Administrateur (personnel)"}\n\n` +
    `Confirmez pour inscrire cette dépense au registre financier :`,
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
    await ctx.answerCallbackQuery({ text: "Le brouillon est expiré ou a déjà été traité.", show_alert: true });
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

    await ctx.answerCallbackQuery({ text: "Dépense enregistrée avec succès !" });
    await ctx.editMessageText(
      `✅ *DÉPENSE ENREGISTRÉE AVEC SUCCÈS !*\n\n` +
      `• *ID :* \`${expense.id}\`\n` +
      `• *Description :* ${escapeMd(expense.description)}\n` +
      `• *Montant :* ${formatMoney(expense.cadAmountMinor, "CAD")}\n` +
      `• *Payeur :* ${expense.payer}\n` +
      `• *Statut :* ${expense.status.toUpperCase()}`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("📋 Voir les dépenses", "admin:treasury_expenses"),
      }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.answerCallbackQuery({ text: `Échec : ${msg}`, show_alert: true });
  }
});

// ==============================================================================
// 4. Record Withdrawal & Settlement
// ==============================================================================

treasuryComposer.callbackQuery("admin:treasury_withdraw", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `📤 *ENREGISTRER UN RETRAIT ET SON RÈGLEMENT*\n\n` +
    `Pour enregistrer un retrait d'Étoiles et le produit réglé en monnaie fiduciaire, envoyez :\n\n` +
    `*Format de la commande :*\n` +
    `\`/record_withdrawal <stars> <tonReceived> [netCadSettled]\`\n\n` +
    `*Exemple :*\n` +
    `\`/record_withdrawal 5000 12.5 85.00\``,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard().text("⬅️ Menu de la trésorerie", "admin:treasury_menu"),
    }
  );
});

treasuryComposer.command("record_withdrawal", async (ctx) => {
  const parts = (ctx.message?.text ?? "").trim().split(/\s+/).slice(1);
  if (parts.length < 2) {
    await ctx.reply(
      `⚠️ *Utilisation :* \`/record_withdrawal <stars> <tonReceived> [netCadSettled] [fragmentRef]\`\n\n` +
      `Exemple : \`/record_withdrawal 5000 12.5 85.00 FRAG123\`\n` +
      `Omettez le montant en CAD tant que le TON n'a pas été réellement converti en espèces.`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  const starsQuantity = /^\d+$/.test(parts[0]) ? Number(parts[0]) : NaN;
  const tonNano = parseTonToNano(parts[1]);
  const netMinor = parts[2] ? parseMoneyToMinor(parts[2]) : undefined;
  const fragmentReference = parts[3];

  if (!Number.isInteger(starsQuantity) || starsQuantity <= 0 || tonNano === null || tonNano <= 0) {
    await ctx.reply("⚠️ Les Étoiles doivent être un nombre entier et le TON, un nombre positif (maximum 9 décimales).");
    return;
  }
  if (parts[2] && (netMinor === null || netMinor === undefined || netMinor <= 0)) {
    await ctx.reply("⚠️ Le montant réglé en CAD doit être positif, avec au plus 2 décimales.");
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

    let msg = `✅ *RETRAIT ENREGISTRÉ !*\n\n• *Étoiles retirées :* ${record.starsQuantity} ⭐\n• *TON reçus :* ${tonNano / 1_000_000_000} TON\n• *Statut :* ${record.status.toUpperCase()}\n`;
    if (record.settlement) {
      msg += `• *Encaisse nette réglée :* ${formatMoney(record.settlement.netFundsReceivedMinor, "CAD")}\n\nLes fonds répartis ont été crédités aux acquisitions, à l'exploitation et à la réserve !`;
    } else {
      msg += `\n_Aucune encaisse n'est comptabilisée tant que le produit n'est pas réglé._`;
    }

    await ctx.reply(msg, {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard().text("💰 Aperçu de la trésorerie", "admin:treasury_menu"),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.reply(`⚠️ Échec de l'enregistrement du retrait : ${msg}`);
  }
});

// ==============================================================================
// 5. Reconcile Stars Holding Period
// ==============================================================================

treasuryComposer.callbackQuery("admin:treasury_reconcile", async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Rapprochement des transactions d'Étoiles en cours..." });

  const holdingResult = await reconcileStarHoldingStatuses();
  const apiResult = await reconcileStarTransactionsFromApi(ctx.api);

  await ctx.reply(
    `🔄 *RAPPROCHEMENT DES ÉTOILES TERMINÉ*\n\n` +
    `• *Transitions admissibles (21 jours) :* ${holdingResult.transitionedCount} transactions devenues retirables\n` +
    `• *Actuellement en attente (< 21 jours) :* ${holdingResult.totalPendingCount} transactions\n` +
    `• *Estimation des retirables (≥ 21 jours) :* ${holdingResult.totalWithdrawableCount} transactions\n` +
    `• *Nouvelles transactions API enregistrées :* ${apiResult.newTransactionsRecorded}\n` +
    `• *Remboursements appliqués :* ${apiResult.refundsApplied}\n` +
    `• *Retraits observés :* ${apiResult.withdrawalsObserved}\n` +
    `• *Doublons ignorés :* ${apiResult.duplicatesSkipped}` +
    (apiResult.errors.length ? `\n⚠️ ${apiResult.errors.join("; ")}` : ""),
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard().text("💰 Aperçu de la trésorerie", "admin:treasury_menu"),
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
    `📊 *APERÇU DU RAPPORT MENSUEL DE TRÉSORERIE*\n\n${preview}`,
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
    await ctx.answerCallbackQuery({ text: "Rapport introuvable.", show_alert: true });
    return;
  }

  const success = await publishMonthlyReportToChannel(ctx.api, report);
  if (success) {
    await ctx.answerCallbackQuery({ text: "Rapport publié dans le canal !" });
    await ctx.reply(`📢 *Le rapport mensuel de trésorerie pour ${period} a été publié dans le canal avec succès !*`);
  } else {
    await ctx.answerCallbackQuery({ text: "Échec de la publication du rapport dans le canal.", show_alert: true });
  }
});

treasuryComposer.callbackQuery(/^admin:report_audit:([0-9-]+)$/, async (ctx) => {
  const period = ctx.match[1];
  const report = await getTreasuryReport(period);
  if (!report) {
    await ctx.answerCallbackQuery({ text: "Rapport introuvable.", show_alert: true });
    return;
  }

  await ctx.answerCallbackQuery();
  const detailed = formatDetailedAdminReport(report);
  await ctx.reply(detailed, {
    parse_mode: "Markdown",
    reply_markup: new InlineKeyboard().text("⬅️ Menu de la trésorerie", "admin:treasury_menu"),
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
    `⚙️ *RÉPARTITION DE LA TRÉSORERIE ET ÉVALUATION*\n\n` +
    `*Pourcentages actuels de répartition des fonds :*\n` +
    `• Acquisitions de créateurs : *${alloc.acquisitionPct}%*\n` +
    `• Exploitation de la plateforme : *${alloc.operationsPct}%*\n` +
    `• Réserve protégée : *${alloc.reservePct}%*\n\n` +
    `*Évaluation des récompenses en Étoiles (rapports) :*\n` +
    `• Référence actuelle : *US$${val.starsRewardValuationUsd} / Étoile*\n\n` +
    `Choisissez un préréglage pour ajuster les prochaines répartitions :`,
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

  await ctx.answerCallbackQuery({ text: `Répartition mise à jour : ${acq}/${ops}/${res} % !` });
  await ctx.editMessageText(
    `✅ *RÉPARTITION DE LA TRÉSORERIE MISE À JOUR !*\n\n` +
    `• Acquisitions : *${acq} %*\n` +
    `• Exploitation : *${ops} %*\n` +
    `• Réserve de prévoyance : *${res} %*\n\n` +
    `Cette règle de répartition s'applique de façon prospective à tous les nouveaux règlements.`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard().text("💰 Aperçu de la trésorerie", "admin:treasury_menu"),
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
      `⚠️ *Utilisation :* \`/price <candidateId> <amount> [currency]\`\n\n` +
      `Exemple : \`/price 1234-abcd 20.00 CAD\``,
      { parse_mode: "Markdown" }
    );
    return;
  }

  const candidateId = parts[0];
  const amountMinor = parseMoneyToMinor(parts[1]);
  const currency = normalizeCurrency(parts[2] ?? "CAD");

  if (amountMinor === null || amountMinor <= 0) {
    await ctx.reply("⚠️ Le montant doit être un nombre positif avec au plus 2 décimales.");
    return;
  }
  if (!isSupportedExpenseCurrency(currency)) {
    await ctx.reply("⚠️ Devise non prise en charge. Devises acceptées : CAD, USD, EUR, GBP.");
    return;
  }

  const candidate = await getWantedCandidate(candidateId);
  if (!candidate) {
    await ctx.reply(`⚠️ Le candidat portant l'ID \`${candidateId}\` est introuvable.`);
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
    `🏷️ *PRIX DU CANDIDAT MIS À JOUR*\n\n` +
    `• *Créateur :* ${escapeMd(candidate.name)}\n` +
    `• *Prix prévu :* ${formatMoney(amountMinor, currency)} (${formatMoney(cadAmountMinor, "CAD")})\n` +
    `• *Capacité financière :* ${afford.affordable ? "✅ Abordable selon le budget" : `❌ Manque : ${formatMoney(afford.shortfallMinor, "CAD")}`}\n` +
    `• *Budget d'acquisition disponible :* ${formatMoney(afford.availableBudgetCadMinor, "CAD")}`,
    { parse_mode: "Markdown" }
  );
});

// ==============================================================================
// 9. Expense corrections & acquisition workflow
// ==============================================================================

treasuryComposer.command("refund_expense", async (ctx) => {
  const parts = (ctx.message?.text ?? "").trim().split(/\s+/).slice(1);
  if (parts.length < 1) {
    await ctx.reply("Utilisation : `/refund_expense <expenseId> [montant]` (omettez le montant pour un remboursement complet)", {
      parse_mode: "Markdown",
    });
    return;
  }
  const amountMinor = parts[1] ? parseMoneyToMinor(parts[1]) : undefined;
  if (parts[1] && (amountMinor === null || amountMinor === undefined)) {
    await ctx.reply("⚠️ Montant de remboursement invalide.");
    return;
  }
  try {
    const adj = await refundExpense({
      expenseId: parts[0],
      amountMinor: amountMinor ?? undefined,
      actorId: ctx.from!.id,
    });
    await ctx.reply(`✅ Remboursement de ${formatMoney(-adj.cadAmountMinor, "CAD")} enregistré pour la dépense \`${parts[0]}\`.`, {
      parse_mode: "Markdown",
    });
  } catch (err) {
    await ctx.reply(`⚠️ ${err instanceof Error ? err.message : String(err)}`);
  }
});

treasuryComposer.command("cancel_expense", async (ctx) => {
  const id = (ctx.message?.text ?? "").trim().split(/\s+/)[1];
  if (!id) {
    await ctx.reply("Utilisation : `/cancel_expense <expenseId>`", { parse_mode: "Markdown" });
    return;
  }
  try {
    await cancelExpense(id, ctx.from!.id);
    await ctx.reply("✅ Dépense annulée et tout budget réservé a été libéré.");
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
    await ctx.answerCallbackQuery({ text: "Budget réservé." });
    await ctx.reply(
      `✅ *Acquisition approuvée :* ${escapeMd(candidate.name)}\n` +
      `${formatMoney(commitmentExpense.cadAmountMinor, "CAD")} du budget d'acquisition ont été réservés.\n\n` +
      `_Rien n'a été acheté. Effectuez l'achat vous-même, puis confirmez le paiement ci-dessous._`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard()
          .text("💳 Payé avec les fonds du club", `admin:acq_paid:${candidate.id}:club_funds`)
          .row()
          .text("👤 J'ai payé personnellement", `admin:acq_paid:${candidate.id}:admin_personal`)
          .row()
          .text("↩️ Annuler et libérer le budget", `admin:acq_cancel:${candidate.id}`),
      }
    );
  } catch (err) {
    await ctx.answerCallbackQuery({
      text: `Échec : ${err instanceof Error ? err.message : String(err)}`.slice(0, 190),
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
    await ctx.answerCallbackQuery({ text: "Paiement confirmé." });
    await ctx.reply(
      `🎉 *${escapeMd(candidate.name)}* marqué comme acquis. Payé : ${formatMoney(expense.cadAmountMinor, "CAD")} ` +
      `(${expense.payer === "club_funds" ? "fonds du club" : "personnel de l'administrateur — remboursement en attente"}).`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    await ctx.answerCallbackQuery({
      text: `Échec : ${err instanceof Error ? err.message : String(err)}`.slice(0, 190),
      show_alert: true,
    });
  }
});

treasuryComposer.callbackQuery(/^admin:acq_cancel:([a-f0-9-]+)$/, async (ctx) => {
  try {
    const { cancelCandidateAcquisition } = await import("../../treasury/service.ts");
    const candidate = await cancelCandidateAcquisition(ctx.match[1], ctx.from!.id);
    await ctx.answerCallbackQuery({ text: "Engagement libéré." });
    await ctx.reply(`↩️ L'engagement pour *${escapeMd(candidate.name)}* a été libéré.`, { parse_mode: "Markdown" });
  } catch (err) {
    await ctx.answerCallbackQuery({
      text: `Échec : ${err instanceof Error ? err.message : String(err)}`.slice(0, 190),
      show_alert: true,
    });
  }
});
