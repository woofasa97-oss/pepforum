/**
 * Regression tests for the independent security review (2026-11-02). Each
 * test reproduces a finding's exploit and asserts it no longer works. See
 * docs/THREAT_MODEL.md § "Security review log".
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TestDb, anon, user } from '../src/testing/index.ts';
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

async function createModerator(): Promise<string> {
  const id = await db.createUser({ karma: TIER.contributor });
  await db.sql(`insert into public.moderators (user_id) values ($1)`, [id]);
  return id;
}

async function helpfulSettledNote(classification = 'missing_context') {
  const author = await db.createUser({ karma: TIER.member });
  const post = await createPost(db, author);
  const writer = await createNoteWriter(db);
  const note = await proposeNote(db, writer, post, classification);
  const raters = [];
  for (let i = 0; i < 5; i++) raters.push(await createActiveRater(db));
  for (const r of raters) await rate(db, r, note, 'helpful');
  await applyScores(db, [{ note_id: note, status: 'helpful' }]);
  return { author, post, writer, note, raters };
}

describe('#1 note writers and raters cannot be unmasked by diffing profiles', () => {
  it('moderation-track columns are not readable by API roles', async () => {
    await db.createUser();
    for (const column of ['mod_xp', 'writer_impact', 'rater_impact', 'rater_status', 'founding_until', 'writing_locked_until', 'updated_at']) {
      expect((await db.expectError(anon, `select ${column} from public.profiles limit 1`)).code, column).toBe('42501');
    }
    const rows = await db.as(anon, `select username, karma, tier from public.profiles limit 1`);
    expect(rows.length).toBe(1);
  });

  it('get_profile shows moderation numbers only to the owner', async () => {
    const owner = await db.createUser({ username: 'private_stats' });
    const stranger = await db.createUser();
    const asStranger = await db.asOne<{ p: Record<string, unknown> }>(user(stranger), `select public.get_profile('private_stats') as p`);
    expect(asStranger.p).toMatchObject({ mod_xp: null, writer_impact: null, rater_impact: null, rater_status: null });
    const asOwner = await db.asOne<{ p: Record<string, unknown> }>(user(owner), `select public.get_profile('private_stats') as p`);
    expect(asOwner.p.mod_xp).not.toBeNull();
  });

  it('settling a note never changes the writer’s public karma', async () => {
    const { writer, note } = await helpfulSettledNote();
    const before = (await db.profile(writer)).karma;
    await settle(db, note);
    expect((await db.profile(writer)).karma).toBe(before);
    expect(await ledgerTotal(db, writer, 'mod_xp', 'note_written')).toBe(15 + 5);
  });
});

describe('#3 staff reads require an MFA session', () => {
  it('a moderator with only a password (aal1) cannot read authorship, ledgers or breakdowns', async () => {
    const { note, writer } = await helpfulSettledNote();
    const mod = await createModerator();

    expect(await db.as(user(mod, 'aal1'), `select author_id from public.notes where id = $1`, [note])).toEqual([]);
    expect(await db.as(user(mod, 'aal1'), `select id from public.ledger_events where user_id = $1`, [writer])).toEqual([]);
    const { n } = await db.asOne<{ n: { breakdown: unknown } }>(user(mod, 'aal1'), `select public.get_note($1) as n`, [note]);
    expect(n.breakdown).toBeNull();

    const withMfa = await db.as(user(mod, 'aal2'), `select author_id from public.notes where id = $1`, [note]);
    expect(withMfa).toEqual([{ author_id: writer }]);
  });
});

describe('#4 the rating queue cannot be re-rolled to pick a brigade target', () => {
  it('returns the same outstanding assignment until it is rated', async () => {
    for (let i = 0; i < 4; i++) {
      const author = await db.createUser({ karma: TIER.member });
      await proposeNote(db, await createNoteWriter(db), await createPost(db, author, { title: `Queue test post number ${i}` }));
    }
    const rater = await createActiveRater(db);
    const first = await db.asOne<{ id: string }>(user(rater), `select public.next_note_to_rate() as id`);
    for (let i = 0; i < 20; i++) {
      const again = await db.asOne<{ id: string }>(user(rater), `select public.next_note_to_rate() as id`);
      expect(again.id).toBe(first.id);
    }
    const { n } = await db.sqlOne<{ n: number }>(`select count(*)::int as n from public.rating_assignments where rater_id = $1`, [rater]);
    expect(n).toBe(1);
  });
});

describe('#5 a no-op edit does not count as a correction', () => {
  it('rejects identical edits and still applies the strike', async () => {
    const { author, post, note } = await helpfulSettledNote('misleading');
    const { title, body } = await db.sqlOne<{ title: string; body: string }>(`select title, body from public.posts where id = $1`, [post]);
    const error = await db.expectError(user(author), `select public.edit_post($1, $2, $3)`, [post, title, body]);
    expect(error.message).toBe('no_changes');
    await settle(db, note);
    expect(await db.integrity(author)).toBe(85);
  });
});

describe('#6 sanctions cannot be lifted by the sanctioned or by unrelated moderators', () => {
  it('blocks self-revocation and revocation of another moderator’s freeze', async () => {
    const m1 = await createModerator();
    const m2 = await createModerator();
    const m3 = await createModerator();
    const { s: sanction } = await db.asOne<{ s: string }>(user(m2, 'aal2'), `select public.apply_sanction($1, 'freeze', 'Repeated sourcing hints', 7) as s`, [m1]);

    expect((await db.expectError(user(m1, 'aal2'), `select public.revoke_sanction($1, 'mine')`, [sanction])).message).toBe('conflict_of_interest');
    expect((await db.expectError(user(m3, 'aal2'), `select public.revoke_sanction($1, 'lift')`, [sanction])).message).toBe('not_allowed');
    await db.as(user(m2, 'aal2'), `select public.revoke_sanction($1, 'issued in error')`, [sanction]);
  });
});

describe('#7 a note always has sources', () => {
  it('rejects NULL sources', async () => {
    const post = await createPost(db, await db.createUser({ karma: TIER.member }));
    const writer = await createNoteWriter(db);
    const error = await db.expectError(user(writer), `select public.propose_note($1, 'missing_context', 'Context without any source at all here.', null)`, [post]);
    expect(error.message).toBe('sources_required');
  });
});

describe('#8 no accuracy credit after a status has been public', () => {
  it('ratings after a Helpful → Needs More Ratings flip count as public', async () => {
    const { note } = await helpfulSettledNote();
    await applyScores(db, [{ note_id: note, status: 'needs_more_ratings' }]);
    const late = await createActiveRater(db);
    await rate(db, late, note, 'helpful');
    const { cast_while_public } = await db.sqlOne(`select cast_while_public from public.note_ratings where rater_id = $1`, [late]);
    expect(cast_while_public).toBe(true);
  });
});

describe('#9 report XP cannot be self-paid and is reversed on appeal', () => {
  it('pays nothing for a moderator’s own report; reverses reporters on an upheld appeal', async () => {
    const author = await db.createUser({ karma: TIER.member });
    const post = await createPost(db, author);
    const mod = await createModerator();
    const member = await db.createUser({ ageDays: 60 });
    await db.as(user(mod), `select public.file_report('post', $1, 'spam')`, [post]);
    await db.as(user(member), `select public.file_report('post', $1, 'spam')`, [post]);
    await db.as(user(mod, 'aal2'), `select public.resolve_reports('post', $1, 'remove', 'spam', 'spam')`, [post]);
    expect(await ledgerTotal(db, mod, 'mod_xp', 'report_upheld')).toBe(0);
    expect(await ledgerTotal(db, member, 'mod_xp')).toBe(3);

    const { id: actionId } = await db.sqlOne<{ id: string }>(`select id from public.mod_actions where target_id = $1 and action = 'remove'`, [post]);
    const { id: appeal } = await db.asOne<{ id: string }>(user(author), `select public.submit_appeal($1, 'This was not spam at all, please review.') as id`, [actionId]);
    await db.as(user(await createModerator(), 'aal2'), `select public.decide_appeal($1, true, 'Not spam')`, [appeal]);
    expect(await ledgerTotal(db, member, 'mod_xp')).toBe(0);
  });
});

describe('#10 frozen members cannot edit posts', () => {
  it('blocks edits during a freeze', async () => {
    const author = await db.createUser({ karma: TIER.member });
    const post = await createPost(db, author);
    const mod = await createModerator();
    await db.as(user(mod, 'aal2'), `select public.apply_sanction($1, 'freeze', 'Cooling off period', 7)`, [author]);
    const error = await db.expectError(user(author), `select public.edit_post($1, 'Vendor details slipped into an old post', 'x')`, [post]);
    expect(error.detail).toBe('post_text:frozen');
  });
});

describe('#11 comments under a removed post are not readable', () => {
  it('hides them from direct selects', async () => {
    const author = await db.createUser({ karma: TIER.member });
    const post = await createPost(db, author);
    const { id: comment } = await db.asOne<{ id: string }>(user(await db.createUser()), `select public.create_comment($1, 'DM me for the vendor') as id`, [post]);
    await db.sql(`update public.posts set status = 'removed' where id = $1`, [post]);
    expect(await db.as(anon, `select id from public.comments where id = $1`, [comment])).toEqual([]);
    expect(await db.as(user(await db.createUser()), `select id from public.comments where id = $1`, [comment])).toEqual([]);
  });
});

describe('#12 sanctioned members cannot see which moderator acted', () => {
  it('withholds actor and issuer columns', async () => {
    const target = await db.createUser({ karma: TIER.member });
    const mod = await createModerator();
    await db.as(user(mod, 'aal2'), `select public.apply_sanction($1, 'warning', 'Please label personal experience')`, [target]);
    expect((await db.expectError(user(target), `select actor_id from public.mod_actions where target_user_id = $1`, [target])).code).toBe('42501');
    expect((await db.expectError(user(target), `select issued_by from public.sanctions where user_id = $1`, [target])).code).toBe('42501');
    const visible = await db.as(user(target), `select action, reason from public.mod_actions where target_user_id = $1`, [target]);
    expect(visible).toEqual([{ action: 'sanction', reason: 'Please label personal experience' }]);
  });
});
