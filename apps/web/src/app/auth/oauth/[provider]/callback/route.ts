import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';

import { finishSignIn } from '@/lib/auth-finish';
import { env } from '@/lib/env';
import { GOOGLE_COOKIE, GOOGLE_TOKEN_URL, decodeFlow } from '@/lib/google-oauth';
import { redirectWithinSite } from '@/lib/safe-redirect';
import { createSupabaseServerClient } from '@/lib/supabase/server';

/**
 * Google's redirect back to pepforum.ca (lib/google-oauth.ts). Checks the
 * state against the cookie set when the flow started (so a code minted for
 * someone else can't be planted here), swaps the code for Google's ID token
 * with the PKCE verifier and our client secret, and lets Supabase sign the
 * member in with that token. Logs carry error codes only.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const failed = () => redirectWithinSite('/auth/sign-in?error=provider');
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SITE_URL } = env();
  if (provider !== 'google' || !GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return failed();

  const cookieStore = await cookies();
  const flow = decodeFlow(cookieStore.get(GOOGLE_COOKIE)?.value);
  cookieStore.delete({ name: GOOGLE_COOKIE, path: '/auth/oauth/google' });

  const query = request.nextUrl.searchParams;
  const code = query.get('code');
  if (!flow || !code || query.get('error') || query.get('state') !== flow.state) return failed();

  let idToken: string | undefined;
  try {
    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: `${SITE_URL}/auth/oauth/google/callback`,
        grant_type: 'authorization_code',
        code_verifier: flow.verifier,
      }),
      cache: 'no-store',
    });
    if (!response.ok) {
      console.error(JSON.stringify({ level: 'error', context: 'google_token', code: response.status }));
      return failed();
    }
    idToken = ((await response.json()) as { id_token?: string }).id_token;
  } catch {
    console.error(JSON.stringify({ level: 'error', context: 'google_token', code: 'network' }));
    return failed();
  }
  if (!idToken) return failed();

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithIdToken({ provider: 'google', token: idToken, nonce: flow.nonce });
  if (error) {
    console.error(JSON.stringify({ level: 'error', context: 'google_id_token', code: error.code ?? error.status ?? 'unknown' }));
    return failed();
  }
  return finishSignIn(supabase, flow.next);
}
