import type { CommentRow } from '@pepforum/database';
import { describe, expect, it } from 'vitest';

import { describeRequirement, messageForDbError } from '@/lib/errors';
import { en, fr, translator } from '@/lib/i18n';
import { buildThread } from '@/lib/thread';
import { CreatePostSchema, ProposeNoteSchema, RateNoteSchema, SignUpSchema, formToObject } from '@/lib/validation';

const t = translator('en');

describe('error mapping', () => {
  it('explains capability gates instead of failing silently', () => {
    expect(messageForDbError({ code: 'PF403', message: 'capability_denied', details: 'rate_notes:tier:2' }, t))
      .toBe('Not unlocked yet: Requires Trusted.');
    expect(messageForDbError({ code: 'PF403', message: 'capability_denied', details: 'rate_notes:account_age:30' }, t))
      .toBe('Not unlocked yet: Account must be 30 days old.');
  });

  it('maps known codes and specific messages', () => {
    expect(messageForDbError({ code: 'PF429', message: 'rate_limited' }, t)).toBe(en['errors.rateLimited']);
    expect(messageForDbError({ code: 'PF429', message: 'rate_limited', details: 'post_newcomer' }, t)).toBe(en['errors.rateLimitedNewcomer']);
    expect(messageForDbError({ code: 'PF422', message: 'self_vote' }, t)).toBe(en['errors.self_vote']);
    expect(messageForDbError({ code: 'PF428', message: 'mfa_required' }, t)).toBe(en['errors.mfaRequired']);
  });

  it('never leaks unknown internal errors', () => {
    const message = messageForDbError({ code: 'XX000', message: 'relation "secret_table" does not exist' }, t);
    expect(message).toBe(en['errors.unexpected']);
    expect(message).not.toContain('secret_table');
  });

  it('describes every requirement kind', () => {
    expect(describeRequirement('rater_impact:5', t)).toContain('5');
    expect(describeRequirement('writing_locked', t)).toBe(en['req.writing_locked']);
    expect(describeRequirement('something_new', t)).toBe(en['req.unknown']);
    expect(describeRequirement(null, t)).toBe(en['cap.allowed']);
  });
});

describe('i18n', () => {
  it('French has every English key with the same placeholders', () => {
    const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(en) as Array<keyof typeof en>) {
      expect(fr[key], key).toBeTruthy();
      expect(placeholders(fr[key]), key).toEqual(placeholders(en[key]));
    }
  });

  it('interpolates variables', () => {
    expect(translator('fr')('notes.ratings', { n: 3, min: 5 })).toBe('3 sur 5 évaluations');
  });
});

describe('validation', () => {
  it('requires 12+ character passwords and valid usernames at sign-up', () => {
    const base = { email: 'a@b.ca', password: 'correct-horse-battery', username: 'maple_you', locale: 'en', ageAck: 'on', terms: 'on' };
    expect(SignUpSchema.safeParse(base).success).toBe(true);
    expect(SignUpSchema.safeParse({ ...base, password: 'short' }).success).toBe(false);
    expect(SignUpSchema.safeParse({ ...base, username: 'no spaces' }).success).toBe(false);
    expect(SignUpSchema.safeParse({ ...base, ageAck: undefined }).success).toBe(false);
  });

  it('requires a link for resource posts and https only', () => {
    const base = { zone: 'on', category: 'research', type: 'resource', language: 'en', ack: 'on', title: 'A link to the source', body: '' };
    expect(CreatePostSchema.safeParse(base).success).toBe(false);
    expect(CreatePostSchema.safeParse({ ...base, link: 'http://x.example.com/a' }).success).toBe(false);
    expect(CreatePostSchema.safeParse({ ...base, link: 'https://clinicaltrials.gov/study/NCT1' }).success).toBe(true);
  });

  it('rejects homepage-only note sources', () => {
    const base = { postId: '00000000-0000-4000-8000-000000000001', classification: 'missing_context', body: 'Context that is long enough to pass.', language: 'en' };
    expect(ProposeNoteSchema.safeParse({ ...base, sources: [{ url: 'https://nejm.org', kind: 'journal' }] }).success).toBe(false);
    expect(ProposeNoteSchema.safeParse({ ...base, sources: [{ url: 'https://nejm.org/doi/1', kind: 'journal' }] }).success).toBe(true);
  });

  it('only accepts reason tags that match the rating value', () => {
    const noteId = '00000000-0000-4000-8000-000000000001';
    expect(RateNoteSchema.safeParse({ noteId, value: 'helpful', reasons: ['cites_sources'] }).success).toBe(true);
    expect(RateNoteSchema.safeParse({ noteId, value: 'helpful', reasons: ['opinion'] }).success).toBe(false);
    expect(RateNoteSchema.safeParse({ noteId, value: 'helpful', reasons: ['clear', 'clear'] }).success).toBe(false);
  });

  it('formToObject collects repeated fields and ignores files', () => {
    const form = new FormData();
    form.append('reasons', 'a');
    form.append('reasons', 'b');
    form.append('file', new Blob(['x']));
    expect(formToObject(form)).toEqual({ reasons: ['a', 'b'] });
  });
});

describe('buildThread', () => {
  const row = (id: string, parent: string | null): CommentRow => ({
    id, parent_id: parent, depth: 0, author_username: 'u', author_tier: 0, is_op: false, is_mine: false,
    body: id, status: 'visible', score: 0, created_at: '2026-01-01T00:00:00Z', edited_at: null, my_vote: null,
  });

  it('nests replies and keeps orphans visible', () => {
    const tree = buildThread([row('a', null), row('b', 'a'), row('c', 'b'), row('d', 'missing')]);
    expect(tree.map((n) => n.id)).toEqual(['a', 'd']);
    expect(tree[0]?.children[0]?.children[0]?.id).toBe('c');
  });
});
