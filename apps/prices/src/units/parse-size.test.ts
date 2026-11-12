/**
 * parseSize — the label-parser fixture table.
 *
 * Every row is a real label shape. The table is the deliverable: the suite runs all of them,
 * asserts each field, and PRINTS `text | expected | actual` so the table can be read rather
 * than inferred from a pass count. A green run with no printed table is a claim about 24
 * strings that nobody looked at.
 *
 * WHAT THIS DOES NOT TEST. parseSize is DESCRIPTIVE: it reports what a label says. It does
 * not apply the vial ceiling, reject a non-vial form, or refuse a blend — those are
 * `canonicalVialMg`'s judgements and they live in canonical-unit.test.ts. A 500 mg NAD+ vial
 * reports 500 here and is refused there, and that is the design, not a disagreement.
 */
import { describe, it, expect } from 'vitest'

import { parseSize, type ParsedSize } from './canonical-unit.ts'

/** The five fields the fixture table pins. Everything else parseSize returns is asserted by
 *  the named cases below, not by the table. */
interface Expected {
  mg_per_vial: number | null
  vials_per_kit: number | null
  quantity_unit: ParsedSize['quantity_unit']
  form: ParsedSize['form']
  is_blend?: boolean
  multi_size?: boolean
}

const FIXTURES: ReadonlyArray<readonly [string, Expected]> = [
  ['BPC-157 10MG',                         { mg_per_vial: 10,   vials_per_kit: 1,    quantity_unit: 'mg', form: null }],
  ['CAGRISEMA 10 mg (10 vials)',           { mg_per_vial: 10,   vials_per_kit: 10,   quantity_unit: 'mg', form: 'vial_lyophilized' }],
  ['AOD-9604 10mg × 10 Vials (100mg)',     { mg_per_vial: 10,   vials_per_kit: 10,   quantity_unit: 'mg', form: 'vial_lyophilized' }],
  ['AOD-9604 5mg 50 VIALS',                { mg_per_vial: 5,    vials_per_kit: 50,   quantity_unit: 'mg', form: 'vial_lyophilized' }],
  ['Selank · 10 mg (1 Bottle)',            { mg_per_vial: 10,   vials_per_kit: 1,    quantity_unit: 'mg', form: null }],
  // DEVIATION (asserted, not glossed): `is_blend` is TRUE here and the brief does not
  // mention it. blend.mjs's dual-dose numeric rule — `\d+mg\s*/\s*\d+mg` — fires on a
  // same-peptide SIZE LIST, and it has done so since long before parseSize existed
  // (`canonicalVialMg` returns reason 'blend' for this exact string today). parseSize reports
  // the repo's single blend definition verbatim rather than second-guessing it, and decides
  // `multi_size` on NAME evidence instead, which is what separates this row from
  // "Tesamorelin/Ipamorelin 8MG/2MG". Pinned so the false positive is visible rather than
  // discovered later.
  ['Retatrutide 5mg / 10mg / 20mg',        { mg_per_vial: null, vials_per_kit: null, quantity_unit: 'mg', form: null, is_blend: true, multi_size: true }],
  // DEVIATION from the brief's expected `is_blend: false`. blend.mjs — the repo's single
  // blend definition — classifies a "/"-joined name pair carrying the word "Blend" AS a
  // blend, and the 2026-07 incident (a blend's total mass attributed to one ingredient,
  // making it look cheap against single-peptide rows) is why. parseSize reports that
  // definition rather than a second one. The MASS is the single stated mass; only the flag
  // differs from the brief.
  ['CJC-1295 / Ipamorelin Blend 20mg',     { mg_per_vial: 20,   vials_per_kit: 1,    quantity_unit: 'mg', form: null, is_blend: true }],
  ['Cagrilintide/Semaglutide 5/5mg blend', { mg_per_vial: 10,   vials_per_kit: 1,    quantity_unit: 'mg', form: null, is_blend: true }],
  ['Kit of 10 x 5mg',                      { mg_per_vial: 5,    vials_per_kit: 10,   quantity_unit: 'mg', form: null }],
  ['TB-500 5 mg – 2 vials',                { mg_per_vial: 5,    vials_per_kit: 2,    quantity_unit: 'mg', form: 'vial_lyophilized' }],
  ['Size: 10 mg',                          { mg_per_vial: 10,   vials_per_kit: 1,    quantity_unit: 'mg', form: null }],
  ['10 vials',                             { mg_per_vial: null, vials_per_kit: 10,   quantity_unit: null, form: 'vial_lyophilized' }],
  ['Melanotan II 500mcg',                  { mg_per_vial: 0.5,  vials_per_kit: 1,    quantity_unit: 'mg', form: null }],
  ['NAD+ 500mg (10 ml)',                   { mg_per_vial: 500,  vials_per_kit: 1,    quantity_unit: 'mg', form: null }],
  ['NAD+ 1g',                              { mg_per_vial: 1000, vials_per_kit: 1,    quantity_unit: 'mg', form: null }],
  ['HGH 100 IU',                           { mg_per_vial: null, vials_per_kit: 1,    quantity_unit: 'iu', form: null }],
  ['GHK-Cu Cream 30ml',                    { mg_per_vial: null, vials_per_kit: 1,    quantity_unit: 'ml', form: 'topical' }],
  ['AOD9604 Pre-Mixed Pen 2mg',            { mg_per_vial: 2,    vials_per_kit: 1,    quantity_unit: 'mg', form: 'pen' }],
  ['BPC-157 Nasal Spray 30mg',             { mg_per_vial: 30,   vials_per_kit: 1,    quantity_unit: 'mg', form: 'nasal' }],
  ['TB-500 (0.5mg/capsule), 60 Capsules',  { mg_per_vial: 0.5,  vials_per_kit: 60,   quantity_unit: 'mg', form: 'capsule' }],
  ['Semaglutide',                          { mg_per_vial: null, vials_per_kit: null, quantity_unit: null, form: null }],
  // ── negative controls ──────────────────────────────────────────────────────
  // mg/ml is a CONCENTRATION. The one answer this must never give is 10.
  ['10mg/ml x 3ml',                        { mg_per_vial: 30,   vials_per_kit: 1,    quantity_unit: 'mg', form: null }],
  // A concentration with no volume to multiply: refuse the mass, keep the unit.
  ['BPC-157 10mg/ml',                      { mg_per_vial: null, vials_per_kit: 1,    quantity_unit: 'ml', form: null }],
  // "NAD+" is a compound name, not a two-ingredient list. The space before "+" is what
  // blend.mjs requires, and this row is the control that the rule still holds.
  ['NAD+ 500mg',                           { mg_per_vial: 500,  vials_per_kit: 1,    quantity_unit: 'mg', form: null, is_blend: false }],
]

function actualTuple(p: ParsedSize): Expected {
  return {
    mg_per_vial: p.mg_per_vial,
    vials_per_kit: p.vials_per_kit,
    quantity_unit: p.quantity_unit,
    form: p.form,
    is_blend: p.is_blend,
    multi_size: p.multi_size,
  }
}

function render(e: Expected): string {
  const flags = [
    e.is_blend === true ? 'blend' : null,
    e.multi_size === true ? 'multi' : null,
  ].filter(Boolean).join('+')
  return `${e.mg_per_vial ?? '—'} | ${e.vials_per_kit ?? '—'} | ${e.quantity_unit ?? '—'} | ${e.form ?? '—'}${flags ? ` | ${flags}` : ''}`
}

describe('parseSize — Appendix B fixture table', () => {
  const rows: string[] = []

  for (const [text, expected] of FIXTURES) {
    it(`reads "${text}"`, () => {
      const parsed = parseSize(text)
      const actual = actualTuple(parsed)
      // Recorded BEFORE the assertion so a failing row still prints — a table that only
      // renders on success cannot show you the mismatch it is supposed to expose.
      rows.push(`${text.padEnd(40)} | ${render(expected).padEnd(44)} | ${render(actual)}`)
      expect(actual.mg_per_vial).toBe(expected.mg_per_vial)
      expect(actual.vials_per_kit).toBe(expected.vials_per_kit)
      expect(actual.quantity_unit).toBe(expected.quantity_unit)
      expect(actual.form).toBe(expected.form)
      if (expected.is_blend !== undefined) expect(actual.is_blend).toBe(expected.is_blend)
      if (expected.multi_size !== undefined) expect(actual.multi_size).toBe(expected.multi_size)
    })
  }

  it(`prints the table (${FIXTURES.length} rows) — the deliverable, not decoration`, () => {
    // Runs last within this describe, so every row above has been pushed. The count is
    // asserted rather than trusted: a table printing 3 of 24 rows looks identical to a
    // complete one when nobody counts.
    expect(rows).toHaveLength(FIXTURES.length)
    const header = `${'text'.padEnd(40)} | ${'expected (mg | vials | unit | form | flags)'.padEnd(44)} | actual`
    console.info(['', header, '-'.repeat(header.length), ...rows, ''].join('\n'))
  })
})

describe('parseSize — the shape it promises', () => {
  it('returns every field, on a string it cannot read at all', () => {
    // A parser that returns a partial object on its worst input makes every consumer
    // optional-chain its way around a shape that is supposed to be total.
    expect(parseSize('')).toEqual({
      mg_per_vial: null,
      vials_per_kit: null,
      quantity_unit: null,
      form: null,
      is_blend: false,
      multi_size: false,
      confidence: 'low',
      package_kind: 'single',
      labelled: null,
    })
  })

  it('does not throw on a non-string', () => {
    // `null` and `undefined` are IN the signature (`@param {string | null | undefined}`), not
    // a type violation — the callers are .mjs pipeline scripts reading vendor JSON, where a
    // null title is an ordinary Tuesday. Asserted rather than assumed: the guard is
    // `typeof text === 'string'`, and without it every field read below would throw.
    expect(parseSize(null).mg_per_vial).toBeNull()
    expect(parseSize(undefined).quantity_unit).toBeNull()
    expect(parseSize(null).is_blend).toBe(false)
  })

  it('reports the first quantity token verbatim', () => {
    expect(parseSize('BPC-157 5mg').labelled).toEqual({ value: 5, unit: 'mg', raw: '5mg' })
    expect(parseSize('1 mL vial').labelled).toEqual({ value: 1, unit: 'ml', raw: '1 mL' })
    expect(parseSize('Melanotan II 500mcg').labelled).toEqual({ value: 500, unit: 'mcg', raw: '500mcg' })
  })
})

describe('parseSize — confidence states what was inferred', () => {
  it('high: one unambiguous mass, pack count read or absent', () => {
    expect(parseSize('BPC-157 10MG').confidence).toBe('high')
    expect(parseSize('CAGRISEMA 10 mg (10 vials)').confidence).toBe('high')
  })

  it('medium: a blend sum, an inferred pack, or a concentration multiply', () => {
    expect(parseSize('Cagrilintide/Semaglutide 5/5mg blend').confidence).toBe('medium')
    expect(parseSize('AOD-9604 10mg × 10 Vials (100mg)').confidence).toBe('medium')
    expect(parseSize('10mg/ml x 3ml').confidence).toBe('medium')
  })

  it('low: a size list, or no mass at all', () => {
    expect(parseSize('Retatrutide 5mg / 10mg / 20mg').confidence).toBe('low')
    expect(parseSize('Semaglutide').confidence).toBe('low')
    expect(parseSize('HGH 100 IU').confidence).toBe('low')
  })
})

describe('parseSize — package_kind', () => {
  it('kit when the pack count is above one', () => {
    expect(parseSize('CAGRISEMA 10 mg (10 vials)').package_kind).toBe('kit')
    expect(parseSize('(2-Pack) CJC-1295 NO DAC 5mg').package_kind).toBe('kit')
  })

  it('tier on quantity-discount wording, and the comparable size stays single', () => {
    expect(parseSize('BPC-157 5mg - Buy 5 get 10% off').package_kind).toBe('tier')
    expect(parseSize('TB-500 10mg, 5 or more').package_kind).toBe('tier')
    expect(parseSize('BPC-157 5mg - Buy 5 get 10% off').vials_per_kit).toBe(1)
  })

  it('unknown on pack wording with no countable number', () => {
    expect(parseSize('BPC-157 5mg Value Pack').package_kind).toBe('unknown')
    expect(parseSize('BPC-157 5mg Value Pack').vials_per_kit).toBeNull()
  })

  it('single otherwise', () => {
    expect(parseSize('BPC-157 10MG').package_kind).toBe('single')
  })
})

describe('parseSize — the unit traps', () => {
  it('never reads the g of mg, mcg, µg or kg as a gram', () => {
    // A 1000x error, always in the direction that makes a vendor look cheap.
    expect(parseSize('BPC-157 500mg').mg_per_vial).toBe(500)
    expect(parseSize('Melanotan II 500mcg').mg_per_vial).toBe(0.5)
    expect(parseSize('Semax 500µg').mg_per_vial).toBe(0.5)
    expect(parseSize('Semax 500ug').mg_per_vial).toBe(0.5)
    // Positive control for the same regex: a real gram IS read as 1000 mg, so the four
    // negatives above are a discrimination and not a parser that reads no grams at all.
    expect(parseSize('NAD+ 1g').mg_per_vial).toBe(1000)
    expect(parseSize('BPC-157 Bulk Powder 5 grams').mg_per_vial).toBe(5000)
  })

  it('reads a size list as unresolved rather than picking one of its sizes', () => {
    for (const text of [
      'Retatrutide 5mg / 10mg / 20mg',
      'Tirzepatide 10mg, 20mg, 30mg',
      'BPC-157 5mg | 10mg',
      'TB-500 5mg or 10mg',
    ]) {
      const p = parseSize(text)
      expect(p.multi_size, text).toBe(true)
      expect(p.mg_per_vial, text).toBeNull()
      expect(p.vials_per_kit, text).toBeNull()
    }
  })

  it('does not call a per-unit mass beside a pack total a size list', () => {
    // NEGATIVE CONTROL for the rule above: two DIFFERENT mg values that are not a list.
    // Without the separator check this reads as multi-size and loses a real 10 mg vial.
    const p = parseSize('AOD-9604 10mg × 10 Vials (100mg)')
    expect(p.multi_size).toBe(false)
    expect(p.mg_per_vial).toBe(10)
  })

  it('does not call a repeated identical size a size list', () => {
    // "5mg / 5mg" is a dual-dose blend notation, not two choices.
    expect(parseSize('Ipamorelin 5mg / 5mg').multi_size).toBe(false)
  })

  it('sums a blend and leaves a single stated blend mass alone', () => {
    expect(parseSize('Tesamorelin/Ipamorelin 8MG/2MG').mg_per_vial).toBe(10)
    expect(parseSize('Cagrilintide/Semaglutide 5/5mg blend').mg_per_vial).toBe(10)
    expect(parseSize('BPC-157 5mg + TB-500 5mg blend').mg_per_vial).toBe(10)
    expect(parseSize('CJC-1295 / Ipamorelin Blend 20mg').mg_per_vial).toBe(20)
  })

  it('does not add a pack total into a blend sum', () => {
    // REGRESSION GUARD for a bug this task introduced and review caught. Callers concatenate
    // a product name with a raw price transcription, and blend.mjs's spaced-plus rule fires on
    // the PRICE half — "249 + tax" makes this string `is_blend`. Summing every mass token
    // returned 110 mg for a 10 mg vial: the "(100mg)" is the PACK TOTAL, and " × 10 Vials ("
    // is not an ingredient joiner. Masses add only across "/" or "+".
    const p = parseSize('AOD-9604 10mg × 10 Vials (100mg) $249 + tax')
    expect(p.is_blend).toBe(true)          // the (wrong) blend verdict is still reported as-is
    expect(p.mg_per_vial).toBe(10)         // …but it does not corrupt the mass
    expect(p.mg_per_vial).not.toBe(110)
    // POSITIVE CONTROL for the same walk: a genuine two-ingredient list DOES still add.
    expect(parseSize('BPC-157 5mg + TB-500 10mg blend').mg_per_vial).toBe(15)
  })

  it('reports a mass the $/mg gate refuses — they answer different questions', () => {
    // The design rule, as a test. canonicalVialMg's verdict on the same string lives in
    // canonical-unit.test.ts; if these two ever agree, one of them has taken the other's job.
    expect(parseSize('NAD+ 500mg').mg_per_vial).toBe(500)
    expect(parseSize('GHK-Cu Powder 1000mg').mg_per_vial).toBe(1000)
  })
})

describe('parseSize — form comes from WORDS, never from a number', () => {
  it('names each form from its own vocabulary', () => {
    expect(parseSize('AOD9604 Pre-Mixed Pen 2mg').form).toBe('pen')
    expect(parseSize('Semaglutide Prefilled Pen 5mg').form).toBe('pen')
    expect(parseSize('BPC-157 Nasal Spray 30mg').form).toBe('nasal')
    expect(parseSize('NAD+ 500mg Capsules').form).toBe('capsule')
    expect(parseSize('Semax Sublingual Tablets 10mg').form).toBe('tablet')
    expect(parseSize('BPC-157 Troche 5mg').form).toBe('tablet')
    expect(parseSize('GHK-Cu Cream 30ml').form).toBe('topical')
    expect(parseSize('GHK-Cu Gel 50ml').form).toBe('topical')
    expect(parseSize('Peptide (Lyophilized) 5mg').form).toBe('vial_lyophilized')
  })

  it('claims no form when the label names none', () => {
    // A mass is not a form. "Bottle" is not a form either — it is a container word used by
    // vial, capsule and solution products alike.
    expect(parseSize('BPC-157 10MG').form).toBeNull()
    expect(parseSize('Selank · 10 mg (1 Bottle)').form).toBeNull()
    expect(parseSize('Kit of 10 x 5mg').form).toBeNull()
    expect(parseSize('BPC-157 Bulk Powder 1g').form).toBeNull()
  })
})

describe('parseSize — pack counting', () => {
  it('reads every pack shape the brief names', () => {
    const cases: ReadonlyArray<readonly [string, number]> = [
      ['BPC-157 5mg × 3', 3],
      ['BPC-157 5mg x 3', 3],
      ['3 x 5mg BPC-157', 3],
      ['BPC-157 5mg 3 vials', 3],
      ['BPC-157 5mg 3-pack', 3],
      ['BPC-157 5mg pack of 3', 3],
      ['Kit of 3 x 5mg', 3],
      ['BPC-157 5mg, 3 per kit', 3],
      ['BPC-157 5mg bulk (3 vials)', 3],
      ['BPC-157 5mg 3 bottles', 3],
      ['BPC-157 5mg (3 vials)', 3],
      ['Selank 10mg (1 Bottle)', 1],
    ]
    for (const [text, count] of cases) expect(parseSize(text).vials_per_kit, text).toBe(count)
  })

  it('does not read a volume, a mass or a word-tail x as a pack count', () => {
    // NEGATIVE CONTROLS. "x 3ml" is three millilitres; "Max 10" is a product name.
    expect(parseSize('10mg/ml x 3ml').vials_per_kit).toBe(1)
    expect(parseSize('Tesamorelin x 5mg').vials_per_kit).toBe(1)
    expect(parseSize('Peptide Max 10 5mg').vials_per_kit).toBe(1)
  })

  it('does not read a hyphenated name suffix as a pack count', () => {
    // "BPC-157 x 5mg" is ONE 5 mg vial of BPC-157, and the number 157 is part of the name.
    // The reference reported this label as unreadable (null) for an inherited reason:
    // packMultiplicity read "157 x 5mg" through the same hole and its 50 cap turned the bad
    // count into `ambiguous`. That hole is closed (2026-10-01: the count patterns no longer
    // start inside a hyphenated name), so the label now reads as what it is — a single vial.
    const p = parseSize('BPC-157 x 5mg')
    expect(p.vials_per_kit).not.toBe(157)
    expect(p.vials_per_kit).toBe(1)
    expect(p.package_kind).toBe('single')
    // And the mass is read correctly.
    expect(p.mg_per_vial).toBe(5)
  })

  it('refuses an absurd count rather than storing it', () => {
    expect(parseSize('BPC-157 5mg 9000 vials').vials_per_kit).toBeNull()
  })
})

// Shapes first met on page-read shops (2026-10-03): a slash after a compound's own number, and a
// slash between an amount and a pack word, are not blends. Real blends written with "/" stay blends.
describe("a slash that does not join two ingredients", () => {
  it("BPC-157/5mg is one 5 mg vial of BPC-157, not a 162 mg blend", () => {
    const p = parseSize("BPC-157/5mg")
    expect(p.is_blend).toBe(false)
    expect(p.mg_per_vial).toBe(5)
    expect(p.vials_per_kit).toBe(1)
  })

  it("an amount / pack word is a single compound: '65mg / Single Vial', '65mg / 5-Pack'", () => {
    const single = parseSize("Tirzepatide 65mg / Single Vial")
    expect(single).toMatchObject({ is_blend: false, mg_per_vial: 65, vials_per_kit: 1 })
    const pack = parseSize("Tirzepatide 65mg / 5-Pack")
    expect(pack).toMatchObject({ is_blend: false, mg_per_vial: 65, vials_per_kit: 5 })
  })

  it("real blends written with a slash stay blends", () => {
    for (const label of ["Tesamorelin/Ipamorelin 6/3mg", "BPC 157/TB-500", "Weight: 10/10mg", "Tesamorelin 10mg / Ipamorelin 3mg Blend", "BPC-157 + TB-500 Blend/1010"]) {
      expect(parseSize(label).is_blend, label).toBe(true)
    }
  })
})
