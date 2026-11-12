/**
 * The ladder's ONLY money conversions. Every price a rung emits passes through one of these two
 * functions and lands as integer minor units; nothing else in the ladder does arithmetic on money.
 */
import { currencyExponent, toMinor } from "../money.ts";

/**
 * A major-unit figure ("59.99", 59.99, "45") → minor units of `currency`, exactly. `null` when the
 * figure is not a positive decimal. With no currency known the exponent-2 reading is used — every
 * currency this pipeline admits (USD, CAD, GBP, AUD, NZD, EUR) has two minor digits, and the
 * currency itself is resolved separately or the row is refused as `currency_unresolved`.
 */
export function majorToMinor(value: unknown, currency: string | null): number | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === "number" ? String(value) : String(value).trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  try {
    const minor = toMinor(text, currency ?? "");
    return minor > 0 ? minor : null;
  } catch {
    return null;
  }
}

/**
 * A figure the source already states in minor units WITH its declared scale (Woo Store API:
 * `price: "5999"` with `currency_minor_unit: 2`; Shopify `.js`: 5999 at scale 2) → minor units
 * of `currency`. Same scale → the integer verbatim; a different scale is rescaled exactly.
 */
export function declaredMinorToMinor(value: unknown, minorUnit: unknown, currency: string | null): number | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === "number" ? String(value) : String(value).trim();
  if (!/^\d+$/.test(text)) return null;
  const scale = Number.isInteger(minorUnit) ? (minorUnit as number) : 2;
  if (scale < 0 || scale > 6) return null;
  // Same scale, or no currency to rescale against (the figure is then kept at the source's own
  // declared scale, never re-read as cents): the integer verbatim.
  if (currency === null || currencyExponent(currency) === scale) {
    const n = Number(text);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }
  const padded = text.padStart(scale + 1, "0");
  const major = scale === 0 ? padded : `${padded.slice(0, padded.length - scale)}.${padded.slice(padded.length - scale)}`;
  return majorToMinor(major, currency);
}

/** Minor units → a major-unit string for messages and anchors. Display only, never stored. */
export function minorToMajorText(minor: number, currency: string | null): string {
  const exp = currencyExponent(currency ?? "");
  const abs = Math.abs(minor).toString().padStart(exp + 1, "0");
  const whole = exp === 0 ? abs : abs.slice(0, abs.length - exp);
  const frac = exp === 0 ? "" : `.${abs.slice(abs.length - exp)}`;
  return `${minor < 0 ? "-" : ""}${whole}${frac}`;
}
