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
  let now = new Date().toISOString().slice(0, 10);

  try {
    if (!config.EXCHANGE_RATE_API_URL) throw new Error("EXCHANGE_RATE_API_URL not configured");
    const res = await fetch(config.EXCHANGE_RATE_API_URL, {
      signal: AbortSignal.timeout(5000),
    });

    if (res.ok) {
      const data = await res.json();
      const rates: Record<string, number> = data.rates ?? {};
      rates["USD"] = 1.0;
      if (typeof data.time_last_update_unix === "number") {
        // Record the quote's own publication date, not merely when we fetched it.
        now = new Date(data.time_last_update_unix * 1000).toISOString().slice(0, 10);
      }

      // Save key pairs into KV
      for (const [target, rate] of Object.entries(rates)) {
        if (typeof rate === "number" && Number.isFinite(rate) && rate > 0) {
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

/** Fiat currencies with 2 minor-unit digits that expenses may be entered in. */
export const SUPPORTED_EXPENSE_CURRENCIES = ["CAD", "USD", "EUR", "GBP"] as const;

export function normalizeCurrency(currency: string): string {
  return currency.trim().toUpperCase();
}

export function isSupportedExpenseCurrency(currency: string): boolean {
  return (SUPPORTED_EXPENSE_CURRENCIES as readonly string[]).includes(normalizeCurrency(currency));
}

export interface RateInfo {
  rate: number;
  /** Date (YYYY-MM-DD) of the quote(s) used; the oldest one for cross rates. */
  date: string;
  source: ExchangeRateRecord["source"] | "identity";
}

/**
 * Get the effective exchange rate between two currencies, with provenance.
 * Throws for a currency with no stored or built-in rate rather than silently
 * converting 1:1.
 */
export async function getRateInfo(
  fromCurrency: CurrencyCode,
  toCurrency: CurrencyCode
): Promise<RateInfo> {
  const from = normalizeCurrency(fromCurrency);
  const to = normalizeCurrency(toCurrency);

  if (from === to) {
    return { rate: 1.0, date: new Date().toISOString().slice(0, 10), source: "identity" };
  }

  const direct = await getExchangeRate(from, to);
  if (direct) return { rate: direct.rate, date: direct.date, source: direct.source };

  // Cross rate via USD: 1 USD = rateFrom 'from', 1 USD = rateTo 'to'
  const fromRec = from === "USD" ? null : await getExchangeRate("USD", from);
  const toRec = to === "USD" ? null : await getExchangeRate("USD", to);

  const rateFrom = from === "USD" ? 1 : fromRec?.rate ?? FALLBACK_RATES_FROM_USD[from];
  const rateTo = to === "USD" ? 1 : toRec?.rate ?? FALLBACK_RATES_FROM_USD[to];
  if (!rateFrom || !rateTo) {
    throw new Error(`No exchange rate available for ${from} -> ${to}`);
  }

  const dates = [fromRec?.date, toRec?.date].filter((d): d is string => !!d).sort();
  const usedFallback = (from !== "USD" && !fromRec) || (to !== "USD" && !toRec);
  return {
    rate: rateTo / rateFrom,
    date: dates[0] ?? new Date().toISOString().slice(0, 10),
    source: usedFallback ? "fallback" : (fromRec ?? toRec)?.source ?? "fallback",
  };
}

export async function getRate(
  fromCurrency: CurrencyCode,
  toCurrency: CurrencyCode
): Promise<number> {
  return (await getRateInfo(fromCurrency, toCurrency)).rate;
}

/** Round half away from zero so refunds (negative amounts) mirror charges exactly. */
function roundSymmetric(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value));
}

/**
 * Convert money from one currency to another using integer minor units.
 * Result is rounded (half away from zero) to the nearest integer minor unit.
 */
export async function convertCurrency(
  amountMinor: number,
  fromCurrency: CurrencyCode,
  toCurrency: CurrencyCode
): Promise<{
  convertedAmountMinor: number;
  rate: number;
  rateDate?: string;
  rateSource?: string;
  fromCurrency: CurrencyCode;
  toCurrency: CurrencyCode;
}> {
  const from = normalizeCurrency(fromCurrency);
  const to = normalizeCurrency(toCurrency);

  if (!Number.isInteger(amountMinor)) {
    throw new Error("Amounts must be integer minor units");
  }

  if (from === to) {
    return {
      convertedAmountMinor: amountMinor,
      rate: 1.0,
      fromCurrency: from,
      toCurrency: to,
    };
  }

  const info = await getRateInfo(from, to);
  return {
    convertedAmountMinor: roundSymmetric(amountMinor * info.rate),
    rate: info.rate,
    rateDate: info.date,
    rateSource: info.source,
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
  rateDate?: string;
  rateSource?: string;
}> {
  const config = getConfig();
  const base = config.BASE_CURRENCY;
  const from = normalizeCurrency(fromCurrency);

  if (!isSupportedExpenseCurrency(from)) {
    throw new Error(
      `Unsupported currency "${fromCurrency}". Supported: ${SUPPORTED_EXPENSE_CURRENCIES.join(", ")}`
    );
  }

  await ensureFreshRates(from, base);

  const cadConv = await convertCurrency(amountMinor, from, base);
  const usdConv = await convertCurrency(amountMinor, from, "USD");

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
    rateDate: cadConv.rateDate,
    rateSource: cadConv.rateSource,
  };
}

/**
 * Best-effort refresh of the stored USD rates when today's quote is missing, so
 * expense conversions use a current published rate rather than a built-in
 * fallback. Never throws; the provenance (source/date) is recorded on each
 * expense so a fallback rate is visible in the audit trail.
 */
export async function ensureFreshRates(...currencies: string[]): Promise<void> {
  if (!getConfig().EXCHANGE_RATE_API_URL) return;
  const today = new Date().toISOString().slice(0, 10);
  for (const currency of currencies) {
    const c = normalizeCurrency(currency);
    if (c === "USD") continue;
    const rec = await getExchangeRate("USD", c);
    if (rec && (rec.isManual || rec.date >= today)) continue;
    await refreshExchangeRates();
    return;
  }
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
