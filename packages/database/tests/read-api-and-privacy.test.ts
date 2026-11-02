/**
 * What the read API reveals to whom, and the privacy rights (export, erasure).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TestDb, anon, user } from '../src/testing/index.ts';
import { TIER, applyScores, createActiveRater, createNoteWriter, createPost, proposeNote, rate, settle } from './helpers.ts';

let db: TestDb;

beforeAll(async () => {
  db = await TestDb.create();
});

afterAll(async () => {
  await db.close();
});

interface NoteJson {
  id: string;
  status: string;
  author_alias: string;
  breakdown: Record<string, number> | null;
  is_mine: boolean;
  [key: string]: unknown;
}

describe('note projection', () => {
  it('never exposes the writer identity, only a stable alias', async () => {
    const author = await db.createUser({ karma: TIER.member });
    const post = await createPost(db, author);
    const writer = await createNoteWriter(db);
    const note = await proposeNote(db, writer, post);

    const viewer = await db.createUser();
    const { notes } = await db.asOne<{ notes: NoteJson[] }>(user(viewer), `select public.get_post_notes($1) as notes`, [post]);
    expect(notes).toHaveLength(1);
    expect(JSON.stringify(notes)).not.toContain(writer);
    expect(notes[0]?.author_alias).toMatch(/^Contributor [0-9A-F]{4}$/);

    const second = await proposeNote(db, writer, await createPost(db, author, { title: 'A second post by the author' }));
    const { note: other } = await db.asOne<{ note: NoteJson }>(user(viewer), `select public.get_note($1) as note`, [second]);
    expect(other.author_alias).toBe(notes[0]?.author_alias);
    expect(note).toBeTruthy();
  });

  it('hides the rating breakdown until the note locks (no herding)', async () => {
    const author = await db.createUser({ karma: TIER.member });
    const post = await createPost(db, author);
    const note = await proposeNote(db, await createNoteWriter(db), post);
    const raters = [];
    for (let i = 0; i < 5; i++) raters.push(await createActiveRater(db));
    for (const r of raters) await rate(db, r, note, 'helpful');
    await applyScores(db, [{ note_id: note, status: 'helpful' }]);

    const viewer = await db.createUser();
    const open = await db.asOne<{ note: NoteJson }>(user(viewer), `select public.get_note($1) as note`, [note]);
    expect(open.note.breakdown).toBeNull();
    expect(open.note.rating_count).toBe(5);

    await settle(db, note);
    const locked = await db.asOne<{ note: NoteJson }>(user(viewer), `select public.get_note($1) as note`, [note]);
    expect(locked.note.breakdown).toEqual({ helpful: 5, somewhat: 0, not_helpful: 0 });
  });

  it('shows anonymous visitors only Helpful notes', async () => {
    const author = await db.createUser({ karma: TIER.member });
    const post = await createPost(db, author);
    await proposeNote(db, await createNoteWriter(db), post);
    const { notes } = await db.asOne<{ notes: NoteJson[] }>(anon, `select public.get_post_notes($1) as notes`, [post]);
    expect(notes).toEqual([]);
  });

  it("raw ratings are private: you can read only your own", async () => {
    const author = await db.createUser({ karma: TIER.member });
    const post = await createPost(db, author);
    const note = await proposeNote(db, await createNoteWriter(db), post);
    const a = await createActiveRater(db);
    const b = await createActiveRater(db);
    await rate(db, a, note, 'helpful');
    await rate(db, b, note, 'not_helpful');
    const visible = await db.as(user(a), `select rater_id from public.note_ratings where note_id = $1`, [note]);
    expect(visible).toEqual([{ rater_id: a }]);
  });
});

describe('content masking', () => {
  it('masks moderator-removed comments for everyone but the author and moderators', async () => {
    const author = await db.createUser({ karma: TIER.member });
    const post = await createPost(db, author);
    const commenter = await db.createUser();
    const { id: comment } = await db.asOne<{ id: string }>(user(commenter), `select public.create_comment($1, 'DM me for a source') as id`, [post]);
    await db.sql(`update public.comments set status = 'removed' where id = $1`, [comment]);

    const asStranger = await db.as<{ body: string }>(anon, `select body from public.get_comments($1)`, [post]);
    expect(asStranger).toEqual([{ body: '[removed by a moderator]' }]);
    const asAuthor = await db.as<{ body: string }>(user(commenter), `select body from public.get_comments($1)`, [post]);
    expect(asAuthor).toEqual([{ body: 'DM me for a source' }]);
  });

  it('feeds exclude removed and deleted posts and report the caller’s vote', async () => {
    const author = await db.createUser({ karma: TIER.member });
    const visible = await createPost(db, author, { title: 'Visible post for the feed test' });
    const removed = await createPost(db, author, { title: 'Removed post for the feed test' });
    await db.sql(`update public.posts set status = 'removed' where id = $1`, [removed]);
    const voter = await db.createUser({ ageDays: 30 });
    await db.as(user(voter), `select public.cast_vote('post', $1, 1::smallint)`, [visible]);

    const rows = await db.as<{ id: string; my_vote: number | null }>(user(voter),
      `select id, my_vote from public.get_feed(p_author_username => (select username from public.profiles where id = $1))`, [author]);
    expect(rows).toEqual([{ id: visible, my_vote: 1 }]);
  });
});

describe('privacy rights', () => {
  it('export_my_data returns everything held about the caller and nobody else', async () => {
    const me = await db.createUser({ karma: TIER.member });
    await createPost(db, me);
    const exported = await db.asOne<{ data: Record<string, unknown[]> & { account: { email: string } } }>(
      user(me), `select public.export_my_data() as data`);
    expect(exported.data.account.email).toMatch(/@example\.test$/);
    expect(exported.data.posts).toHaveLength(1);
    expect(exported.data.ledger?.length).toBeGreaterThan(0);
  });

  it('account deletion tombstones the profile but keeps the ledger consistent', async () => {
    const me = await db.createUser({ karma: TIER.member, username: 'leaving_soon' });
    const post = await createPost(db, me);
    await db.sql(`update public.profiles set bio = 'my bio' where id = $1`, [me]);

    await db.as(user(me), `select public.request_account_deletion(true)`);
    const profile = await db.profile(me);
    expect(profile.username).toMatch(/^deleted_[0-9a-f]{10}$/);
    expect(profile).toMatchObject({ bio: '', deleted_at: expect.any(Date) });
    expect((await db.sqlOne(`select title, status from public.posts where id = $1`, [post]))).toEqual({ title: '[deleted post]', status: 'deleted' });
    expect((await db.sqlOne(`select count(*)::int as n from public.account_deletions where user_id = $1`, [me])).n).toBe(1);

    // The deleted member can no longer act.
    const error = await db.expectError(user(me), `select public.create_comment($1, 'still here?')`, [post]);
    expect(error.detail).toBe('comment:no_profile');
  });

  it('deleting the auth user directly also tombstones the profile', async () => {
    const me = await db.createUser({ username: 'dashboard_delete' });
    await db.sql(`delete from auth.users where id = $1`, [me]);
    expect((await db.profile(me)).username).toMatch(/^deleted_/);
  });
});
