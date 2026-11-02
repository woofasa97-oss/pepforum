import { type NextRequest, NextResponse } from 'next/server';

import { isOAuthProvider } from '@/lib/auth-providers';
import { env } from '@/lib/env';
import { safeRedirectPath } from '@/lib/safe-redirect';
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
  const origin = request.nextUrl.origin;
  if (!isOAuthProvider(provider)) return NextResponse.redirect(new URL('/auth/sign-in?error=provider', origin));

  const next = safeRedirectPath(request.nextUrl.searchParams.get('next'));
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: { redirectTo: `${env().SITE_URL}/auth/confirm?next=${encodeURIComponent(next)}`, skipBrowserRedirect: true },
  });
  // The URL comes from supabase-js and must point at our own Supabase project.
  if (error || !data.url || new URL(data.url).origin !== new URL(env().SUPABASE_URL).origin) {
    return NextResponse.redirect(new URL('/auth/sign-in?error=provider', origin));
  }
  return NextResponse.redirect(data.url);
}
