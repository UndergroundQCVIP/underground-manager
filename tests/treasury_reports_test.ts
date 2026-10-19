/**
 * LA CONFRÉRIE — Treasury Reporting Automated Tests
 * Phase UG-03: Treasury, Expenses & Final Automation
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { setupTestEnvironment, MockTelegramApi } from "./test_helpers.ts";
import {
  formatDetailedAdminReport,
  formatPrivateMemberReport,
  generateMonthlyTreasuryReport,
  publishMonthlyReportToChannel,
} from "../src/treasury/reports.ts";
import { recordWithdrawalWithSettlement } from "../src/treasury/service.ts";
import { createEntitlement } from "../src/db/entitlements.ts";
import { createWantedCandidate, updateWantedStatus } from "../src/db/wanted.ts";
import { getTreasuryReport } from "../src/db/treasury.ts";

Deno.test("TREASURY REPORTS — Generates monthly report with accurate revenue, budget and community counts", async () => {
  await setupTestEnvironment();

  // Create 2 paid subscribers
  await createEntitlement({
    userId: 2001,
    source: "telegram_stars",
    spaces: ["vip_collections", "general_chat", "wanted_list"],
    startsAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
    status: "active",
  });
  await createEntitlement({
    userId: 2002,
    source: "telegram_stars",
    spaces: ["vip_collections", "general_chat", "wanted_list"],
    startsAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
    status: "active",
  });

  // Create 1 complimentary member
  await createEntitlement({
    userId: 3001,
    source: "complimentary",
    spaces: ["vip_collections"],
    startsAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
    status: "active",
  });

  // Settle $500.00 CAD
  await recordWithdrawalWithSettlement({
    starsQuantity: 25000,
    tonReceivedNano: 75_000_000_000,
    settlement: {
      settlementDate: new Date().toISOString(),
      amountExchangedTonNano: 75_000_000_000,
      currencyReceived: "CAD",
      netFundsReceivedMinor: 50000,
      effectiveRate: 6.67,
      feeMinor: 0,
    },
    adminId: 111111,
  });

  // Acquired candidate this month
  const cand = await createWantedCandidate({
    name: "Sienna",
    normalizedName: "sienna",
    status: "acquired",
    suggestedBy: 2001,
    supportCount: 15,
  });
  await updateWantedStatus(cand.id, "acquired");

  const report = await generateMonthlyTreasuryReport();
  assertEquals(report.activePaidSubscribersCount, 2);
  assertEquals(report.complimentaryMembersCount, 1);
  assertEquals(report.overview.settledNetCashCadMinor, 50000);
  assertEquals(report.creatorsAcquiredThisMonth.includes("Sienna"), true);

  // Stored in KV
  const stored = await getTreasuryReport(report.period);
  assertEquals(stored!.id, report.id);
});

Deno.test("TREASURY REPORTS — Formats clean, transparent member report", async () => {
  await setupTestEnvironment();

  const report = await generateMonthlyTreasuryReport("2026-10");
  const memberReport = formatPrivateMemberReport(report);

  assertStringIncludes(memberReport, "RAPPORT DE TRÉSORERIE LA CONFRÉRIE");
  assertStringIncludes(memberReport, "octobre 2026");
  assertStringIncludes(memberReport, "Revenus et entrées de fonds");
  assertStringIncludes(memberReport, "Budget et répartition");
  assertStringIncludes(memberReport, "Abonnés payants actifs");
});

Deno.test("TREASURY REPORTS — Detailed admin audit report includes comprehensive breakdown", async () => {
  await setupTestEnvironment();

  const report = await generateMonthlyTreasuryReport("2026-10");
  const adminReport = formatDetailedAdminReport(report);

  assertStringIncludes(adminReport, "RAPPORT D'AUDIT DÉTAILLÉ DE LA TRÉSORERIE");
  assertStringIncludes(adminReport, "Ventilation des Étoiles Telegram");
  assertStringIncludes(adminReport, "Encaisse réglée en monnaie fiduciaire (CAD)");
  assertStringIncludes(adminReport, "Pouvoir d'achat net pour les acquisitions");
});

Deno.test("TREASURY REPORTS — Publishes report to configured Telegram channel", async () => {
  await setupTestEnvironment();

  const report = await generateMonthlyTreasuryReport("2026-10");
  const mockApi = new MockTelegramApi();

  const success = await publishMonthlyReportToChannel(mockApi as any, report);
  assertEquals(success, true);
  assertEquals(mockApi.sentMessages.length, 1);
  assertStringIncludes(mockApi.sentMessages[0].text, "RAPPORT DE TRÉSORERIE LA CONFRÉRIE");
});
