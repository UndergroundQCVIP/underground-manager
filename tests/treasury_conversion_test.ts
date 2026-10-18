/**
 * Underground Manager — Currency Conversion Automated Tests
 * Phase UG-03: Treasury, Expenses & Final Automation
 */

import { assertEquals } from "@std/assert";
import { setupTestEnvironment } from "./test_helpers.ts";
import {
  convertCurrency,
  convertToBaseCurrency,
  formatMoney,
  refreshExchangeRates,
} from "../src/treasury/conversion.ts";
import { saveExchangeRate } from "../src/db/exchange_rates.ts";
import { saveValuationConfig } from "../src/db/treasury.ts";

Deno.test("TREASURY CONVERSION — Same currency conversion returns identical amount with rate 1.0", async () => {
  await setupTestEnvironment();

  const res = await convertCurrency(1600, "CAD", "CAD");
  assertEquals(res.convertedAmountMinor, 1600);
  assertEquals(res.rate, 1.0);
});

Deno.test("TREASURY CONVERSION — Multi-currency conversion uses integer minor units without floating error", async () => {
  await setupTestEnvironment();

  // Save deterministic exchange rate: 1 USD = 1.35 CAD
  await saveExchangeRate({
    baseCurrency: "USD",
    targetCurrency: "CAD",
    rate: 1.35,
    date: "2026-10-18",
    source: "manual",
    isManual: true,
    updatedAt: new Date().toISOString(),
  });

  // Convert $10.00 USD (1000 cents) to CAD
  const res = await convertCurrency(1000, "USD", "CAD");
  assertEquals(res.convertedAmountMinor, 1350); // exactly $13.50 CAD
  assertEquals(Number.isInteger(res.convertedAmountMinor), true);
});

Deno.test("TREASURY CONVERSION — Base CAD conversion and indicative Stars estimation", async () => {
  await setupTestEnvironment();

  // Configure valuation: US$0.013 per Star (1.3 cents per Star)
  await saveValuationConfig({
    starsRewardValuationUsd: 0.013,
    effectiveDate: new Date().toISOString(),
  });

  // Save exchange rates: 1 USD = 1.30 CAD
  await saveExchangeRate({
    baseCurrency: "USD",
    targetCurrency: "CAD",
    rate: 1.30,
    date: "2026-10-18",
    source: "manual",
    isManual: true,
    updatedAt: new Date().toISOString(),
  });

  // $13.00 USD (1300 cents) -> CAD: 1690 cents, USD: 1300 cents.
  // Indicative Stars: 1300 cents / 1.3 cents = 1000 Stars
  const baseConv = await convertToBaseCurrency(1300, "USD");
  assertEquals(baseConv.cadAmountMinor, 1690);
  assertEquals(baseConv.usdAmountMinor, 1300);
  assertEquals(baseConv.indicativeStars, 1000);
});

Deno.test("TREASURY CONVERSION — formatMoney utility formats major and minor units correctly", async () => {
  assertEquals(formatMoney(1600, "CAD"), "$16.00 CAD");
  assertEquals(formatMoney(50, "USD"), "$0.50 USD");
  assertEquals(formatMoney(-2500, "CAD"), "-$25.00 CAD");
  assertEquals(formatMoney(750, "XTR"), "750 Stars");
});
