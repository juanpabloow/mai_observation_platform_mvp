/**
 * Colombian-peso label for a raw numeric price string (E-4). The API returns `price` as the
 * raw DB value ("35000.00"); an LLM asked to quote that reformats it inconsistently
 * ("$35.00", "35 mil"). `price_label` gives a single canonical spoken form:
 *   "35000.00" → "$35.000"   (thousands dot, no decimals when the value is whole)
 *   "2500.50"  → "$2.500,50" (comma decimals when there are cents — Colombian convention)
 * The raw `price` is left unchanged beside it. One helper, reused everywhere services appear.
 */
export function priceLabelCOP(raw: string | number | null | undefined): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return null;
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  const intPart = Math.trunc(abs);
  const cents = Math.round((abs - intPart) * 100);
  const intStr = intPart.toLocaleString("de-DE"); // de-DE uses "." as the thousands separator
  return cents === 0 ? `${sign}$${intStr}` : `${sign}$${intStr},${String(cents).padStart(2, "0")}`;
}
