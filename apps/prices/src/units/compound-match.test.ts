// peptide-match — the single canonical resolver, extracted from the LLM scraper.
//
// These tests pin the behaviors both writers now depend on. The extraction is
// verbatim; the tests are new — the inline original was tested only through the
// scraper's end-to-end behavior, which is exactly how a second copy would have
// drifted unnoticed.
import { describe, it, expect } from 'vitest'
import { matchCompound, buildCompoundIndex, isDacVariant, resolveCompound } from './compound-match.ts'

const ROWS = [
  { id: 'pep-bpc', name: 'BPC-157', slug: 'bpc-157', aliases: ['Body Protection Compound'] },
  { id: 'pep-cjc', name: 'CJC-1295', slug: 'cjc-1295', aliases: ['Mod GRF 1-29'] },
  { id: 'pep-cjc-dac', name: 'CJC-1295 DAC', slug: 'cjc-1295-dac', aliases: [] },
  { id: 'pep-tb', name: 'TB-500', slug: 'tb-500', aliases: ['Thymosin Beta-4'] },
]
const { index, namesById, tokenOwner } = buildCompoundIndex(ROWS)

describe('buildCompoundIndex', () => {
  it('indexes names and aliases, lowercased', () => {
    expect(index.get('bpc-157')).toBe('pep-bpc')
    expect(index.get('body protection compound')).toBe('pep-bpc')
  })
  it('namesById keeps original casing for corroboration text-matching', () => {
    expect(namesById.get('pep-tb')).toEqual(['TB-500', 'Thymosin Beta-4'])
  })
  it('tokenOwner spans slug+name+aliases with first-owner-wins', () => {
    expect(tokenOwner.size).toBeGreaterThan(0)
  })
})

describe('matchCompound', () => {
  it('exact normalized hit wins', () => {
    expect(matchCompound('BPC-157', index)).toBe('pep-bpc')
    expect(matchCompound('  bpc-157  ', index)).toBe('pep-bpc')
  })
  it('unique word-boundary substring resolves (vendor decoration around the name)', () => {
    expect(matchCompound('TB-500 10mg Research Vial', index)).toBe('pep-tb')
  })
  it('ambiguity resolves to NULL — a wrong attribution is worse than none', () => {
    // Names both BPC and TB → two candidates → null.
    expect(matchCompound('BPC-157 + TB-500 stack', index)).toBeNull()
  })
  it('DAC polarity separates CJC-1295 from CJC-1295 DAC in both directions', () => {
    expect(matchCompound('CJC-1295 DAC 5mg', index)).toBe('pep-cjc-dac')
    expect(matchCompound('CJC-1295 (no DAC) 5mg', index)).toBe('pep-cjc')
  })
  it('DAC context: an exact hit honours it and resolves to the DAC sibling; on the substring path it blocks, never flips', () => {
    // (1) FIXED 2026-10-01 (was a pinned limitation of the reference matcher): the exact-hit
    //     fast path returned BEFORE the DAC-polarity filter, so a bare 'CJC-1295' whose variant
    //     said 'with DAC' resolved to the PLAIN compound. It now resolves to the DAC sibling.
    expect(matchCompound('CJC-1295', index, 'CJC-1295 with DAC 5mg vial')).toBe('pep-cjc-dac')
    // (2) FIXED 2026-10-01 as well: on the substring path a DAC context used only to BLOCK the
    //     plain key. It now resolves to the DAC sibling of the one plain key the name matches.
    expect(matchCompound('CJC-1295 5mg premium', index, 'ships with DAC')).toBe('pep-cjc-dac')
    //     With no DAC sibling to resolve to, the answer is still nothing — never the plain compound.
    expect(matchCompound('BPC-157 5mg premium', index, 'ships with DAC')).toBeNull()
    // Control: the same decorated name WITHOUT DAC context resolves to the plain id.
    expect(matchCompound('CJC-1295 5mg premium', index)).toBe('pep-cjc')
  })
  it('unknown names resolve to null, never a guess', () => {
    expect(matchCompound('Completely Unrelated Product', index)).toBeNull()
    expect(matchCompound('', index)).toBeNull()
    expect(matchCompound(null as unknown as string, index)).toBeNull()
  })
})

describe('matchCompound — found by the first dry-run hand check (2026-10-01)', () => {
  const rows = [
    ...ROWS,
    { id: 'pep-tb-frag', name: 'TB4-Frag', slug: 'tb4-frag', aliases: ['Thymosin Beta-4 Fragment'] },
    { id: 'pep-sema', name: 'Semaglutide', slug: 'semaglutide', aliases: [] },
  ]
  const idx = buildCompoundIndex(rows).index

  it('an exact name hit still honours DAC polarity: a "w/ DAC" variant of a plain parent is the DAC compound', () => {
    expect(matchCompound('CJC-1295', idx, 'CJC-1295 Content: 5mg (w/ DAC)')).toBe('pep-cjc-dac')
    expect(matchCompound('CJC-1295', idx, 'CJC-1295 Content: 5mg (No DAC)')).toBe('pep-cjc')
    expect(matchCompound('CJC-1295', idx, 'CJC-1295 Content: 5mg')).toBe('pep-cjc')
  })
  it('a DAC marker on a compound that has no DAC sibling matches nothing rather than the plain compound', () => {
    expect(matchCompound('Semaglutide', idx, 'Semaglutide Content: 5mg (w/ DAC)')).toBeNull()
  })
  it('a FRAGMENT of a compound is not the compound', () => {
    expect(matchCompound('Frag(17-23) TB-500 Peptide (10MG)', idx)).toBeNull()
    expect(matchCompound('TB-500 Fragment 5mg', idx)).toBeNull()
    expect(matchCompound('Thymosin Beta-4 Fragment 5mg', idx)).toBe('pep-tb-frag')
  })
  it('CONTROL: the compound itself still matches, and "fragrance" is not a fragment', () => {
    expect(matchCompound('TB-500 Peptide (TB4) 10MG', idx)).toBe('pep-tb')
    expect(matchCompound('BPC-157 fragrance-free 5mg', idx)).toBe('pep-bpc')
  })
})

describe('resolveCompound — THE attribution of one product, shared by the writer and the gate', () => {
  it('files by the name, with the variant label as context', () => {
    expect(resolveCompound({ name: 'CJC-1295', variantLabel: 'Content: 5mg (w/ DAC)' }, index)).toBe('pep-cjc-dac')
    expect(resolveCompound({ name: 'CJC-1295', variantLabel: 'Content: 5mg (No DAC)' }, index)).toBe('pep-cjc')
    expect(resolveCompound({ name: 'BPC-157 5mg', variantLabel: null }, index)).toBe('pep-bpc')
  })
  it('a variant label that names a different compound wins over its parent', () => {
    expect(resolveCompound({ name: 'Research Peptides', variantLabel: 'TB-500 10mg' }, index)).toBe('pep-tb')
    expect(resolveCompound({ name: 'BPC-157', variantLabel: 'TB-500 10mg' }, index)).toBe('pep-tb')
  })
  it('nothing matches → null', () => {
    expect(resolveCompound({ name: 'Bacteriostatic Water', variantLabel: '30ml' }, index)).toBeNull()
    expect(resolveCompound({ name: null, variantLabel: null }, index)).toBeNull()
  })
})

describe('DAC polarity comes from the variant label when the label carries the marker (review, 2026-10-01)', () => {
  it('a parent name that mentions both forms does not decide', () => {
    expect(resolveCompound({ name: 'CJC-1295 (With or Without DAC)', variantLabel: 'With DAC' }, index)).toBe('pep-cjc-dac')
    expect(resolveCompound({ name: 'CJC-1295 (With or Without DAC)', variantLabel: 'Without DAC' }, index)).toBe('pep-cjc')
    expect(resolveCompound({ name: 'CJC-1295 DAC / No DAC', variantLabel: 'DAC 2mg' }, index)).toBe('pep-cjc-dac')
    expect(resolveCompound({ name: 'CJC-1295 DAC / No DAC', variantLabel: 'No DAC 2mg' }, index)).toBe('pep-cjc')
  })
  it('without a marker in the label, the name decides as before', () => {
    expect(resolveCompound({ name: 'CJC-1295 DAC', variantLabel: 'Size: 2mg' }, index)).toBe('pep-cjc-dac')
    expect(resolveCompound({ name: 'CJC-1295 No DAC', variantLabel: 'Size: 2mg' }, index)).toBe('pep-cjc')
  })
})

describe('a name that names two compounds is a bundle or a blend: no single attribution (second review, 2026-10-01)', () => {
  const rows = [...ROWS, { id: 'pep-ipa', name: 'Ipamorelin', slug: 'ipamorelin', aliases: [] }, { id: 'pep-blend', name: 'BPC-157 + TB-500', slug: 'bpc-157-tb-500', aliases: ['BPC-157/TB-500'] }, { id: 'pep-tb-frag', name: 'TB4-Frag', slug: 'tb4-frag', aliases: ['Thymosin Beta-4 Fragment'] }]
  const idx = buildCompoundIndex(rows).index

  it('the DAC sibling is never conjured for a two-compound name', () => {
    expect(resolveCompound({ name: 'CJC-1295 (DAC)/Ipamorelin', variantLabel: 'weight: 10/10mg' }, idx)).toBeNull()
    expect(resolveCompound({ name: 'CJC-1295 & Ipamorelin', variantLabel: 'With DAC 5mg' }, idx)).toBeNull()
    expect(matchCompound('CJC-1295 DAC Ipamorelin 5mg', idx)).toBeNull()
    expect(resolveCompound({ name: 'CJC-1295 and Ipamorelin 5mg', variantLabel: 'Version: DAC' }, idx)).toBeNull()
  })
  it('two plain compounds in one name match nothing', () => {
    expect(matchCompound('BPC-157 and Ipamorelin 10mg', idx)).toBeNull()
    expect(matchCompound('Ipamorelin with TB-500 5mg', idx)).toBeNull()
  })
  it('CONTROL: the longest name wins inside one family — a DAC name, a fragment name and a blend compound are each ONE thing', () => {
    expect(matchCompound('CJC-1295 DAC 5mg', idx)).toBe('pep-cjc-dac')
    expect(matchCompound('Thymosin Beta-4 Fragment 5mg', idx)).toBe('pep-tb-frag')
    expect(matchCompound('BPC-157 + TB-500 10mg vial', idx)).toBe('pep-blend')
    expect(matchCompound('TB-500 (Thymosin Beta-4) 10MG', idx)).toBe('pep-tb')
    expect(resolveCompound({ name: 'CJC-1295 (With or Without DAC)', variantLabel: 'With DAC' }, idx)).toBe('pep-cjc-dac')
  })
})

describe('isDacVariant', () => {
  it('detects DAC and respects negations', () => {
    expect(isDacVariant('cjc-1295 dac')).toBe(true)
    expect(isDacVariant('cjc-1295 no dac')).toBe(false)
    expect(isDacVariant('cjc-1295 without dac')).toBe(false)
    expect(isDacVariant('cjc-1295 no-dac')).toBe(false)
    expect(isDacVariant('dacron fabric')).toBe(false) // word boundary, not substring
  })
})

// Found by comparing the hosted rows with the vendors' own pages (data audit, 2026-10-02).
describe('data audit (2026-10-02): an N-acetyl analogue is never priced as the plain peptide', () => {
  const idx = buildCompoundIndex([
    { id: 'selank', name: 'Selank', slug: 'selank', aliases: ['TP-7'] },
    { id: 'na-selank', name: 'N-Acetyl Selank', slug: 'n-acetyl-selank', aliases: ['NA-Selank', 'N-Acetyl Selank Amidate', 'Selank Amidate', 'NA Selank'] },
    { id: 'semax', name: 'Semax', slug: 'semax', aliases: [] },
    { id: 'na-semax', name: 'N-Acetyl Semax', slug: 'n-acetyl-semax', aliases: ['NA-Semax', 'N-Acetyl Semax Amidate', 'NA-Semax Amidate', 'NA Semax'] },
    { id: 'epithalon', name: 'Epithalon', slug: 'epithalon', aliases: ['Epitalon'] },
    { id: 'pt-141', name: 'PT-141', slug: 'pt-141', aliases: ['Bremelanotide'] },
    { id: 'snap-8', name: 'SNAP-8', slug: 'snap-8', aliases: ['Acetyl Octapeptide-3'] },
    { id: 'hexarelin', name: 'Hexarelin', slug: 'hexarelin', aliases: [] },
  ]).index

  it('files the analogue under its own compound however the vendor orders the words', () => {
    expect(matchCompound('Selank N-Acetyl Amidate 10mg', idx)).toBe('na-selank')
    expect(matchCompound('Selank (N-Acetyl  Amidate) 10mg', idx)).toBe('na-selank')
    expect(matchCompound('Selank NA 10mg', idx)).toBe('na-selank')
    expect(matchCompound('Semax NA 10mg', idx)).toBe('na-semax')
    expect(matchCompound('N- Acetyl Semax (30mg)', idx)).toBe('na-semax')
    expect(matchCompound('Semax N-Acetyl Amidate 30mg', idx)).toBe('na-semax')
    expect(matchCompound('N-Acetyl Selank Amidate 10mg', idx)).toBe('na-selank')
    expect(matchCompound('NA Selank 10mg', idx)).toBe('na-selank')
  })
  it('a variant label that repeats the plain name does not pull the analogue back to the plain compound', () => {
    expect(resolveCompound({ name: 'NA-Semax (N-Acetyl Semax)', variantLabel: 'Form: Semax 10MG' }, idx)).toBe('na-semax')
  })
  it('an analogue with no compound of its own matches nothing — never the plain peptide', () => {
    expect(matchCompound('N-Acetyl Epithalon', idx)).toBeNull()
    expect(resolveCompound({ name: 'N-Acetyl Epithalon Amidate', variantLabel: 'weight: 10mg' }, idx)).toBeNull()
    expect(matchCompound('N-Acetyl Epithalon 20mg (Avg 17.56) *Price Reduced*', idx)).toBeNull()
    expect(matchCompound('N-Acetyl PT-141', idx)).toBeNull()
  })
  it('CONTROL: the plain peptides, an acetate salt and an alias that merely contains "acetyl" still match', () => {
    expect(matchCompound('Selank 10mg', idx)).toBe('selank')
    expect(matchCompound('Semax (30mg)', idx)).toBe('semax')
    expect(matchCompound('Epithalon – Epitalon 10mg', idx)).toBe('epithalon')
    expect(matchCompound('Hexarelin Acetate', idx)).toBe('hexarelin')
    expect(matchCompound('SNAP-8 (Acetyl Octapeptide-3) 10mg', idx)).toBe('snap-8')
    expect(matchCompound('PT-141 10mg (Bremelanotide)', idx)).toBe('pt-141')
  })
})

describe('design review (2026-10-04): a salt form other than acetate is never priced as the plain compound', () => {
  const idx = buildCompoundIndex([
    { id: 'pep-bpc', name: 'BPC-157', slug: 'bpc-157', aliases: ['Body Protection Compound'] },
    { id: 'tb-500', name: 'TB-500', slug: 'tb-500', aliases: ['Thymosin Beta-4'] },
  ]).index

  it('an arginine salt or arginate matches nothing, in the name or the variant label', () => {
    expect(matchCompound('BPC-157 Arginine Salt 10mg', idx)).toBeNull()
    expect(matchCompound('BPC 157 Arginate 5mg', idx)).toBeNull()
    expect(matchCompound('BPC-157 (Arg Salt)', idx)).toBeNull()
    expect(matchCompound('Stable BPC-157 Arginine', idx)).toBeNull()
    expect(resolveCompound({ name: 'BPC-157 10mg', variantLabel: 'Form: Arginine Salt' }, idx)).toBeNull()
  })

  it('other named salts match nothing either', () => {
    expect(matchCompound('BPC-157 Sodium Salt', idx)).toBeNull()
    expect(matchCompound('TB-500 TFA salt 10mg', idx)).toBeNull()
    expect(matchCompound('BPC-157 HCl salt', idx)).toBeNull()
  })

  it('acetate — the usual form — and a plain name still match the compound', () => {
    expect(matchCompound('BPC-157 Acetate 10mg', idx)).toBe('pep-bpc')
    expect(matchCompound('BPC-157 (Acetate Salt) 10mg', idx)).toBe('pep-bpc')
    expect(matchCompound('BPC-157 10mg', idx)).toBe('pep-bpc')
    expect(resolveCompound({ name: 'TB-500 5mg', variantLabel: 'Form: Lyophilized powder' }, idx)).toBe('tb-500')
  })
})
