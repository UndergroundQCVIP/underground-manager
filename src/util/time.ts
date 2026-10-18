/**
 * Underground Manager — Time helpers pinned to America/Toronto.
 *
 * Deno Deploy runs in UTC and Deno.cron schedules are UTC, so every
 * user-facing date, monthly cycle and "daily" boundary is derived here
 * (DST-aware via Intl) instead of from the host timezone.
 */

export const APP_TIMEZONE = "America/Toronto";

const partsFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: APP_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
});

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
}

export function torontoParts(date: Date = new Date()): LocalParts {
  const out: Record<string, number> = {};
  for (const p of partsFormatter.formatToParts(date)) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return { year: out.year, month: out.month, day: out.day, hour: out.hour % 24 };
}

/** Monthly cycle id ("YYYY-MM") in Toronto local time. */
export function torontoMonthCycle(date: Date = new Date()): string {
  const p = torontoParts(date);
  return `${p.year}-${String(p.month).padStart(2, "0")}`;
}

/** Calendar day key ("YYYY-MM-DD") in Toronto local time. */
export function torontoDateKey(date: Date = new Date()): string {
  const p = torontoParts(date);
  return `${torontoMonthCycle(date)}-${String(p.day).padStart(2, "0")}`;
}

export function formatTorontoDate(
  input: Date | string,
  options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" }
): string {
  const date = typeof input === "string" ? new Date(input) : input;
  return date.toLocaleString("en-US", { ...options, timeZone: APP_TIMEZONE });
}
