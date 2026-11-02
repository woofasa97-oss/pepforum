import type { EmailOtpType } from '@supabase/supabase-js';
import { type NextRequest, NextResponse } from 'next/server';

import { safeRedirectPath } from '@/lib/safe-redirect';
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
  const to = (path: string) => NextResponse.redirect(new URL(path, request.nextUrl.origin));

  let ok = false;
  if (tokenHash && type && OTP_TYPES.has(type)) {
    ok = !(await supabase.auth.verifyOtp({ type, token_hash: tokenHash })).error;
  } else if (code) {
    // PKCE: only succeeds in the browser that started the flow (verifier cookie).
    ok = !(await supabase.auth.exchangeCodeForSession(code)).error;
  }
  if (!ok) return to(params.has('error') ? '/auth/sign-in?error=provider' : '/auth/sign-in?error=confirm');

  // Same second factor as password sign-in: members with TOTP finish at aal2.
  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal && aal.nextLevel === 'aal2' && aal.currentLevel !== 'aal2') {
    return to(`/auth/mfa?next=${encodeURIComponent(next)}`);
  }

  // A first social sign-in still has to choose a username and confirm their age.
  const { data: standing } = await supabase.rpc('my_standing');
  if (standing?.needs_onboarding) return to(`/auth/welcome?next=${encodeURIComponent(next)}`);

  return to(next);
}
