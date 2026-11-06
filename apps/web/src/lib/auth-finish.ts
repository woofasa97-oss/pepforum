import 'server-only';

import { redirectWithinSite } from '@/lib/safe-redirect';
import type { ServerSupabase } from '@/lib/supabase/server';

/**
 * Where a member goes once a sign-in has produced a session (email link,
 * Supabase OAuth callback or our own Google callback): the second factor if
 * they use one, the welcome step if a social sign-up hasn't picked a
 * username yet, otherwise `next`.
 */
export async function finishSignIn(supabase: ServerSupabase, next: string): Promise<Response> {
  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal && aal.nextLevel === 'aal2' && aal.currentLevel !== 'aal2') {
    return redirectWithinSite(`/auth/mfa?next=${encodeURIComponent(next)}`);
  }
  const { data: standing } = await supabase.rpc('my_standing');
  if (standing?.needs_onboarding) return redirectWithinSite(`/auth/welcome?next=${encodeURIComponent(next)}`);
  return redirectWithinSite(next);
}
