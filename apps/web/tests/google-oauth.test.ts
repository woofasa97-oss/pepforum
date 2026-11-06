import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { decodeFlow, encodeFlow, googleAuthorizeUrl, newGoogleFlow, pkceChallenge, sha256Hex } from '@/lib/google-oauth';

describe('Google sign-in on our own domain', () => {
  it('asks Google for a code with state, a hashed nonce and a PKCE challenge, returning to our callback', () => {
    const flow = newGoogleFlow('/notes');
    const url = new URL(googleAuthorizeUrl(flow, 'abc.apps.googleusercontent.com', 'https://pepforum.ca/auth/oauth/google/callback'));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const q = url.searchParams;
    expect(q.get('redirect_uri')).toBe('https://pepforum.ca/auth/oauth/google/callback');
    expect(q.get('response_type')).toBe('code');
    expect(q.get('scope')).toBe('openid email profile');
    expect(q.get('state')).toBe(flow.state);
    // Supabase hashes the raw nonce we give it and compares with the token's claim.
    expect(q.get('nonce')).toBe(createHash('sha256').update(flow.nonce).digest('hex'));
    expect(q.get('nonce')).not.toBe(flow.nonce);
    expect(q.get('code_challenge')).toBe(pkceChallenge(flow.verifier));
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('code_challenge')).not.toContain('=');
  });

  it('makes every flow unpredictable and different', () => {
    const a = newGoogleFlow('/');
    const b = newGoogleFlow('/');
    expect(a.state).not.toBe(b.state);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.verifier.length).toBeGreaterThanOrEqual(43);
    expect(sha256Hex('x')).toHaveLength(64);
  });

  it('round-trips the flow cookie and rejects anything malformed', () => {
    const flow = newGoogleFlow('/u/maple_you');
    expect(decodeFlow(encodeFlow(flow))).toEqual(flow);
    expect(decodeFlow(undefined)).toBeNull();
    expect(decodeFlow('not-base64-json')).toBeNull();
    expect(decodeFlow(Buffer.from(JSON.stringify({ state: 'a' })).toString('base64url'))).toBeNull();
    expect(decodeFlow(Buffer.from(JSON.stringify({ ...flow, state: 5 })).toString('base64url'))).toBeNull();
  });
});
