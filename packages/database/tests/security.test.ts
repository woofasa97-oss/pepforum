/**
 * Structural security guarantees: migrations apply cleanly from zero, the
 * catalog audit is clean, and no API role can write state directly.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TestDb, anon, service, user } from '../src/testing/index.ts';

let db: TestDb;

beforeAll(async () => {
  db = await TestDb.create();
});

afterAll(async () => {
  await db.close();
});

describe('migrations', () => {
  it('apply cleanly and pass the security self-audit', async () => {
    const findings = await db.sql(`select * from private.security_audit()`);
    expect(findings).toEqual([]);
  });

  it('enable RLS on every application table', async () => {
    const tables = await db.sql<{ name: string }>(`
      select n.nspname || '.' || c.relname as name
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'r' and n.nspname in ('public', 'private') and not c.relrowsecurity`);
    expect(tables).toEqual([]);
  });
});

describe('direct table writes are impossible for API roles', () => {
  it.each([
    [`insert into public.ledger_events (user_id, track, delta, reason, source_kind, event_key) values (gen_random_uuid(), 'karma', 1000, 'hack', 'hack', 'x')`],
    [`insert into public.posts (author_id, category_id, post_type, title, body) values (gen_random_uuid(), 'basics', 'claim', 'injected title', 'x')`],
    [`update public.notes set status = 'helpful'`],
    [`insert into public.strikes (user_id, reason, points, source_kind, source_id, expires_at) values (gen_random_uuid(), 'sanction', 1, 'x', gen_random_uuid(), now())`],
    [`update public.app_config set value = '0' where key = 'notes.min_ratings'`],
    [`delete from public.mod_actions`],
  ])('authenticated cannot run: %s', async (statement) => {
    const id = await db.createUser();
    const error = await db.expectError(user(id), statement);
    expect(error.code).toBe('42501'); // insufficient_privilege
  });

  it('members can edit descriptive profile fields but not karma, tier or rater status', async () => {
    const id = await db.createUser();
    await db.as(user(id), `update public.profiles set bio = 'Toronto runner' where id = $1`, [id]);
    expect((await db.profile(id)).bio).toBe('Toronto runner');

    for (const column of ['karma = 99999', 'tier = 4', `rater_status = 'founding'`, 'mod_xp = 500', 'writing_locked_until = null']) {
      const error = await db.expectError(user(id), `update public.profiles set ${column} where id = $1`, [id]);
      expect(error.code).toBe('42501');
    }
  });

  it("members cannot edit someone else's profile", async () => {
    const me = await db.createUser();
    const other = await db.createUser();
    await db.as(user(me), `update public.profiles set bio = 'pwned' where id = $1`, [other]);
    expect((await db.profile(other)).bio).toBe('');
  });

  it('settlement and maintenance entry points are callable only by the worker (service_role)', async () => {
    const id = await db.createUser();
    for (const call of [
      `select public.apply_note_scores(gen_random_uuid(), now(), 'bootstrap', '[]'::jsonb)`,
      `select public.run_maintenance()`,
      `select public.expire_stale_collapses()`,
    ]) {
      expect((await db.expectError(user(id), call)).code).toBe('42501');
      expect((await db.expectError(anon, call)).code).toBe('42501');
    }
    const result = await db.asOne<{ r: { scored: number } }>(
      service,
      `select public.apply_note_scores(gen_random_uuid(), now(), 'bootstrap', '[]'::jsonb) as r`,
    );
    expect(result.r.scored).toBe(0);
  });

  it('private helpers that mint karma are not executable by API roles', async () => {
    const id = await db.createUser();
    const error = await db.expectError(
      user(id),
      `select private.reconcile('x', $1, 'karma', 'hack', 'hack', null, 100000)`,
      [id],
    );
    expect(error.code).toBe('42501');
  });
});

describe('append-only audit tables', () => {
  it('ledger rows cannot be updated or deleted, even by the owner', async () => {
    const id = await db.createUser({ karma: 50 });
    await expect(db.sql(`update public.ledger_events set delta = 1000000 where user_id = $1`, [id])).rejects.toThrow(/append_only/);
    await expect(db.sql(`delete from public.ledger_events where user_id = $1`, [id])).rejects.toThrow(/append_only/);
  });
});

describe('sign-up trigger', () => {
  it('rejects invalid and reserved usernames', async () => {
    await expect(db.createUser({ username: 'a b' })).rejects.toThrow(/invalid_username/);
    await expect(db.createUser({ username: 'admin_bob' })).rejects.toThrow(/reserved_username/);
  });

  it('ignores privilege-looking metadata', async () => {
    const { id } = await db.sqlOne<{ id: string }>(
      `insert into auth.users (email, email_confirmed_at, raw_user_meta_data)
       values ('meta@example.test', now(), '{"username":"meta_user","karma":99999,"tier":4,"rater_status":"founding"}')
       returning id`,
    );
    const profile = await db.profile(id);
    expect(profile).toMatchObject({ karma: 0, tier: 0, rater_status: 'none' });
  });

  it('username_available is case-insensitive and callable anonymously', async () => {
    await db.createUser({ username: 'Maple_You' });
    const taken = await db.asOne<{ ok: boolean }>(anon, `select public.username_available('maple_you') as ok`);
    const free = await db.asOne<{ ok: boolean }>(anon, `select public.username_available('brand_new_name') as ok`);
    expect(taken.ok).toBe(false);
    expect(free.ok).toBe(true);
  });
});
