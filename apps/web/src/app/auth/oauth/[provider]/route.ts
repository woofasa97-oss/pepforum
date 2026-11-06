import { type NextRequest, NextResponse } from 'next/server';

import { isOAuthProvider } from '@/lib/auth-providers';
import { env } from '@/lib/env';
import { GOOGLE_COOKIE, encodeFlow, googleAuthorizeUrl, newGoogleFlow } from '@/lib/google-oauth';
import { redirectWithinSite, safeRedirectPath } from '@/lib/safe-redirect';
import { createSupabaseServerClient } from '@/lib/supabase/server';

/**
 * Starts "Continue with <provider>". A GET link rather than a form: CSP
 * `form-action 'self'` also applies to the redirects after a form POST, which
 * would block the hop to Supabase and the provider. Starting a flow is
 * harmless on its own; the PKCE verifier cookie set here is what
 * /auth/confirm later requires to exchange the code, so a code minted in
 * another browser can't be planted on this one.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  if (!isOAuthProvider(provider)) return redirectWithinSite('/auth/sign-in?error=provider');

  const next = safeRedirectPath(request.nextUrl.searchParams.get('next'));

  // Google on our own domain when its client is configured (see lib/google-oauth.ts).
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SITE_URL, NODE_ENV } = env();
  if (provider === 'google' && GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) {
    const flow = newGoogleFlow(next);
    const response = NextResponse.redirect(googleAuthorizeUrl(flow, GOOGLE_CLIENT_ID, `${SITE_URL}/auth/oauth/google/callback`));
    response.cookies.set(GOOGLE_COOKIE, encodeFlow(flow), {
      httpOnly: true, secure: NODE_ENV === 'production', sameSite: 'lax', path: '/auth/oauth/google', maxAge: 600,
    });
    return response;
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: { redirectTo: `${env().SITE_URL}/auth/confirm?next=${encodeURIComponent(next)}`, skipBrowserRedirect: true },
  });
  // The URL comes from supabase-js and must point at our own Supabase project.
  if (error || !data.url || new URL(data.url).origin !== new URL(env().SUPABASE_URL).origin) {
    return redirectWithinSite('/auth/sign-in?error=provider');
  }
  return NextResponse.redirect(data.url);
}
