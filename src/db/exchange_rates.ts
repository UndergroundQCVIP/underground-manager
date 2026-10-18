/**
 * Underground Manager — Exchange Rate Repository
 * Phase UG-03: Treasury, Expenses & Final Automation
 */

import { getKv } from "./kv.ts";
import { ExchangeRateRecord } from "../types.ts";

export async function saveExchangeRate(record: ExchangeRateRecord): Promise<void> {
  const kv = await getKv();
  const base = record.baseCurrency.toUpperCase();
  const target = record.targetCurrency.toUpperCase();

  const atomic = kv.atomic();
  atomic.set(["exchange_rates", base, target], record);
  atomic.set(["exchange_rate_history", base, target, record.date], record);
  const res = await atomic.commit();
  if (!res.ok) {
    throw new Error(`Failed to commit exchange rate for ${base}/${target}`);
  }
}

export async function getExchangeRate(
  baseCurrency: string,
  targetCurrency: string
): Promise<ExchangeRateRecord | null> {
  const kv = await getKv();
  const base = baseCurrency.toUpperCase();
  const target = targetCurrency.toUpperCase();

  if (base === target) {
    return {
      baseCurrency: base,
      targetCurrency: target,
      rate: 1.0,
      date: new Date().toISOString().slice(0, 10),
      source: "manual",
      isManual: true,
      updatedAt: new Date().toISOString(),
    };
  }

  const res = await kv.get<ExchangeRateRecord>(["exchange_rates", base, target]);
  return res.value ?? null;
}

export async function listExchangeRates(): Promise<ExchangeRateRecord[]> {
  const kv = await getKv();
  const iter = kv.list<ExchangeRateRecord>({ prefix: ["exchange_rates"] });
  const rates: ExchangeRateRecord[] = [];
  for await (const entry of iter) {
    if (entry.value) {
      rates.push(entry.value);
    }
  }
  return rates;
}
