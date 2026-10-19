/**
 * LA CONFRÉRIE — exact decimal parsing for money inputs.
 *
 * Amounts typed by administrators are parsed from their decimal string
 * representation directly into integer minor units. Going through
 * parseFloat * 100 is wrong for values such as 1.005 or 0.29.
 */

/** "16", "16.5" or "16.50" -> 1600 / 1650 / 1650. Returns null when invalid. */
export function parseMoneyToMinor(input: string, decimals = 2): number | null {
  const m = /^(\d{1,12})(?:\.(\d{1,}))?$/.exec(input.trim());
  if (!m) return null;
  const frac = m[2] ?? "";
  if (frac.length > decimals) return null; // never silently round money
  const minor = Number(m[1] + frac.padEnd(decimals, "0"));
  return Number.isSafeInteger(minor) ? minor : null;
}

/** TON amount ("12.5") -> nanoTON (12_500_000_000). */
export function parseTonToNano(input: string): number | null {
  return parseMoneyToMinor(input, 9);
}
