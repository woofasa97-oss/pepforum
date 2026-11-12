/**
 * Keeps the TypeScript vocabulary (src/domain.ts) and the SQL constraints in
 * lock-step. If a migration adds a classification or reason tag, this fails
 * until domain.ts is updated, and vice versa.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  APPEAL_STATUSES,
  COA_METHODS,
  COA_SCOPES,
  COA_STATUSES,
  CONTENT_STATUSES,
  MEMBER_REPORT_OUTCOMES,
  MEMBER_REPORT_REASONS,
  MOD_ACTIONS,
  NOTE_CLASSIFICATIONS,
  NOTE_STATUSES,
  POST_TYPES,
  PRICE_AVAILABILITIES,
  PRICE_VENDOR_STATUSES,
  RATER_STATUSES,
  RATING_REASONS,
  RATING_VALUES,
  REPORT_REASONS,
  REPORT_STATUSES,
  SANCTION_KINDS,
  SHIELD_ACTIONS,
  SOURCE_KINDS,
  STAFF_NOTE_LABELS,
  TICKET_KINDS,
  TICKET_STATUSES,
  inferSourceKind,
} from '../src/index.ts';
import { TestDb } from '../src/testing/index.ts';

let db: TestDb;

beforeAll(async () => {
  db = await TestDb.create();
});

afterAll(async () => {
  await db.close();
});

/** Values listed in a CHECK (col in (...)) constraint, read from the catalog. */
async function checkValues(table: string, column: string): Promise<string[]> {
  const rows = await db.sql<{ def: string }>(
    `select pg_get_constraintdef(c.oid) as def
     from pg_constraint c join pg_class t on t.oid = c.conrelid
     where t.relname = $1 and c.contype = 'c' and pg_get_constraintdef(c.oid) like '%' || $2 || '%= ANY%'`,
    [table, column],
  );
  const def = rows.find((r) => new RegExp(`\\(${column}\\b|\\b${column} =`).test(r.def))?.def ?? '';
  return [...def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1] as string).sort();
}

describe('domain vocabulary matches the schema', () => {
  it.each([
    ['posts', 'post_type', POST_TYPES],
    ['posts', 'status', CONTENT_STATUSES],
    ['notes', 'classification', NOTE_CLASSIFICATIONS],
    ['notes', 'status', NOTE_STATUSES],
    ['note_sources', 'kind', SOURCE_KINDS],
    ['note_ratings', 'value', RATING_VALUES],
    ['reports', 'reason', REPORT_REASONS],
    ['profiles', 'rater_status', RATER_STATUSES],
    ['comments', 'status', CONTENT_STATUSES],
    ['reports', 'status', REPORT_STATUSES],
    ['appeals', 'status', APPEAL_STATUSES],
    ['sanctions', 'kind', SANCTION_KINDS],
    ['mod_actions', 'action', MOD_ACTIONS],
    ['staff_notes', 'label', STAFF_NOTE_LABELS],
    ['shield_phrases', 'action', SHIELD_ACTIONS],
    ['member_reports', 'reason', MEMBER_REPORT_REASONS],
    ['member_reports', 'status', ['open', ...MEMBER_REPORT_OUTCOMES]],
    ['support_tickets', 'kind', TICKET_KINDS],
    ['support_tickets', 'status', TICKET_STATUSES],
    ['coa_documents', 'scope', COA_SCOPES],
    ['coa_documents', 'method', COA_METHODS],
    ['coa_documents', 'status', COA_STATUSES],
    ['vendors', 'status', PRICE_VENDOR_STATUSES],
    ['offers', 'availability', PRICE_AVAILABILITIES],
  ])('%s.%s', async (table, column, values) => {
    expect(await checkValues(table, column)).toEqual([...values].sort());
  });

  it('rating reason tags match private.rating_reasons_valid', async () => {
    for (const value of RATING_VALUES) {
      for (const reason of RATING_REASONS[value]) {
        const { ok } = await db.sqlOne<{ ok: boolean }>(`select private.rating_reasons_valid($1, array[$2]) as ok`, [value, reason]);
        expect(ok, `${value}/${reason}`).toBe(true);
      }
    }
    const { ok } = await db.sqlOne<{ ok: boolean }>(`select private.rating_reasons_valid('helpful', array['opinion']) as ok`);
    expect(ok).toBe(false);
  });
});

describe('inferSourceKind', () => {
  it.each([
    ['https://www.nejm.org/doi/10.1056/NEJMoa2032183', 'journal'],
    ['https://clinicaltrials.gov/study/NCT03548935', 'registry'],
    ['https://www.canada.ca/en/health-canada/services/drugs.html', 'gov'],
    ['https://www.cbc.ca/news/health/pharmacare', 'news'],
    ['https://peptide-vendor.example/blog', 'other'],
    ['not a url', 'other'],
    ['https://evilnejm.org/x', 'other'],
  ])('%s → %s', (url, kind) => {
    expect(inferSourceKind(url)).toBe(kind);
  });
});
