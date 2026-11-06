import type { EmailOtpType } from '@supabase/supabase-js';
import type { NextRequest } from 'next/server';

import { finishSignIn } from '@/lib/auth-finish';
import { redirectWithinSite, safeRedirectPath } from '@/lib/safe-redirect';
import { createSupabaseServerClient } from '@/lib/supabase/server';

const OTP_TYPES = new Set<EmailOtpType>(['signup', 'invite', 'magiclink', 'recovery', 'email_change', 'email']);

/**
 * Landing point for links in Supabase Auth emails (confirm sign-up, sign-in
 * link, reset password, change email) and for social sign-in callbacks.
 * Configure the email templates to link to
 * `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=<type>`
 * (docs/DEPLOYMENT.md). Verifying server-side sets the session cookie.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const tokenHash = params.get('token_hash');
  const type = params.get('type') as EmailOtpType | null;
  const code = params.get('code');
  const next = safeRedirectPath(params.get('next'));
  const supabase = await createSupabaseServerClient();

  let ok = false;
  if (tokenHash && type && OTP_TYPES.has(type)) {
    ok = !(await supabase.auth.verifyOtp({ type, token_hash: tokenHash })).error;
  } else if (code) {
    // PKCE: only succeeds in the browser that started the flow (verifier cookie).
    ok = !(await supabase.auth.exchangeCodeForSession(code)).error;
  }
  if (!ok) return redirectWithinSite(params.has('error') ? '/auth/sign-in?error=provider' : '/auth/sign-in?error=confirm');

  // Same second factor as password sign-in; a first social sign-in still picks a username.
  return finishSignIn(supabase, next);
}
