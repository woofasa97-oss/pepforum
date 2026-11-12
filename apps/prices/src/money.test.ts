import { describe, it, expect } from 'vitest'

import {
  toMinor,
  fromMinor,
  unitPriceMinor,
  perMgMinorE4,
  addMinor,
  pctOf,
  currencyExponent,
} from './money.ts'

// The six cases in the first block are verbatim from the PR1 brief. Everything
// after them exists because a money module that only passes its own examples has
// not been tested — the boundaries (exact halves, negatives, zero-exponent
// currencies, non-integer divisors) are where a float slips back in.
describe('money', () => {
  it('converts decimal strings without float error', () => {
    expect(toMinor('19.99', 'USD')).toBe(1999)
    expect(toMinor(0.1 + 0.2, 'USD')).toBe(30)
  })

  it('rounds half to even', () => {
    expect(toMinor('1.005', 'USD')).toBe(100)
    expect(toMinor('1.015', 'USD')).toBe(102)
  })

  it('respects zero-exponent currencies', () => {
    expect(toMinor('1200', 'JPY')).toBe(1200)
  })

  it('unit price keeps an explicit scale', () => {
    expect(unitPriceMinor(4999, 10, 4)).toBe(49990) /* 4.9990 per unit at scale 4 */
  })

  it('legacy per-mg equals the 4-dp representation the writer stores today', () => {
    expect(perMgMinorE4(4999, 10)).toBe(4999000)
  })

  it('percent of minor rounds half-even', () => {
    expect(pctOf(1999, 10)).toBe(200)
  })
})

describe('money — half-even is applied in both directions', () => {
  // A positive control for the rounding mode itself: were this half-up, the
  // first of each pair would come back one minor unit higher.
  it('rounds an exact half down to an even quotient', () => {
    expect(toMinor('0.005', 'USD')).toBe(0)
    expect(toMinor('0.025', 'USD')).toBe(2)
  })

  it('rounds an exact half up to an even quotient', () => {
    expect(toMinor('0.015', 'USD')).toBe(2)
    expect(toMinor('0.035', 'USD')).toBe(4)
  })

  it('rounds away from the half correctly on both sides', () => {
    expect(toMinor('1.004', 'USD')).toBe(100)
    expect(toMinor('1.006', 'USD')).toBe(101)
  })

  it('is symmetric about zero', () => {
    expect(toMinor('-1.005', 'USD')).toBe(-100)
    expect(toMinor('-1.015', 'USD')).toBe(-102)
    expect(toMinor('-19.99', 'USD')).toBe(-1999)
  })
})

describe('money — parsing', () => {
  it('accepts numbers as well as strings', () => {
    expect(toMinor(19.99, 'USD')).toBe(1999)
    expect(toMinor(0, 'USD')).toBe(0)
  })

  it('expands exponent notation rather than parsing it as digits', () => {
    // String(1e-7) === '1e-7'. A naive digit parse reads that as 1 whole unit.
    expect(toMinor(1e-7, 'USD')).toBe(0)
    expect(toMinor(1.2e3, 'USD')).toBe(120000)
  })

  it('tolerates currency case and surrounding whitespace', () => {
    expect(toMinor(' 19.99 ', 'usd')).toBe(1999)
    expect(toMinor('1200', 'jpy')).toBe(1200)
  })

  it('throws on values that are not finite decimals', () => {
    expect(() => toMinor(Number.NaN, 'USD')).toThrow(/finite/i)
    expect(() => toMinor(Number.POSITIVE_INFINITY, 'USD')).toThrow(/finite/i)
    expect(() => toMinor('$19.99', 'USD')).toThrow(/decimal/i)
    expect(() => toMinor('', 'USD')).toThrow(/decimal/i)
  })
})

describe('money — currencyExponent', () => {
  it('defaults to 2', () => {
    expect(currencyExponent('USD')).toBe(2)
    expect(currencyExponent('EUR')).toBe(2)
    expect(currencyExponent('ZZZ')).toBe(2)
  })

  it('knows the zero-exponent currencies it lists', () => {
    expect(currencyExponent('JPY')).toBe(0)
    expect(currencyExponent('KRW')).toBe(0)
  })
})

describe('money — fromMinor', () => {
  it('round-trips through toMinor', () => {
    expect(fromMinor(1999, 'USD')).toBe('19.99')
    expect(toMinor(fromMinor(1999, 'USD'), 'USD')).toBe(1999)
  })

  it('pads the fraction to the currency exponent', () => {
    expect(fromMinor(5, 'USD')).toBe('0.05')
    expect(fromMinor(0, 'USD')).toBe('0.00')
  })

  it('emits no decimal point for a zero-exponent currency', () => {
    expect(fromMinor(1200, 'JPY')).toBe('1200')
  })

  it('keeps the sign on the whole value, not the fraction', () => {
    expect(fromMinor(-5, 'USD')).toBe('-0.05')
    expect(fromMinor(-1999, 'USD')).toBe('-19.99')
  })

  it('throws on a non-integer minor amount', () => {
    expect(() => fromMinor(19.99, 'USD')).toThrow(/integer/i)
  })
})

describe('money — unitPriceMinor', () => {
  it('divides by a fractional divisor without float error', () => {
    // $49.99 over 2.5 mg = $19.996/mg, at scale 4 → 199960.
    expect(unitPriceMinor(4999, 2.5, 4)).toBe(199960)
  })

  it('applies half-even at the requested scale', () => {
    // $1.00 over 3 = 0.333333…; at scale 2 → 33, at scale 4 → 3333.
    expect(unitPriceMinor(100, 3, 2)).toBe(33)
    expect(unitPriceMinor(100, 3, 4)).toBe(3333)
  })

  it('defaults the scale to 4', () => {
    expect(unitPriceMinor(4999, 10)).toBe(unitPriceMinor(4999, 10, 4))
  })

  it('refuses a zero or negative divisor rather than returning Infinity', () => {
    expect(() => unitPriceMinor(4999, 0)).toThrow(/divisor/i)
    expect(() => unitPriceMinor(4999, -1)).toThrow(/divisor/i)
  })
})

describe('money — perMgMinorE4 (PepSpotter)', () => {
  it('divides the whole pack price by the total mg, half-even, scaled by 10^4', () => {
    expect(perMgMinorE4(12600, 50)).toBe(2520000)     // US$126.00 / 50 mg = 2.52/mg → 252 minor/mg ×10^4
    expect(perMgMinorE4(10200, 30)).toBe(3400000)     // 102.00 / 30 mg
    expect(perMgMinorE4(1, 3)).toBe(3333)             // 0.3333… minor/mg → 3333
    expect(perMgMinorE4(4658, 2.5)).toBe(18632000)    // fractional mg divisor parsed exactly
  })
  it('refuses a non-positive mass', () => {
    expect(() => perMgMinorE4(4999, 0)).toThrow(/totalMg/i)
  })
})

describe('money — addMinor and pctOf', () => {
  it('adds integer minor units', () => {
    expect(addMinor(1999, 500, 1)).toBe(2500)
    expect(addMinor()).toBe(0)
    expect(addMinor(-100, 100)).toBe(0)
  })

  it('refuses non-integer addends', () => {
    expect(() => addMinor(19.99, 1)).toThrow(/integer/i)
  })

  it('takes a decimal percent without float error', () => {
    // value_percent is numeric(6,3), so thousandths of a percent must survive.
    expect(pctOf(10000, 12.5)).toBe(1250)
    expect(pctOf(20000, '12.345')).toBe(2469)
  })

  it('rounds a percentage half-even', () => {
    // 10000 × 12.345% = 1234.5 exactly; 1234 is even, so it stays.
    expect(pctOf(10000, '12.345')).toBe(1234)
  })

  it('handles 0 and 100 percent', () => {
    expect(pctOf(1999, 0)).toBe(0)
    expect(pctOf(1999, 100)).toBe(1999)
  })
})
