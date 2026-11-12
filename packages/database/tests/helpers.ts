/**
 * Domain-level fixtures shared by the database test suites. Everything goes
 * through the public RPCs as the acting user, exactly like the web app.
 */
import { type TestDb, service, user } from '../src/testing/index.ts';

export const TIER = { newcomer: 0, member: 100, trusted: 1000, contributor: 3000, steward: 10000 } as const;

export interface PostOptions {
  readonly category?: string;
  readonly type?: 'experience' | 'claim' | 'question' | 'resource';
  readonly title?: string;
  readonly body?: string;
  readonly link?: string | null;
}

export async function createPost(db: TestDb, author: string, options: PostOptions = {}): Promise<string> {
  const { id } = await db.asOne<{ id: string }>(
    user(author),
    `select public.create_post($1, $2, $3, $4, $5) as id`,
    [
      options.category ?? 'basics',
      options.type ?? 'claim',
      options.title ?? 'A sufficiently descriptive title',
      options.body ?? 'Body text describing the claim.',
      options.link ?? null,
    ],
  );
  return id;
}

export async function vote(db: TestDb, voter: string, kind: 'post' | 'comment', target: string, value: -1 | 0 | 1) {
  return db.asOne<{ r: { score: number } }>(
    user(voter),
    `select public.cast_vote($1, $2, $3::smallint) as r`,
    [kind, target, value],
  );
}

/** A member who has graduated as a rater (ratings carry full weight). */
export async function createActiveRater(db: TestDb, karma: number = TIER.trusted): Promise<string> {
  const id = await db.createUser({ karma, ageDays: 90 });
  await db.sql(`update public.profiles set rater_status = 'active', rater_impact = 5 where id = $1`, [id]);
  return id;
}

/** A Contributor who has graduated as a rater, i.e. may write notes. */
export async function createNoteWriter(db: TestDb): Promise<string> {
  return createActiveRater(db, TIER.contributor);
}

export async function proposeNote(
  db: TestDb,
  writer: string,
  postId: string,
  classification: string = 'misleading',
  body: string = 'The figure comes from a small open-label trial; larger RCTs report ~15%.',
): Promise<string> {
  const { id } = await db.asOne<{ id: string }>(
    user(writer),
    `select public.propose_note($1, $2, $3, $4::jsonb) as id`,
    [postId, classification, body, JSON.stringify([{ url: 'https://www.nejm.org/doi/10.1056/NEJMoa2032183', kind: 'journal' }])],
  );
  return id;
}

export async function rate(
  db: TestDb,
  rater: string,
  noteId: string,
  value: 'helpful' | 'somewhat' | 'not_helpful',
  options: { assigned?: boolean } = {},
): Promise<void> {
  if (options.assigned ?? true) {
    await db.sql(`insert into public.rating_assignments (rater_id, note_id) values ($1, $2) on conflict do nothing`, [rater, noteId]);
  }
  const reasons = { helpful: ['cites_sources'], somewhat: ['partial'], not_helpful: ['opinion'] }[value];
  await db.as(user(rater), `select public.rate_note($1, $2, $3::text[])`, [noteId, value, reasons]);
}

/** Applies scoring results as the worker would, then backdates and re-runs to trigger locking. */
export async function applyScores(db: TestDb, results: Array<{ note_id: string; status: string }>) {
  return db.asOne<{ r: Record<string, number> }>(
    service,
    `select public.apply_note_scores(gen_random_uuid(), now(), 'bootstrap', $1::jsonb) as r`,
    [JSON.stringify(results)],
  );
}

/** Makes a note's current status old enough to lock, then runs scoring once more. */
export async function settle(db: TestDb, noteId: string): Promise<void> {
  await db.sql(`update public.notes set status_since = now() - interval '73 hours' where id = $1`, [noteId]);
  await applyScores(db, []);
}

export async function ledgerTotal(db: TestDb, userId: string, track: 'karma' | 'mod_xp', reason?: string): Promise<number> {
  const { total } = await db.sqlOne<{ total: string }>(
    `select coalesce(sum(delta), 0)::text as total from public.ledger_events
     where user_id = $1 and track = $2 and ($3::text is null or reason = $3)`,
    [userId, track, reason ?? null],
  );
  return Number(total);
}
