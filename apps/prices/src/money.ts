/**
 * MONEY — integer minor units, explicit rounding, no float division.
 *
 * Every price the pipeline stores passes through here. A decimal amount is parsed as DIGITS
 * and divided as BigInts, never as an IEEE double: `0.1 + 0.2` is 0.30000000000000004 and
 * `1.005 * 100` is 100.49999999999999 — a cent lost at the point where the figure becomes a
 * claim about a vendor's price. Rounding is ROUND_HALF_EVEN everywhere.
 *
 * Ported from PeptideBase's money.ts (2026-09) without its float-compatible legacy path.
 */

/** ISO 4217 minor-unit exponents that are NOT 2. Listed so a wrong default is impossible. */
const ZERO_EXPONENT_CURRENCIES = new Set([
  "JPY", "KRW", "VND", "CLP", "ISK", "PYG", "RWF", "UGX", "VUV", "XAF", "XOF", "XPF",
]);

/** Minor units per major unit, as a power of ten. 2 unless the currency says otherwise. */
export function currencyExponent(currency: string): number {
  return ZERO_EXPONENT_CURRENCIES.has(String(currency ?? "").trim().toUpperCase()) ? 0 : 2;
}

interface ExactDecimal {
  digits: bigint;
  frac: number;
}

/** Expand JavaScript's exponent notation so the digit parser never sees an `e`. */
function expandExponential(text: string): string {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?[eE]([+-]?\d+)$/.exec(text);
  if (!m) return text;
  const [, sign, intPart, fracPart = "", expText] = m;
  const exp = parseInt(expText, 10);
  const digits = `${intPart}${fracPart}`;
  const pointFromRight = fracPart.length - exp;
  if (pointFromRight <= 0) return `${sign}${digits}${"0".repeat(-pointFromRight)}`;
  if (pointFromRight >= digits.length) return `${sign}0.${"0".repeat(pointFromRight - digits.length)}${digits}`;
  const cut = digits.length - pointFromRight;
  return `${sign}${digits.slice(0, cut)}.${digits.slice(cut)}`;
}

/** Parse a decimal string or finite number into exact digits. Throws rather than guessing. */
function parseExact(amount: number | string): ExactDecimal {
  let text: string;
  if (typeof amount === "number") {
    if (!Number.isFinite(amount)) throw new TypeError(`money: amount must be a finite number, received ${String(amount)}`);
    text = expandExponential(String(amount));
  } else {
    text = expandExponential(String(amount ?? "").trim());
  }
  const m = /^([+-]?)(\d+)(?:\.(\d*))?$/.exec(text);
  if (!m) throw new TypeError(`money: not a decimal amount: ${JSON.stringify(amount)}`);
  const [, sign, intPart, fracPart = ""] = m;
  const digits = BigInt(`${intPart}${fracPart}`);
  return { digits: sign === "-" ? -digits : digits, frac: fracPart.length };
}

const pow10 = (n: number): bigint => BigInt(10) ** BigInt(n);

/** `num / den` rounded half to even. `den` must be positive; the sign rides on `num`. */
export function divRoundHalfEven(num: bigint, den: bigint): bigint {
  if (den <= BigInt(0)) throw new RangeError("money: divisor must be positive");
  const negative = num < BigInt(0);
  const n = negative ? -num : num;
  const q = n / den;
  const twiceRemainder = (n % den) * BigInt(2);
  let rounded = q;
  if (twiceRemainder > den) rounded = q + BigInt(1);
  else if (twiceRemainder === den && q % BigInt(2) === BigInt(1)) rounded = q + BigInt(1);
  return negative ? -rounded : rounded;
}

function assertSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) throw new TypeError(`money: ${label} must be a safe integer, received ${String(value)}`);
}

function toNumber(value: bigint, label: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new RangeError(`money: ${label} overflows the safe integer range`);
  return n;
}

/** A decimal amount as integer minor units of `currency`, rounded half to even. `toMinor('19.99','USD') === 1999`. */
export function toMinor(amount: number | string, currency: string): number {
  const { digits, frac } = parseExact(amount);
  const exp = currencyExponent(currency);
  const scaled = exp >= frac ? digits * pow10(exp - frac) : divRoundHalfEven(digits, pow10(frac - exp));
  return toNumber(scaled, "minor amount");
}

/** Integer minor units back to a plain decimal string in major units. A value, not a rendering. */
export function fromMinor(minor: number, currency: string): string {
  assertSafeInteger(minor, "minor amount");
  const exp = currencyExponent(currency);
  const sign = minor < 0 ? "-" : "";
  const abs = BigInt(Math.abs(minor));
  if (exp === 0) return `${sign}${abs.toString()}`;
  const divisor = pow10(exp);
  const whole = abs / divisor;
  const fraction = (abs % divisor).toString().padStart(exp, "0");
  return `${sign}${whole.toString()}.${fraction}`;
}

/**
 * Price per unit as an integer in MAJOR units scaled by `10 ** scale`, for exponent-2 currencies.
 * `unitPriceMinor(4999, 10, 4) === 49990` — $49.99 over 10 units is $4.9990/unit.
 * `divisor` may be fractional; it is parsed exactly, never used as a float denominator.
 */
export function unitPriceMinor(minor: number, divisor: number, scale = 4): number {
  assertSafeInteger(minor, "minor amount");
  assertSafeInteger(scale, "scale");
  if (scale < 0) throw new RangeError("money: scale must not be negative");
  if (!Number.isFinite(divisor) || divisor <= 0) throw new RangeError(`money: divisor must be a positive finite number, received ${String(divisor)}`);
  const d = parseExact(divisor);
  const num = BigInt(minor) * pow10(scale) * pow10(d.frac);
  const den = d.digits * BigInt(100);
  return toNumber(divRoundHalfEven(num, den), "unit price");
}

/**
 * PepSpotter's stored per-mg figure: MINOR units per mg × 10^4, half-even, from the whole pack.
 * `perMgMinorE4(12600, 50) === 2520000` (US$126.00 for 50 mg → 252 minor/mg). The mass is parsed
 * exactly (2.5 mg is a real vial size), so nothing here is a float division.
 */
export function perMgMinorE4(priceMinor: number, totalMg: number): number {
  assertSafeInteger(priceMinor, "minor amount");
  if (!Number.isFinite(totalMg) || totalMg <= 0) throw new RangeError(`money: totalMg must be a positive finite number, received ${String(totalMg)}`);
  const mg = parseExact(totalMg);
  const num = BigInt(priceMinor) * pow10(4) * pow10(mg.frac);
  return toNumber(divRoundHalfEven(num, mg.digits), "per-mg amount");
}

/** Sum integer minor units. Same currency is the caller's responsibility; this only guards shape. */
export function addMinor(...minors: number[]): number {
  let total = BigInt(0);
  for (const m of minors) {
    assertSafeInteger(m, "minor amount");
    total += BigInt(m);
  }
  return toNumber(total, "minor amount");
}

/** `percent` of `minor`, rounded half to even. `percent` may be fractional (numeric(6,3)). */
export function pctOf(minor: number, percent: number | string): number {
  assertSafeInteger(minor, "minor amount");
  const p = parseExact(percent);
  const num = BigInt(minor) * p.digits;
  const den = BigInt(100) * pow10(p.frac);
  return toNumber(divRoundHalfEven(num, den), "percentage of minor amount");
}
