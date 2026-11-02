import type { EmailOtpType } from '@supabase/supabase-js';
import { type NextRequest, NextResponse } from 'next/server';

import { safeRedirectPath } from '@/lib/safe-redirect';
import { createSupabaseServerClient } from '@/lib/supabase/server';

const OTP_TYPES = new Set<EmailOtpType>(['signup', 'invite', 'magiclink', 'recovery', 'email_change', 'email']);

/**
 * Landing point for links in Supabase Auth emails (confirm sign-up, reset
 * password, change email). Configure the email templates to link to
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
    ok = !(await supabase.auth.exchangeCodeForSession(code)).error;
  }

  const destination = new URL(ok ? next : '/auth/sign-in?error=confirm', request.nextUrl.origin);
  return NextResponse.redirect(destination);
}
