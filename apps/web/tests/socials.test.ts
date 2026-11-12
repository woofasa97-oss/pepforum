import { createHash, createHmac } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// lib/socials reads env() (cached), so each test loads fresh modules.
async function load() {
  vi.resetModules();
  return import('@/lib/socials');
}

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', 'https://project.supabase.co');
  vi.stubEnv('SUPABASE_PUBLISHABLE_KEY', 'x'.repeat(32));
  vi.stubEnv('SITE_URL', 'https://pepforums.com');
  vi.stubEnv('SOCIAL_ATTESTATION_KEY', 'k'.repeat(40));
  vi.stubEnv('X_CLIENT_ID', 'x-client-id');
  vi.stubEnv('X_CLIENT_SECRET', 'x-client-secret');
  vi.stubEnv('TIKTOK_CLIENT_KEY', 'tiktok-key');
  vi.stubEnv('TIKTOK_CLIENT_SECRET', 'tiktok-secret');
  vi.stubEnv('GOOGLE_CLIENT_ID', undefined);
  vi.stubEnv('INSTAGRAM_CLIENT_ID', undefined);
  vi.stubEnv('REDDIT_CLIENT_ID', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('verified social accounts', () => {
  it('signs exactly the string link_social_account() recomputes', async () => {
    const { attest } = await load();
    const a = attest('user-1', 'x', { externalId: '42', handle: 'maple', audience: 1234.9, url: 'https://x.com/maple', metrics: { posts: 7 } }, 'secret-key', 1_700_000_000);
    expect(a).toMatchObject({ audience: 1234, metrics: '{"posts":7}', issuedAt: 1_700_000_000 });
    const message = 'pepforum-social-v1|user-1|x|42|maple|1234|https://x.com/maple|{"posts":7}|1700000000';
    expect(a.signature).toBe(createHmac('sha256', 'secret-key').update(message).digest('hex'));
  });

  it('offers only networks whose apps are configured, and only with the attestation key', async () => {
    expect((await load()).configuredPlatforms()).toEqual(['x', 'tiktok']);
    vi.stubEnv('SOCIAL_ATTESTATION_KEY', undefined);
    expect((await load()).configuredPlatforms()).toEqual([]);
  });

  it('sends members to the network with state, PKCE where supported, and our callback', async () => {
    const { authorizeUrl, newSocialFlow } = await load();
    const flow = newSocialFlow('x');
    const x = new URL(authorizeUrl(flow) ?? '');
    expect(x.origin).toBe('https://x.com');
    expect(x.searchParams.get('redirect_uri')).toBe('https://pepforums.com/social/x/callback');
    expect(x.searchParams.get('state')).toBe(flow.state);
    expect(x.searchParams.get('code_challenge')).toBe(createHash('sha256').update(flow.verifier).digest('base64url'));

    const tiktok = new URL(authorizeUrl(newSocialFlow('tiktok')) ?? '');
    expect(tiktok.searchParams.get('client_key')).toBe('tiktok-key');
    expect(tiktok.searchParams.get('client_id')).toBeNull();
    expect(authorizeUrl(newSocialFlow('reddit'))).toBeNull();
  });

  it('round-trips the state cookie and rejects tampering', async () => {
    const { decodeSocialFlow, encodeSocialFlow, newSocialFlow } = await load();
    const flow = newSocialFlow('youtube');
    expect(decodeSocialFlow(encodeSocialFlow(flow))).toEqual(flow);
    expect(decodeSocialFlow(Buffer.from(JSON.stringify({ ...flow, platform: 'myspace' })).toString('base64url'))).toBeNull();
    expect(decodeSocialFlow('garbage')).toBeNull();
  });
});
