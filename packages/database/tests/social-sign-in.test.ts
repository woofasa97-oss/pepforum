/**
 * Social sign-in (migration …014): OAuth sign-ups get a placeholder username
 * and can do nothing until they complete onboarding.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TestDb, anon, user } from '../src/testing/index.ts';
import { createPost } from './helpers.ts';

let db: TestDb;

beforeAll(async () => {
  db = await TestDb.create();
});

afterAll(async () => {
  await db.close();
});

const googleUser = (metadata: Record<string, string> = { full_name: 'Jane Q. Public', locale: 'fr-CA' }) =>
  db.createUser({ provider: 'google', providerMetadata: metadata });

const onboard = (id: string, username: string, adult: boolean | null = true) =>
  db.as(user(id), `select public.complete_onboarding($1, $2)`, [username, adult]);

describe('social sign-up', () => {
  it('creates a placeholder profile flagged for onboarding, ignoring the provider’s name', async () => {
    const id = await googleUser();
    const profile = await db.profile(id);
    expect(profile.username).toMatch(/^member_[0-9a-f]{8}$/);
    expect(profile).toMatchObject({ needs_onboarding: true, locale: 'fr' });
  });

  it('never takes a username from provider metadata, even a reserved one', async () => {
    const id = await googleUser({ username: 'admin' });
    expect(await db.profile(id)).toMatchObject({ needs_onboarding: true });
    expect((await db.profile(id)).username).toMatch(/^member_/);
  });

  it('still rejects email sign-ups without a valid username', async () => {
    await expect(db.createUser({ provider: 'email', providerMetadata: { locale: 'en' } })).rejects.toThrow(/invalid_username/);
  });

  it('denies every capability until onboarding is complete', async () => {
    const id = await googleUser();
    const { s } = await db.asOne<{ s: { needs_onboarding: boolean; capabilities: Record<string, string | null> } }>(
      user(id), `select public.my_standing() as s`,
    );
    expect(s.needs_onboarding).toBe(true);
    expect(Object.values(s.capabilities).every((reason) => reason === 'onboarding')).toBe(true);

    const post = await createPost(db, await db.createUser({ karma: 200 }));
    const error = await db.expectError(user(id), `select public.create_comment($1, 'Hello from a new account')`, [post]);
    expect(error).toMatchObject({ code: 'PF403', detail: 'comment:onboarding' });
  });
});

describe('complete_onboarding', () => {
  it('sets the chosen username, then unlocks newcomer capabilities', async () => {
    const id = await googleUser();
    await onboard(id, 'maple_reader');
    expect(await db.profile(id)).toMatchObject({ username: 'maple_reader', needs_onboarding: false });

    const post = await createPost(db, await db.createUser({ karma: 200 }));
    await expect(db.as(user(id), `select public.create_comment($1, 'Hello from a new account')`, [post])).resolves.toBeDefined();
  });

  it('can only succeed once', async () => {
    const id = await googleUser();
    await onboard(id, 'once_only');
    expect(await db.expectError(user(id), `select public.complete_onboarding('twice_now', true)`)).toMatchObject({ code: 'PF409', message: 'already_onboarded' });
  });

  it('does not apply to members who signed up with the form', async () => {
    const id = await db.createUser();
    expect((await db.expectError(user(id), `select public.complete_onboarding('renamed_me', true)`)).message).toBe('already_onboarded');
  });

  it('requires the adult acknowledgement', async () => {
    const id = await googleUser();
    expect(await db.expectError(user(id), `select public.complete_onboarding('kid_test', false)`)).toMatchObject({ code: 'PF422', message: 'adult_required' });
    expect((await db.expectError(user(id), `select public.complete_onboarding('kid_test', null)`)).message).toBe('adult_required');
  });

  it('validates usernames like the sign-up form', async () => {
    const id = await googleUser();
    await db.createUser({ username: 'taken_name' });
    expect((await db.expectError(user(id), `select public.complete_onboarding('TAKEN_NAME', true)`))).toMatchObject({ code: 'PF409', message: 'username_taken' });
    expect((await db.expectError(user(id), `select public.complete_onboarding('ab', true)`)).message).toBe('invalid_username');
    expect((await db.expectError(user(id), `select public.complete_onboarding('moderator_x', true)`)).message).toBe('reserved_username');
    expect((await db.profile(id)).needs_onboarding).toBe(true);
  });

  it('keeps its own placeholder name available', async () => {
    const id = await googleUser();
    await onboard(id, 'plain_member');
    expect(await db.profile(id)).toMatchObject({ needs_onboarding: false });
  });

  it('is not callable anonymously, and the flag is not readable through the API', async () => {
    expect((await db.expectError(anon, `select public.complete_onboarding('anon_user', true)`)).code).toMatch(/^(42501|PF401)$/);
    const id = await googleUser();
    expect((await db.expectError(user(id), `select needs_onboarding from public.profiles where id = $1`, [id])).code).toBe('42501');
  });

  it('rate-limits successful calls', async () => {
    await db.setConfig('rate_limit.onboarding', { limit: 0, window_seconds: 3600 });
    const id = await googleUser();
    expect((await db.expectError(user(id), `select public.complete_onboarding('limited_one', true)`)).code).toBe('PF429');
    await db.setConfig('rate_limit.onboarding', { limit: 20, window_seconds: 3600 });
  });
});
