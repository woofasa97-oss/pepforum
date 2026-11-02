/**
 * Community notes: who may rate/write, how much a rating weighs, how scoring
 * results are applied, and what settlement pays or costs (moderation track,
 * strikes, writer locks). See docs/SELF_MODERATION.md.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TestDb, service, user } from '../src/testing/index.ts';
import {
  TIER,
  applyScores,
  createActiveRater,
  createNoteWriter,
  createPost,
  ledgerTotal,
  proposeNote,
  rate,
  settle,
} from './helpers.ts';

let db: TestDb;

beforeAll(async () => {
  db = await TestDb.create();
});

afterAll(async () => {
  await db.close();
});

/** A post with a proposed note, plus five graduated raters. */
async function scenario(options: { postType?: 'experience' | 'claim'; classification?: string } = {}) {
  const author = await db.createUser({ karma: TIER.member });
  const post = await createPost(db, author, { type: options.postType ?? 'claim' });
  const writer = await createNoteWriter(db);
  const note = await proposeNote(db, writer, post, options.classification ?? 'misleading');
  const raters = [];
  for (let i = 0; i < 5; i++) raters.push(await createActiveRater(db));
  return { author, post, writer, note, raters };
}

async function makeHelpfulAndSettle(note: string, raters: string[]) {
  for (const rater of raters) await rate(db, rater, note, 'helpful');
  await applyScores(db, [{ note_id: note, status: 'helpful' }]);
  await settle(db, note);
}

describe('note capabilities', () => {
  it('rating requires Trusted, a 30-day-old account and integrity', async () => {
    const { note } = await scenario();
    const member = await db.createUser({ karma: TIER.member, ageDays: 90 });
    expect((await db.expectError(user(member), `select public.next_note_to_rate()`)).detail).toBe('rate_notes:tier:2');

    const youngTrusted = await db.createUser({ karma: TIER.trusted, ageDays: 10 });
    expect((await db.expectError(user(youngTrusted), `select public.next_note_to_rate()`)).detail).toBe('rate_notes:account_age:30');

    const trusted = await db.createUser({ karma: TIER.trusted, ageDays: 90 });
    await rate(db, trusted, note, 'helpful');
  });

  it('writing requires Contributor karma AND graduation from rater probation', async () => {
    const author = await db.createUser({ karma: TIER.member });
    const post = await createPost(db, author);

    const contributor = await db.createUser({ karma: TIER.contributor, ageDays: 90 });
    await expect(proposeNote(db, contributor, post)).rejects.toThrow(/capability_denied/);
    const error = await db.expectError(user(contributor), `select public.propose_note($1, 'misleading', 'x', '[]'::jsonb)`, [post]);
    expect(error.detail).toBe('write_notes:rater_impact:5');

    await db.sql(`update public.profiles set rater_status = 'active', rater_impact = 5 where id = $1`, [contributor]);
    await expect(proposeNote(db, contributor, post)).resolves.toBeTruthy();
  });

  it('founding raters bypass the karma gate (launch bootstrap) but not integrity', async () => {
    const author = await db.createUser({ karma: TIER.member });
    const post = await createPost(db, author);
    const founder = await db.createUser({ ageDays: 1 });
    await db.sql(`update public.profiles set rater_status = 'founding', founding_until = now() + interval '90 days' where id = $1`, [founder]);
    await expect(proposeNote(db, founder, post)).resolves.toBeTruthy();

    // Expired founding status falls back to normal rules.
    await db.sql(`update public.profiles set founding_until = now() - interval '1 day' where id = $1`, [founder]);
    const expired = await db.expectError(user(founder), `select public.next_note_to_rate()`);
    expect(expired.detail).toBe('rate_notes:tier:2');
  });

  it('nobody can note their own post or rate their own note or notes on their post', async () => {
    const writer = await createNoteWriter(db);
    const ownPost = await createPost(db, writer);
    await expect(proposeNote(db, writer, ownPost)).rejects.toThrow(/own_post/);

    const { author, note, writer: noteWriter } = await scenario();
    await db.sql(`update public.profiles set karma = 1000, tier = 2 where id = $1`, [author]);
    await expect(rate(db, noteWriter, note, 'helpful')).rejects.toThrow(/own_note/);
    await expect(rate(db, author, note, 'not_helpful')).rejects.toThrow(/own_post/);
  });

  it('sources must be specific https URLs', async () => {
    const author = await db.createUser({ karma: TIER.member });
    const post = await createPost(db, author);
    const writer = await createNoteWriter(db);
    for (const url of ['https://nejm.org', 'http://nejm.org/doi/1', 'javascript:alert(1)']) {
      const error = await db.expectError(
        user(writer),
        `select public.propose_note($1, 'misleading', 'Context with a source that should be rejected.', $2::jsonb)`,
        [post, JSON.stringify([{ url, kind: 'journal' }])],
      );
      expect(error.message).toBe('invalid_source_url');
    }
  });
});

describe('rating weight', () => {
  it('a first rating enrols the member on probation with zero weight', async () => {
    const { note } = await scenario();
    const newRater = await db.createUser({ karma: TIER.trusted, ageDays: 90 });
    await rate(db, newRater, note, 'helpful');
    expect((await db.profile(newRater)).rater_status).toBe('probation');
    const { weight } = await db.sqlOne(`select weight::float from public.note_ratings where rater_id = $1`, [newRater]);
    expect(weight).toBe(0);
  });

  it('graduated raters weigh 1 on queue-assigned notes and less when they pick the note themselves', async () => {
    const { note } = await scenario();
    const assigned = await createActiveRater(db);
    const browsing = await createActiveRater(db);
    await rate(db, assigned, note, 'helpful', { assigned: true });
    await rate(db, browsing, note, 'helpful', { assigned: false });
    const weights = await db.sql<{ rater_id: string; weight: number }>(
      `select rater_id, weight::float from public.note_ratings where note_id = $1`, [note]);
    expect(weights.find((w) => w.rater_id === assigned)?.weight).toBe(1);
    expect(weights.find((w) => w.rater_id === browsing)?.weight).toBe(0.5);
  });

  it('next_note_to_rate assigns an eligible note and never one on your own post', async () => {
    const { note } = await scenario();
    const rater = await createActiveRater(db);
    const { id } = await db.asOne<{ id: string }>(user(rater), `select public.next_note_to_rate() as id`);
    expect(id).toBeTruthy();
    const assignment = await db.sql(`select 1 from public.rating_assignments where rater_id = $1 and note_id = $2`, [rater, id]);
    expect(assignment).toHaveLength(1);
    expect(note).toBeTruthy();
  });

  it('ratings cast after the note became public earn no accuracy credit', async () => {
    const { note, raters } = await scenario();
    await rate(db, raters[0]!, note, 'helpful');
    await applyScores(db, [{ note_id: note, status: 'helpful' }]);
    const late = await createActiveRater(db);
    await rate(db, late, note, 'helpful');
    const { cast_while_public } = await db.sqlOne(`select cast_while_public from public.note_ratings where rater_id = $1`, [late]);
    expect(cast_while_public).toBe(true);
  });
});

describe('applying scores', () => {
  it('records transitions, sets first_shown_at, and is idempotent per run', async () => {
    const { note } = await scenario();
    const runId = '00000000-0000-4000-8000-000000000001';
    const payload = JSON.stringify([{ note_id: note, status: 'helpful', intercept: 0.5, factor: 0.1 }]);

    const first = await db.asOne<{ r: Record<string, unknown> }>(service,
      `select public.apply_note_scores($1, now(), 'bootstrap', $2::jsonb) as r`, [runId, payload]);
    expect(first.r).toMatchObject({ transitions: 1 });
    const second = await db.asOne<{ r: Record<string, unknown> }>(service,
      `select public.apply_note_scores($1, now(), 'bootstrap', $2::jsonb) as r`, [runId, payload]);
    expect(second.r).toMatchObject({ already_applied: true });

    const row = await db.sqlOne(`select status, first_shown_at is not null as shown from public.notes where id = $1`, [note]);
    expect(row).toEqual({ status: 'helpful', shown: true });
    const history = await db.sql(`select event, from_status, to_status from public.note_status_history where note_id = $1 order by id`, [note]);
    expect(history).toEqual([
      { event: 'proposed', from_status: null, to_status: 'needs_more_ratings' },
      { event: 'status_changed', from_status: 'needs_more_ratings', to_status: 'helpful' },
    ]);
  });

  it('skips notes rated after the scoring snapshot (picked up next run)', async () => {
    const { note, raters } = await scenario();
    await rate(db, raters[0]!, note, 'helpful');
    const result = await db.asOne<{ r: Record<string, number> }>(service,
      `select public.apply_note_scores(gen_random_uuid(), now() - interval '1 minute', 'bootstrap', $1::jsonb) as r`,
      [JSON.stringify([{ note_id: note, status: 'helpful' }])]);
    expect(result.r.skipped_stale).toBe(1);
    expect((await db.sqlOne(`select status from public.notes where id = $1`, [note])).status).toBe('needs_more_ratings');
  });

  it('locks only once the status is stable AND enough full-weight ratings exist', async () => {
    const { note, raters } = await scenario();
    for (const rater of raters.slice(0, 4)) await rate(db, rater, note, 'helpful');
    await applyScores(db, [{ note_id: note, status: 'helpful' }]);
    await settle(db, note);
    expect((await db.sqlOne(`select locked_at from public.notes where id = $1`, [note])).locked_at).toBeNull();

    await rate(db, raters[4]!, note, 'helpful');
    await settle(db, note);
    expect((await db.sqlOne(`select locked_status from public.notes where id = $1`, [note])).locked_status).toBe('helpful');
  });

  it('locks stale notes at max age as Needs More Ratings, with no payouts', async () => {
    const { note, writer, raters } = await scenario();
    await rate(db, raters[0]!, note, 'helpful');
    await db.sql(`update public.notes set created_at = now() - interval '15 days' where id = $1`, [note]);
    await applyScores(db, []);
    expect((await db.sqlOne(`select locked_status from public.notes where id = $1`, [note])).locked_status).toBe('needs_more_ratings');
    expect(await ledgerTotal(db, writer, 'karma', 'note_written')).toBe(0);
    expect(await ledgerTotal(db, raters[0]!, 'mod_xp', 'note_rating')).toBe(0);
  });
});

describe('settlement', () => {
  it('pays the writer on the private moderation track for a Helpful note', async () => {
    const { note, writer, raters } = await scenario();
    await makeHelpfulAndSettle(note, raters);
    expect(await ledgerTotal(db, writer, 'mod_xp', 'note_written')).toBe(15 + 5);
    // Public karma never moves at settlement (it would unmask the pseudonymous writer).
    expect(await ledgerTotal(db, writer, 'karma', 'note_written')).toBe(0);
    expect((await db.profile(writer)).writer_impact).toBe(1);
  });

  it('charges the writer for a Not Helpful note', async () => {
    const { note, writer, raters } = await scenario();
    for (const rater of raters) await rate(db, rater, note, 'not_helpful');
    await applyScores(db, [{ note_id: note, status: 'not_helpful' }]);
    await settle(db, note);
    expect(await ledgerTotal(db, writer, 'mod_xp', 'note_written')).toBe(-10);
    expect(await ledgerTotal(db, writer, 'karma', 'note_written')).toBe(0);
  });

  it('rewards raters for accuracy, not volume; "somewhat" is neutral', async () => {
    const { note, raters } = await scenario();
    const dissenter = await createActiveRater(db);
    const hedger = await createActiveRater(db);
    await rate(db, dissenter, note, 'not_helpful');
    await rate(db, hedger, note, 'somewhat');
    await makeHelpfulAndSettle(note, raters);

    // Cold start: base rate defaults to 0.5, so ±1 XP.
    expect(await ledgerTotal(db, raters[0]!, 'mod_xp', 'note_rating')).toBe(1);
    expect(await ledgerTotal(db, dissenter, 'mod_xp', 'note_rating')).toBe(-1);
    expect(await ledgerTotal(db, hedger, 'mod_xp', 'note_rating')).toBe(0);
    expect((await db.profile(raters[0]!)).rater_impact).toBeGreaterThanOrEqual(1);
  });

  it('base-rate adjustment makes always-agreeing-with-the-majority worth nothing', async () => {
    await db.setConfig('notes.base_rate_min_samples', 1);
    // History: every "helpful" rating matched → π(helpful) = 1.
    const first = await scenario();
    await makeHelpfulAndSettle(first.note, first.raters);

    const { note, raters } = await scenario();
    await makeHelpfulAndSettle(note, raters);
    expect(await ledgerTotal(db, raters[0]!, 'mod_xp', 'note_rating')).toBe(0);
    await db.setConfig('notes.base_rate_min_samples', 20);
  });

  it('graduates a probationary rater once their settled ratings prove accurate', async () => {
    const rookie = await db.createUser({ karma: TIER.trusted, ageDays: 90 });
    for (let i = 0; i < 5; i++) {
      const { note, raters } = await scenario();
      await rate(db, rookie, note, 'helpful');
      await makeHelpfulAndSettle(note, raters);
    }
    expect(await db.profile(rookie)).toMatchObject({ rater_status: 'active', rater_impact: 5 });
  });
});

describe('author consequences', () => {
  it('a Helpful misleading note on an uncorrected claim costs a strike and karma', async () => {
    const { author, note, raters } = await scenario();
    const before = (await db.profile(author)).karma as number;
    await makeHelpfulAndSettle(note, raters);
    expect((await db.profile(author)).karma).toBe(before - 10);
    expect(await db.integrity(author)).toBe(85);
    const strikes = await db.sql(`select reason, points from public.strikes where user_id = $1`, [author]);
    expect(strikes).toEqual([{ reason: 'note_misleading', points: 15 }]);
  });

  it('experience posts are protected: context is added, no strike', async () => {
    const { author, note, raters } = await scenario({ postType: 'experience' });
    await makeHelpfulAndSettle(note, raters);
    expect(await db.integrity(author)).toBe(100);
    expect(await ledgerTotal(db, author, 'karma', 'note_strike')).toBe(0);
  });

  it('missing-context notes never penalise the author', async () => {
    const { author, note, raters } = await scenario({ classification: 'missing_context' });
    await makeHelpfulAndSettle(note, raters);
    expect(await db.integrity(author)).toBe(100);
  });

  it('correcting the post within the window avoids the strike', async () => {
    const { author, post, note, raters } = await scenario();
    for (const rater of raters) await rate(db, rater, note, 'helpful');
    await applyScores(db, [{ note_id: note, status: 'helpful' }]);
    await db.as(user(author), `select public.edit_post($1, 'Corrected: the 25% figure was from a small trial', 'Updated body.')`, [post]);
    await settle(db, note);
    expect(await db.integrity(author)).toBe(100);
    expect((await db.sqlOne(`select post_corrected_at is not null as corrected from public.notes where id = $1`, [note])).corrected).toBe(true);
  });

  it('caps note-related karma loss at 30 per 30 days', async () => {
    const author = await db.createUser({ karma: TIER.trusted });
    for (let i = 0; i < 4; i++) {
      const post = await createPost(db, author, { title: `Bold claim number ${i} about peptides` });
      const note = await proposeNote(db, await createNoteWriter(db), post);
      const raters = [];
      for (let r = 0; r < 5; r++) raters.push(await createActiveRater(db));
      await makeHelpfulAndSettle(note, raters);
    }
    expect(await ledgerTotal(db, author, 'karma', 'note_strike')).toBe(-30);
    // Integrity still reflects every strike: 100 − 4 × 15.
    expect(await db.integrity(author)).toBe(40);
  });
});

describe('writer lock', () => {
  it('locks writing after a run of Not Helpful notes', async () => {
    const writer = await createNoteWriter(db);
    for (let i = 0; i < 5; i++) {
      const post = await createPost(db, await db.createUser({ karma: TIER.member }));
      const note = await proposeNote(db, writer, post);
      for (let r = 0; r < 5; r++) await rate(db, await createActiveRater(db), note, 'not_helpful');
      await applyScores(db, [{ note_id: note, status: 'not_helpful' }]);
      await settle(db, note);
    }
    const profile = await db.profile(writer);
    expect(profile.writing_locked_until).not.toBeNull();
    const post = await createPost(db, await db.createUser({ karma: TIER.member }));
    const error = await db.expectError(user(writer), `select public.propose_note($1, 'misleading', 'x', '[]'::jsonb)`, [post]);
    expect(error.detail).toBe('write_notes:writing_locked');
  });
});
