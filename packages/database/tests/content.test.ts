/**
 * Posting gates, votes and the karma ledger (community track).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TestDb, anon, user } from '../src/testing/index.ts';
import { TIER, createPost, ledgerTotal, vote } from './helpers.ts';

let db: TestDb;

beforeAll(async () => {
  db = await TestDb.create();
});

afterAll(async () => {
  await db.close();
});

describe('posting gates', () => {
  it('newcomers cannot post; members can post text but not links', async () => {
    const newcomer = await db.createUser();
    const error = await db.expectError(
      user(newcomer),
      `select public.create_post('on', 'basics', 'question', 'How do I read a trial registry?', 'Beginner here.')`,
    );
    expect(error).toMatchObject({ code: 'PF403', message: 'capability_denied', detail: 'post_text:tier:1' });

    const member = await db.createUser({ karma: TIER.member });
    await expect(createPost(db, member)).resolves.toMatch(/^[0-9a-f-]{36}$/);

    const linkError = await db.expectError(
      user(member),
      `select public.create_post('on', 'research', 'resource', 'A link to the primary source', '', 'https://clinicaltrials.gov/study/NCT03548935')`,
    );
    expect(linkError.detail).toBe('post_link:tier:2');

    const trusted = await db.createUser({ karma: TIER.trusted });
    await expect(
      createPost(db, trusted, { type: 'resource', body: '', link: 'https://clinicaltrials.gov/study/NCT03548935' }),
    ).resolves.toBeTruthy();
  });

  it('rejects javascript: and plain-http links', async () => {
    const trusted = await db.createUser({ karma: TIER.trusted });
    for (const link of ['javascript:alert(1)', 'http://insecure.example.com/x', 'https://']) {
      await expect(createPost(db, trusted, { type: 'resource', body: '', link })).rejects.toThrow();
    }
  });

  it('unconfirmed accounts cannot vote or comment', async () => {
    const author = await db.createUser({ karma: TIER.member });
    const post = await createPost(db, author);
    const unconfirmed = await db.createUser({ emailConfirmed: false });
    const error = await db.expectError(user(unconfirmed), `select public.cast_vote('post', $1, 1::smallint)`, [post]);
    expect(error.detail).toBe('vote:email_unconfirmed');
  });

  it('anonymous visitors cannot write', async () => {
    const error = await db.expectError(anon, `select public.create_comment(gen_random_uuid(), 'hello')`);
    expect(error.code).toBe('42501');
  });
});

describe('vote karma', () => {
  it('rejects self-votes', async () => {
    const author = await db.createUser({ karma: TIER.member });
    const post = await createPost(db, author);
    const error = await db.expectError(user(author), `select public.cast_vote('post', $1, 1::smallint)`, [post]);
    expect(error).toMatchObject({ code: 'PF422', message: 'self_vote' });
  });

  it('reconciles the author ledger as votes are cast, changed and removed', async () => {
    const author = await db.createUser({ karma: TIER.member });
    const voter = await db.createUser({ ageDays: 60 });
    const post = await createPost(db, author);
    const before = (await db.profile(author)).karma as number;

    await vote(db, voter, 'post', post, 1);
    expect((await db.profile(author)).karma).toBe(before + 1);
    await vote(db, voter, 'post', post, -1);
    expect((await db.profile(author)).karma).toBe(before - 1);
    await vote(db, voter, 'post', post, 0);
    expect((await db.profile(author)).karma).toBe(before);

    // Every change is an auditable ledger row; the total always matches the cache.
    expect(await ledgerTotal(db, author, 'karma', 'post_votes')).toBe(0);
    const rows = await db.sql(`select delta from public.ledger_events where event_key = $1 order by id`, [`post_votes:${post}`]);
    expect(rows.map((r) => Number(r.delta))).toEqual([1, -2, 1]);
  });

  it('votes from accounts younger than 7 days change the score but not karma', async () => {
    const author = await db.createUser({ karma: TIER.member });
    const fresh = await db.createUser({ ageDays: 2 });
    const post = await createPost(db, author);
    const before = (await db.profile(author)).karma;

    const { r } = await vote(db, fresh, 'post', post, 1);
    expect(r.score).toBe(1);
    expect((await db.profile(author)).karma).toBe(before);
  });

  it('floors the karma cost of a single post at -5', async () => {
    const author = await db.createUser({ karma: TIER.member });
    const post = await createPost(db, author);
    for (let i = 0; i < 8; i++) {
      await vote(db, await db.createUser({ ageDays: 60 }), 'post', post, -1);
    }
    expect((await db.sqlOne(`select score from public.posts where id = $1`, [post])).score).toBe(-8);
    expect(await ledgerTotal(db, author, 'karma', 'post_votes')).toBe(-5);
  });

  it('caps how much one voter can move one author in 30 days', async () => {
    const author = await db.createUser({ karma: TIER.member });
    const fan = await db.createUser({ ageDays: 60 });
    const posts = [];
    for (let i = 0; i < 7; i++) posts.push(await createPost(db, author, { title: `Post number ${i} from the author` }));
    for (const post of posts) await vote(db, fan, 'post', post, 1);

    expect(await ledgerTotal(db, author, 'karma', 'post_votes')).toBe(5);
    const counted = await db.sql(`select count(*)::int as n from public.post_votes where voter_id = $1 and counts_for_karma`, [fan]);
    expect(counted[0]?.n).toBe(5);
  });
});

describe('tiers', () => {
  it('promote at the threshold and demote only below 90% of it (hysteresis)', async () => {
    const id = await db.createUser();
    await db.giveKarma(id, 1000);
    expect((await db.profile(id)).tier).toBe(2);

    await db.giveKarma(id, -60); // 940: above 900, stays Trusted
    expect((await db.profile(id)).tier).toBe(2);

    await db.giveKarma(id, -50); // 890: below 900, back to Member
    expect((await db.profile(id)).tier).toBe(1);

    await db.giveKarma(id, 110); // 1000 again
    expect((await db.profile(id)).tier).toBe(2);
  });
});

describe('comments and editing', () => {
  it('threads comments and limits depth', async () => {
    const author = await db.createUser({ karma: TIER.member });
    const commenter = await db.createUser();
    const post = await createPost(db, author);

    let parent: string | null = null;
    for (let depth = 0; depth <= 6; depth++) {
      const row: { id: string } = await db.asOne(user(commenter), `select public.create_comment($1, $2, $3) as id`, [post, `depth ${depth}`, parent]);
      parent = row.id;
    }
    const error = await db.expectError(user(commenter), `select public.create_comment($1, 'too deep', $2)`, [post, parent]);
    expect(error.message).toBe('thread_too_deep');
    expect((await db.sqlOne(`select comment_count from public.posts where id = $1`, [post])).comment_count).toBe(7);
  });

  it('edits create revisions and only the author can edit', async () => {
    const author = await db.createUser({ karma: TIER.member });
    const other = await db.createUser({ karma: TIER.member });
    const post = await createPost(db, author);

    await db.as(user(author), `select public.edit_post($1, 'An updated and clearer title', 'New body')`, [post]);
    const revisions = await db.sql(`select revision, title from public.post_revisions where post_id = $1 order by revision`, [post]);
    expect(revisions).toEqual([
      { revision: 1, title: 'A sufficiently descriptive title' },
      { revision: 2, title: 'An updated and clearer title' },
    ]);

    const error = await db.expectError(user(other), `select public.edit_post($1, 'Hijacked title here', 'x')`, [post]);
    expect(error.code).toBe('PF404');
  });

  it('deleted posts disappear from public reads but keep their row', async () => {
    const author = await db.createUser({ karma: TIER.member });
    const post = await createPost(db, author);
    await db.as(user(author), `select public.delete_own_post($1)`, [post]);

    expect(await db.as(anon, `select id from public.posts where id = $1`, [post])).toEqual([]);
    expect(await db.as(anon, `select id from public.get_feed() where id = $1`, [post])).toEqual([]);
    expect((await db.sqlOne(`select status from public.posts where id = $1`, [post])).status).toBe('deleted');
  });
});

describe('rate limits', () => {
  it('are enforced inside the RPC, per user and action', async () => {
    await db.setConfig('rate_limit.comment', { limit: 2, window_seconds: 3600 });
    const author = await db.createUser({ karma: TIER.member });
    const post = await createPost(db, author);
    const chatty = await db.createUser();
    await db.as(user(chatty), `select public.create_comment($1, 'one')`, [post]);
    await db.as(user(chatty), `select public.create_comment($1, 'two')`, [post]);
    const error = await db.expectError(user(chatty), `select public.create_comment($1, 'three')`, [post]);
    expect(error).toMatchObject({ code: 'PF429', message: 'rate_limited', detail: 'comment' });

    // Other members are unaffected.
    await db.as(user(await db.createUser()), `select public.create_comment($1, 'hello')`, [post]);
    await db.setConfig('rate_limit.comment', { limit: 60, window_seconds: 3600 });
  });
});
