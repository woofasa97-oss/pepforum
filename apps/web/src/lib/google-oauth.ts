import 'server-only';

import { createHash, randomBytes } from 'node:crypto';

/**
 * "Continue with Google" handled on our own domain. Google redirects back to
 * <SITE_URL>/auth/oauth/google/callback instead of to Supabase, so Google's
 * screen names pepforum.ca (and, once Google verifies the brand, shows the
 * Pepforum name and logo) instead of the Supabase project address.
 *
 * Flow: authorization code + PKCE + state + nonce. The server swaps the code
 * for Google's ID token, then signInWithIdToken() hands that token to
 * Supabase, which checks it was issued to our client ID and that the nonce
 * matches. The same Google account maps to the same Supabase user either way.
 */
export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_COOKIE = 'pf-oauth-google';

export interface GoogleFlow {
  /** Echoed back by Google; must match. */
  readonly state: string;
  /** Raw nonce for Supabase; Google receives its SHA-256 (hex). */
  readonly nonce: string;
  /** PKCE verifier; Google receives its S256 challenge. */
  readonly verifier: string;
  /** Where to land after signing in (already made safe). */
  readonly next: string;
}

const random = () => randomBytes(32).toString('base64url');

export const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');
export const pkceChallenge = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

export function newGoogleFlow(next: string): GoogleFlow {
  return { state: random(), nonce: random(), verifier: random(), next };
}

export function googleAuthorizeUrl(flow: GoogleFlow, clientId: string, redirectUri: string): string {
  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state: flow.state,
    nonce: sha256Hex(flow.nonce),
    code_challenge: pkceChallenge(flow.verifier),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  return url.toString();
}

export function encodeFlow(flow: GoogleFlow): string {
  return Buffer.from(JSON.stringify(flow)).toString('base64url');
}

export function decodeFlow(value: string | undefined): GoogleFlow | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<GoogleFlow>;
    const ok = [parsed.state, parsed.nonce, parsed.verifier, parsed.next].every((v) => typeof v === 'string' && v.length > 0 && v.length < 600);
    return ok ? (parsed as GoogleFlow) : null;
  } catch {
    return null;
  }
}
