import { describe, it, expect } from 'vitest'
import { canonicalVialMg, isNonVialForm, packMultiplicity, parseSize, selectCanonicalVariation, parseWooVariations, VIAL_MAX_MG } from './canonical-unit.ts'

describe('canonicalVialMg', () => {
  it('parses a real single vial in mg', () => {
    expect(canonicalVialMg('BPC-157 10mg')).toEqual({ mg: 10, packCount: 1, totalMg: 10, reason: null })
    expect(canonicalVialMg('Peptide (Lyophilized) 5mg')).toEqual({ mg: 5, packCount: 1, totalMg: 5, reason: null })
  })
  it('parses mcg-denominated vials', () => {
    expect(canonicalVialMg('Kisspeptin 500mcg').mg).toBeCloseTo(0.5)
  })
  it('REJECTS bulk powder as non_vial_form — the GHK-Cu incident (powder keyword before mg)', () => {
    expect(canonicalVialMg('Powder: GHK-Cu 1000MG')).toEqual({ mg: null, reason: 'non_vial_form' })
  })
  it('REJECTS a >100mg quantity as bulk even without the powder word', () => {
    expect(canonicalVialMg('GHK-Cu 1000mg')).toEqual({ mg: null, reason: 'bulk_over_max' })
    expect(canonicalVialMg(`GHK-Cu ${VIAL_MAX_MG + 1}mg`).reason).toBe('bulk_over_max')
  })
  it('REJECTS non-vial forms and blends with typed reasons', () => {
    expect(canonicalVialMg('BPC-157 Transdermal Gel 25mg').reason).toBe('non_vial_form')
    expect(canonicalVialMg('BPC-157 500mcg/cap').reason).toBe('non_vial_form')
    expect(canonicalVialMg('GLOW BPC-157/TB-500 Blend 20mg').reason).toBe('blend')
  })
  it('returns typed no_mg when no size is present', () => {
    expect(canonicalVialMg('BPC-157')).toEqual({ mg: null, reason: 'no_mg' })
    expect(canonicalVialMg('')).toEqual({ mg: null, reason: 'no_mg' })
  })
})

describe('canonicalVialMg — found by the first dry-run hand check (2026-10-01)', () => {
  it('"N units" / "N count" is a pack of dosage units, not one vial — refused, never priced as a single vial', () => {
    expect(canonicalVialMg('5-Amino-1MQ 50mg – 60 units')).toEqual({ mg: null, reason: 'pack_ambiguous' })
    expect(canonicalVialMg('BPC-157 500mcg – 60 units')).toEqual({ mg: null, reason: 'pack_ambiguous' })
    expect(canonicalVialMg('MK-677 25mg (Ibutamoren Mesylate) – 60 units')).toEqual({ mg: null, reason: 'pack_ambiguous' })
    expect(canonicalVialMg('Tesofensine 500mcg 30 count')).toEqual({ mg: null, reason: 'pack_ambiguous' })
    expect(canonicalVialMg('SLU-PP-332 500mcg 60ct')).toEqual({ mg: null, reason: 'pack_ambiguous' })
  })
  it('CONTROL: the same names without a unit count are single vials', () => {
    expect(canonicalVialMg('5-Amino-1MQ 50mg')).toEqual({ mg: 50, packCount: 1, totalMg: 50, reason: null })
    expect(canonicalVialMg('BPC-157 500mcg')).toMatchObject({ mg: 0.5, packCount: 1, reason: null })
  })
  it('reads a thousands separator as part of the number: "1,500mg" is 1500 mg, never 500', () => {
    expect(canonicalVialMg('L-Glutathione Net Content: 1,500mg')).toEqual({ mg: null, reason: 'bulk_over_max' })
    expect(canonicalVialMg('Kisspeptin 1,200mcg')).toMatchObject({ mg: 1.2, reason: null })
    expect(parseSize('L-Glutathione Net Content: 1,500mg').mg_per_vial).toBe(1500)
    expect(parseSize('HCG Content: 5,000IU').labelled).toMatchObject({ value: 5000, unit: 'iu' })
  })
  it('CONTROL: a comma that is not a thousands separator is left alone', () => {
    expect(parseSize('Retatrutide 5mg,10mg').multi_size).toBe(true)
    // "157,500mcg" could be the name's digits or a figure: not read at all rather than guessed.
    expect(canonicalVialMg('BPC-157,500mcg')).toEqual({ mg: null, reason: 'no_mg' })
  })
})

describe('canonicalVialMg — the plan contract cases and the whole-branch review (2026-10-01)', () => {
  it('never converts mL to mg: a solution or a liquid is not a lyophilized vial', () => {
    expect(canonicalVialMg('BPC-157 5ml solution').reason).toBe('non_vial_form')
    expect(canonicalVialMg('BPC-157 Liquid 10mg 30ml').reason).toBe('non_vial_form')
    expect(canonicalVialMg('BPC-157 Solution 5mg 5ml').reason).toBe('non_vial_form')
    expect(canonicalVialMg('BPC-157 10mg/10ml').reason).toBe('non_vial_form')
  })
  it('kit of 10 × 5 mg: totalMg 50, packCount 10', () => {
    expect(canonicalVialMg('BPC-157 5mg (10 vials)')).toEqual({ mg: 5, packCount: 10, totalMg: 50, reason: null })
  })
  it('blend 5mg + 5mg is a blend, never 10 mg of one compound', () => {
    expect(canonicalVialMg('BPC-157 5mg / TB-500 5mg blend').reason).toBe('blend')
  })
  it('"N x M mg": M is one vial and N the count, whatever total the name leads with', () => {
    expect(canonicalVialMg('Tirzepatide 30mg (3 x 10mg vials)')).toEqual({ mg: 10, packCount: 3, totalMg: 30, reason: null })
    expect(canonicalVialMg('Semaglutide 10mg (2 x 5mg)')).toEqual({ mg: 5, packCount: 2, totalMg: 10, reason: null })
    expect(canonicalVialMg('BPC-157 2 x 5mg')).toEqual({ mg: 5, packCount: 2, totalMg: 10, reason: null })
    expect(canonicalVialMg('BPC-157 10mg x 5 vials')).toEqual({ mg: 10, packCount: 5, totalMg: 50, reason: null })
  })
  it('a mass called a TOTAL is the pack, not one vial', () => {
    expect(canonicalVialMg('BPC-157 2 Vials (10mg total)')).toEqual({ mg: 5, packCount: 2, totalMg: 10, reason: null })
    expect(canonicalVialMg('BPC-157 5mg 2 Vials (10mg total)')).toEqual({ mg: 5, packCount: 2, totalMg: 10, reason: null })
  })
  it('counts the pack shapes vendors and WooCommerce attributes actually use', () => {
    for (const [text, count] of [['BPC-157 5mg Vials: 10', 10], ['BPC-157 5mg Number of vials: 5', 5], ['BPC-157 5mg Box of 10', 10], ['BPC-157 5mg 10pk', 10], ['BPC-157 5mg Bundle of 5', 5]] as const) {
      expect(canonicalVialMg(text), text).toEqual({ mg: 5, packCount: count, totalMg: 5 * count, reason: null })
    }
  })
  it('a bare quantity attribute is ambiguous; "Max 2 per order" is not a pack; "Quantity: 10mg" is a mass', () => {
    expect(canonicalVialMg('BPC-157 5mg Quantity: 3')).toEqual({ mg: null, reason: 'pack_ambiguous' })
    expect(canonicalVialMg('BPC-157 5mg Qty: 3')).toEqual({ mg: null, reason: 'pack_ambiguous' })
    expect(canonicalVialMg('BPC-157 5mg Max 2 per order')).toEqual({ mg: 5, packCount: 1, totalMg: 5, reason: null })
    expect(canonicalVialMg('BPC-157 Quantity: 10mg')).toEqual({ mg: 10, packCount: 1, totalMg: 10, reason: null })
  })
})

describe('canonicalVialMg — found by replaying 67 real vendor feeds (2026-10-01)', () => {
  it('a "+"-joined pair is a blend even when the second name is short, and so is a "+"-joined dose list', () => {
    expect(canonicalVialMg('BPC-157 + TB-500 Amount: 10mg + 10mg')).toEqual({ mg: null, reason: 'blend' })
    expect(canonicalVialMg('BPC-157 + TB-500 10mg')).toEqual({ mg: null, reason: 'blend' })
    expect(canonicalVialMg('Peptide combo 5mg + 5mg')).toEqual({ mg: null, reason: 'blend' })
  })
  it('CONTROL: a "+" that is part of a name is not a blend', () => {
    expect(canonicalVialMg('NAD+ 100mg')).toEqual({ mg: 100, packCount: 1, totalMg: 100, reason: null })
    expect(canonicalVialMg('BPC-157 Pro+ 10mg')).toEqual({ mg: 10, packCount: 1, totalMg: 10, reason: null })
  })
  it('"Vial Amount: 25" is a pack of 25', () => {
    expect(canonicalVialMg('GHK-Cu Research Peptide mg amount: 50mg, Vial Amount: 25')).toEqual({ mg: 50, packCount: 25, totalMg: 1250, reason: null })
    expect(canonicalVialMg('GHK-Cu Research Peptide mg amount: 50mg, Vial Amount: 1')).toEqual({ mg: 50, packCount: 1, totalMg: 50, reason: null })
    expect(canonicalVialMg('BPC-157 5mg Vial count: 10')).toEqual({ mg: 5, packCount: 10, totalMg: 50, reason: null })
  })
})

describe('second review (2026-10-01): blends the name check missed, and kit labels read in the cheap direction', () => {
  it('"/"-joined names are a blend even with sizes in brackets, a short code, or a spaced code beside the slash', () => {
    for (const text of ['GLOW (70mg) / FOXO4-DRI (10mg) / SNAP 8 (20mg)', 'IGF1-LR3 (1mg) / Hexarelin (5mg)', 'Tesa (20mg) / Sermorelin (10mg)', 'BPC 157/TB-500 Size: 20mg', 'GLP-3(R) / CAGRILINTIDE weight: 20/5mg', 'SS-31/MOTS-c 10mg']) {
      expect(canonicalVialMg(text), text).toEqual({ mg: null, reason: 'blend' })
    }
  })
  it('an unspaced "+" between two names is a blend; a dose list "10/10mg" is a blend', () => {
    expect(canonicalVialMg('BPC157+TB500 10mg')).toEqual({ mg: null, reason: 'blend' })
    expect(canonicalVialMg('Recovery duo weight: 10/10mg')).toEqual({ mg: null, reason: 'blend' })
  })
  it('CONTROL: slashes and pluses that are not two names', () => {
    expect(canonicalVialMg('NAD+ 100mg')).toMatchObject({ mg: 100, reason: null })
    expect(canonicalVialMg('BPC-157 Pro+ 10mg')).toMatchObject({ mg: 10, reason: null })
    expect(canonicalVialMg('CJC-1295 w/o DAC 5mg')).toMatchObject({ mg: 5, reason: null })
    expect(canonicalVialMg('TB-500 (Thymosin Beta-4) 10mg')).toMatchObject({ mg: 10, reason: null })
    expect(canonicalVialMg('Semaglutide 5mg (GLP-1)')).toMatchObject({ mg: 5, reason: null })
  })
  it('"Vial: 10 mg" states a mass, not ten vials', () => {
    expect(canonicalVialMg('Semaglutide Vial: 10 mg')).toEqual({ mg: 10, packCount: 1, totalMg: 10, reason: null })
    expect(canonicalVialMg('Retatrutide - Vial: 5 mg')).toEqual({ mg: 5, packCount: 1, totalMg: 5, reason: null })
    expect(canonicalVialMg('Tirzepatide Amount per vial: 30 mg')).toEqual({ mg: 30, packCount: 1, totalMg: 30, reason: null })
    expect(canonicalVialMg('BPC-157 Vial Quantity: 5 mg')).toEqual({ mg: 5, packCount: 1, totalMg: 5, reason: null })
    expect(canonicalVialMg('BPC-157 5mg Vials: 10')).toEqual({ mg: 5, packCount: 10, totalMg: 50, reason: null }) // still a count
  })
  it('a pack total is recognised wherever "total" sits; a second mass that is count × the first names the total', () => {
    const fiveByTen = { mg: 5, packCount: 10, totalMg: 50, reason: null }
    expect(canonicalVialMg('Retatrutide Total: 50mg (10 vials)')).toEqual(fiveByTen)
    expect(canonicalVialMg('BPC-157 Total 50mg / 10 vials')).toEqual(fiveByTen)
    expect(canonicalVialMg('BPC-157 10 vials - total amount 50mg')).toEqual(fiveByTen)
    expect(canonicalVialMg('BPC-157 50mg (total) 10 vials')).toEqual(fiveByTen)
    expect(canonicalVialMg('Epitalon 50mg (10mg x 5)')).toEqual({ mg: 10, packCount: 5, totalMg: 50, reason: null })
    expect(canonicalVialMg('BPC-157 5mg 10 vials (50mg)')).toEqual(fiveByTen)
  })
  it('"total" that cannot be tied to the one mass stated is ambiguous: refused, never guessed', () => {
    expect(canonicalVialMg('BPC-157 Total of 10 vials, 5mg')).toEqual({ mg: null, reason: 'pack_ambiguous' })
  })
  it('tablets are not vials, however the bottle is described', () => {
    expect(canonicalVialMg('5-Amino-1MQ 50mg (25 tabs/bottle)')).toEqual({ mg: null, reason: 'non_vial_form' })
    expect(canonicalVialMg('BPC-157 500mcg (100 tabs/bottle)')).toEqual({ mg: null, reason: 'non_vial_form' })
    expect(canonicalVialMg('BPC-157 Arginine Tablets 500mcg')).toEqual({ mg: null, reason: 'non_vial_form' })
    expect(parseSize('5-Amino-1MQ 50mg (25 tabs/bottle)').form).toBe('tablet')
  })
  it('a kit described in brackets with a slash is a kit, not a blend', () => {
    expect(canonicalVialMg('AOD-9604 2mg (10 vials/kit)')).toEqual({ mg: 2, packCount: 10, totalMg: 20, reason: null })
  })
  it('the digits of a compound name are never a vial or pack count', () => {
    expect(canonicalVialMg('BPC-157 Vial 5mg')).toEqual({ mg: 5, packCount: 1, totalMg: 5, reason: null })
    expect(canonicalVialMg('PT-141 Vials 10mg')).toEqual({ mg: 10, packCount: 1, totalMg: 10, reason: null })
    expect(canonicalVialMg('BPC-157 x 5mg')).toEqual({ mg: 5, packCount: 1, totalMg: 5, reason: null })
  })
  it('"qty: 1" is one vial; a larger bare quantity stays ambiguous', () => {
    expect(canonicalVialMg('Ghk-Cu 100mg qty: 1')).toEqual({ mg: 100, packCount: 1, totalMg: 100, reason: null })
    expect(canonicalVialMg('BPC-157 5mg Quantity: 1')).toEqual({ mg: 5, packCount: 1, totalMg: 5, reason: null })
    expect(canonicalVialMg('BPC-157 5mg Qty: 3')).toEqual({ mg: null, reason: 'pack_ambiguous' })
  })
  it('a decimal comma and a leading-dot decimal are decimals: 2,5mg is 2.5 and .5mg is 0.5 — never 5', () => {
    expect(canonicalVialMg('Semaglutide 2,5mg')).toEqual({ mg: 2.5, packCount: 1, totalMg: 2.5, reason: null })
    expect(canonicalVialMg('Semaglutide 0,25mg')).toEqual({ mg: 0.25, packCount: 1, totalMg: 0.25, reason: null })
    expect(canonicalVialMg('Semaglutide .5mg')).toEqual({ mg: 0.5, packCount: 1, totalMg: 0.5, reason: null })
    expect(parseSize('Semaglutide 2,5mg').mg_per_vial).toBe(2.5)
    // A comma list is not a decimal, and its second figure is not read alone.
    expect(canonicalVialMg('Retatrutide 5,10mg').reason).toBe('no_mg')
  })
})

// Found by comparing the hosted rows with the vendors' own pages (data audit, 2026-10-02).
describe('data audit (2026-10-02): products that are not one retail vial', () => {
  it('a liquid ("LIQ") or dry-fill form is not a lyophilized vial', () => {
    expect(canonicalVialMg('Epithalon volume: 50mg LIQ')).toEqual({ mg: null, reason: 'non_vial_form' })
    expect(canonicalVialMg('GHK-Cu volume: 50mg LIQ')).toEqual({ mg: null, reason: 'non_vial_form' })
    expect(canonicalVialMg('5-Amino-1MQ Form: 50MG Dry-Fill')).toEqual({ mg: null, reason: 'non_vial_form' })
    expect(canonicalVialMg('MK-677 (Ibutamoren) Form: 25MG Dry Fill')).toEqual({ mg: null, reason: 'non_vial_form' })
  })
  it('a wholesale-only listing is not a price a visitor can buy one vial at', () => {
    expect(canonicalVialMg('AOD 9604 2mg (Wholesale ONLY)')).toEqual({ mg: null, reason: 'pack_ambiguous' })
  })
  it('CONTROL: the lyophilized sibling and an ordinary vial are still vials', () => {
    expect(canonicalVialMg('5-Amino-1MQ Form: 50MG (Lyophilized)')).toEqual({ mg: 50, packCount: 1, totalMg: 50, reason: null })
    expect(canonicalVialMg('Epithalon Weight: 50mg')).toEqual({ mg: 50, packCount: 1, totalMg: 50, reason: null })
    expect(canonicalVialMg('Liquorice-free BPC-157 10mg')).toEqual({ mg: 10, packCount: 1, totalMg: 10, reason: null })
  })
})

describe('parseWooVariations — variation-shape hardening', () => {
  it('parses the standard data-product_variations array (attributes → text)', () => {
    const raw = JSON.stringify([
      { display_price: 29.99, attributes: { attribute_form: 'Peptide (Lyophilized) 5mg' } },
      { display_price: 76.99, attributes: { attribute_form: 'Transdermal Gel 25mg' } },
    ])
    const v = parseWooVariations(raw)
    expect(v).toHaveLength(2)
    expect(v[0]).toEqual({ priceUsd: 29.99, text: 'Peptide (Lyophilized) 5mg' })
  })
  it('accepts an already-parsed array and a {variations:[…]} wrapper', () => {
    expect(parseWooVariations([{ price: 10, attributes: { a: '5mg' } }])[0].priceUsd).toBe(10)
    expect(parseWooVariations({ variations: [{ price: 10, sku: '5mg' }] })[0].text).toBe('5mg')
  })
  it('FAILS SAFE on the WooCommerce "false" sentinel (large deferred-AJAX variation sets)', () => {
    expect(parseWooVariations('false')).toEqual([])
  })
  it('FAILS SAFE on malformed JSON, empty, and null', () => {
    expect(parseWooVariations('[{bad json')).toEqual([])
    expect(parseWooVariations('')).toEqual([])
    expect(parseWooVariations(null)).toEqual([])
    expect(parseWooVariations(undefined)).toEqual([])
  })
  it('feeds selectCanonicalVariation so a parsed set still rejects bulk/non-vial', () => {
    const raw = JSON.stringify([
      { display_price: 33, attributes: { a: 'Powder 1000mg' } },
      { display_price: 29.99, attributes: { a: '5mg' } },
    ])
    const best = selectCanonicalVariation(parseWooVariations(raw))
    expect(best!.mg).toBe(5)
  })
})

describe('selectCanonicalVariation', () => {
  it('selects the real vial and REJECTS the bulk powder in the same product', () => {
    const variations = [
      { priceUsd: 33, text: 'Powder 1000mg' },        // bulk → rejected
      { priceUsd: 29.99, text: 'Peptide (Lyophilized) 5mg' }, // real vial
      { priceUsd: 76.99, text: 'Transdermal Gel 25mg' },      // non-vial → rejected
    ]
    const best = selectCanonicalVariation(variations)
    expect(best!.mg).toBe(5)
    expect(best!.perMg).toBeCloseTo(29.99 / 5)
  })
  it('returns null when no variation is a real vial', () => {
    expect(selectCanonicalVariation([{ priceUsd: 33, text: 'Powder 1000mg' }])).toBeNull()
  })
  it('picks the cheapest $/mg among real vials', () => {
    const best = selectCanonicalVariation([
      { priceUsd: 60, text: '10mg' },   // 6.0/mg
      { priceUsd: 35, text: '5mg' },    // 7.0/mg
    ])
    expect(best!.mg).toBe(10)
  })
})

describe('isNonVialForm — a blend sold as capsules or a spray is not a vial', () => {
  it('names the forms the vial reader refuses, and nothing else', () => {
    expect(isNonVialForm('BPC-157 + TB-500 Capsules 60ct')).toBe(true)
    expect(isNonVialForm('GLOW Nasal Spray 10ml')).toBe(true)
    expect(isNonVialForm('BPC-157 10mg + TB-500 10mg')).toBe(false)
  })
  it('REAL-DATA LOOK (2026-10-02): a topical is not a vial — and a percentage alone says nothing (it is usually a discount)', () => {
    expect(isNonVialForm('BPC-157 1.25%, TB-500 (TB4) 0.85% Topical (630mg Blend)')).toBe(true)
    expect(isNonVialForm('GHK-CU 1%, KPV 0.1% Topical 330mg')).toBe(true)
    expect(isNonVialForm('BPC-157 + TB-500 Topical 30mg')).toBe(true)
    expect(isNonVialForm('BPC-157 10mg + TB-500 10mg (Save 20% OFF)')).toBe(false)
    expect(isNonVialForm('GHK-Cu (Copper Peptide) 50mg 50 VIALS AT 30% OFF')).toBe(false)
    expect(isNonVialForm('BPC-157 + TB-500 10mg+10mg Quantity: 10 Vials (Save 20%)')).toBe(false)
  })
  it('FINAL REVIEW I3/I4: dissolving strips, films, melts and bottles are not vials', () => {
    expect(isNonVialForm('Melts Pro™ CJC-1295 + Ipamorelin Dissolving Strips')).toBe(true)
    expect(isNonVialForm('Melts Pro™ Selank + Semax')).toBe(true)
    expect(isNonVialForm('BPC-157 + TB-500 Oral Film')).toBe(true)
    expect(isNonVialForm('Glow (GHKcu 2mg/BPC 500mcg/TB 500mcg) (10 btls.)')).toBe(true)
    // A vendor that labels its vials "Bottle Content: 10mg+10mg" sells vials.
    expect(isNonVialForm('BPC-157 + TB-500(tb-4) (WOLVERINE BLEND) Bottle Content: 10mg+10mg')).toBe(false)
  })
  it('FINAL REVIEW I4: a pack count after a spaced hyphen, and before a dose list, is read', () => {
    expect(packMultiplicity('GLOW (70mg) -10 Vials')).toEqual({ count: 10, ambiguous: false })
    expect(packMultiplicity('BPC-157 + TB-500 Listed content: Kit (10 x 5/5mg)')).toEqual({ count: 10, ambiguous: false })
    // Controls: the 157 of a name, and the existing shapes.
    expect(packMultiplicity('BPC-157 Vial')).toEqual({ count: 1, ambiguous: false })
    // VPeptide's variation labels (2026-10-10): the attribute is named "Pack Size", the value says one vial.
    expect(packMultiplicity('Ipamorelin — 10mg | Selective GHS-R1a Pentapeptide Pack Size: Single Vial')).toEqual({ count: 1, ambiguous: false })
    expect(packMultiplicity('Ipamorelin — 10mg Pack Size: 10-Pack')).toEqual({ count: 10, ambiguous: false })
    expect(packMultiplicity('BPC-157 10mg One vial')).toEqual({ count: 1, ambiguous: false })
    expect(packMultiplicity('BPC-157 10mg Pack Size: single')).toEqual({ count: 1, ambiguous: false })
    // Pack wording with no stated count stays ambiguous.
    expect(packMultiplicity('BPC-157 10mg Pack')).toEqual({ count: null, ambiguous: true })
    expect(packMultiplicity('BPC-157 Research Kit')).toEqual({ count: null, ambiguous: true })
    expect(packMultiplicity('BPC-157 2 x 5mg')).toEqual({ count: 2, ambiguous: false })
    expect(packMultiplicity('BPC-157 5mg Vial x2')).toEqual({ count: 2, ambiguous: false })
  })
})
