/**
 * Underground Manager — Currency Conversion & Exchange Rate Service
 * Phase UG-03: Treasury, Expenses & Final Automation
 */

import { getConfig } from "../config.ts";
import { getExchangeRate, saveExchangeRate } from "../db/exchange_rates.ts";
import { getValuationConfig } from "../db/treasury.ts";
import { CurrencyCode, ExchangeRateRecord } from "../types.ts";

// Fallback rates (Base: USD) if external network/API is temporarily unavailable
const FALLBACK_RATES_FROM_USD: Record<string, number> = {
  USD: 1.0,
  CAD: 1.36,
  EUR: 0.92,
  GBP: 0.77,
  TON: 0.19, // 1 USD = ~0.19 TON (i.e. 1 TON = ~$5.20 USD)
};

/**
 * Fetch latest rates from public API or fallback, and cache in Deno KV.
 */
export async function refreshExchangeRates(): Promise<{
  success: boolean;
  rates: Record<string, number>;
  source: string;
}> {
  const config = getConfig();
  const now = new Date().toISOString().slice(0, 10);

  try {
    const res = await fetch(config.EXCHANGE_RATE_API_URL, {
      signal: AbortSignal.timeout(5000),
    });

    if (res.ok) {
      const data = await res.json();
      const rates: Record<string, number> = data.rates ?? {};
      rates["USD"] = 1.0;

      // Save key pairs into KV
      for (const [target, rate] of Object.entries(rates)) {
        if (typeof rate === "number" && rate > 0) {
          await saveExchangeRate({
            baseCurrency: "USD",
            targetCurrency: target.toUpperCase(),
            rate,
            date: now,
            source: "open_er_api",
            isManual: false,
            updatedAt: new Date().toISOString(),
          });
        }
      }

      return { success: true, rates, source: "open_er_api" };
    }
  } catch (err) {
    console.warn("[ExchangeRate] Failed to fetch external rates, using cache/fallback:", err);
  }

  // Fallback persistence
  for (const [target, rate] of Object.entries(FALLBACK_RATES_FROM_USD)) {
    const existing = await getExchangeRate("USD", target);
    if (!existing) {
      await saveExchangeRate({
        baseCurrency: "USD",
        targetCurrency: target,
        rate,
        date: now,
        source: "fallback",
        isManual: false,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  return { success: true, rates: FALLBACK_RATES_FROM_USD, source: "fallback" };
}

/**
 * Get effective exchange rate between two currencies.
 */
export async function getRate(
  fromCurrency: CurrencyCode,
  toCurrency: CurrencyCode
): Promise<number> {
  const from = fromCurrency.toUpperCase();
  const to = toCurrency.toUpperCase();

  if (from === to) return 1.0;

  // Direct check
  const direct = await getExchangeRate(from, to);
  if (direct) return direct.rate;

  // Cross rate via USD
  const fromToUsdRate = await getExchangeRate("USD", from);
  const toToUsdRate = await getExchangeRate("USD", to);

  const rateFrom = fromToUsdRate ? fromToUsdRate.rate : (FALLBACK_RATES_FROM_USD[from] ?? 1.0);
  const rateTo = toToUsdRate ? toToUsdRate.rate : (FALLBACK_RATES_FROM_USD[to] ?? 1.0);

  // If 1 USD = rateFrom 'from' and 1 USD = rateTo 'to', then 1 'from' = (rateTo / rateFrom) 'to'
  return rateTo / rateFrom;
}

/**
 * Convert money from one currency to another using integer minor units.
 * Result is rounded to nearest integer minor unit (e.g. cents).
 */
export async function convertCurrency(
  amountMinor: number,
  fromCurrency: CurrencyCode,
  toCurrency: CurrencyCode
): Promise<{
  convertedAmountMinor: number;
  rate: number;
  fromCurrency: CurrencyCode;
  toCurrency: CurrencyCode;
}> {
  const from = fromCurrency.toUpperCase();
  const to = toCurrency.toUpperCase();

  if (from === to) {
    return {
      convertedAmountMinor: amountMinor,
      rate: 1.0,
      fromCurrency: from,
      toCurrency: to,
    };
  }

  const rate = await getRate(from, to);
  const convertedAmountMinor = Math.round(amountMinor * rate);

  return {
    convertedAmountMinor,
    rate,
    fromCurrency: from,
    toCurrency: to,
  };
}

/**
 * Convert an amount in any currency into the base reporting currency (CAD).
 */
export async function convertToBaseCurrency(
  amountMinor: number,
  fromCurrency: CurrencyCode
): Promise<{
  cadAmountMinor: number;
  usdAmountMinor: number;
  indicativeStars: number;
  rateToCad: number;
}> {
  const config = getConfig();
  const base = config.BASE_CURRENCY;

  const cadConv = await convertCurrency(amountMinor, fromCurrency, base);
  const usdConv = await convertCurrency(amountMinor, fromCurrency, "USD");

  const valuation = await getValuationConfig();
  // 1 Star = valuation.starsRewardValuationUsd USD
  // usdAmountMinor is in USD cents. 1 USD = 100 cents.
  // valuation in cents = valuation.starsRewardValuationUsd * 100
  const starValuationCents = valuation.starsRewardValuationUsd * 100;
  const indicativeStars =
    starValuationCents > 0
      ? Math.round(usdConv.convertedAmountMinor / starValuationCents)
      : 0;

  return {
    cadAmountMinor: cadConv.convertedAmountMinor,
    usdAmountMinor: usdConv.convertedAmountMinor,
    indicativeStars,
    rateToCad: cadConv.rate,
  };
}

/**
 * Format minor units into human-readable currency string (e.g. 1600 cents -> "$16.00 CAD").
 */
export function formatMoney(amountMinor: number, currency: CurrencyCode = "CAD"): string {
  const curr = currency.toUpperCase();
  const sign = amountMinor < 0 ? "-" : "";
  const abs = Math.abs(amountMinor);
  const major = Math.floor(abs / 100);
  const minor = String(abs % 100).padStart(2, "0");

  let symbol = "$";
  if (curr === "EUR") symbol = "€";
  if (curr === "GBP") symbol = "£";
  if (curr === "TON") {
    // TON is usually represented as standard decimal units
    return `${(amountMinor / 100).toFixed(2)} TON`;
  }
  if (curr === "XTR") {
    return `${abs} Stars`;
  }

  return `${sign}${symbol}${major}.${minor} ${curr}`;
}
