import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';

import { env } from '@/lib/env';
import { logUnexpected } from '@/lib/errors';
import { redirectWithinSite } from '@/lib/safe-redirect';
import { SOCIAL_COOKIE, SocialError, attest, decodeSocialFlow, fetchSocialProfile, isSocialPlatform } from '@/lib/socials';
import { getSupabase, getViewer } from '@/server/context';

/**
 * The network's redirect back (…028). Checks the state cookie, swaps the
 * code for a token, reads the account from the network's API, signs the
 * result for this member and hands it to link_social_account(), which checks
 * the signature, the freshness and that nobody else has the account. The
 * token is discarded. Logs carry codes only, never handles or numbers.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ platform: string }> }) {
  const { platform } = await params;
  const back = (result: string) => redirectWithinSite(`/settings?social=${result}${isSocialPlatform(platform) ? `&platform=${platform}` : ''}#socials`);
  const viewer = await getViewer();
  if (!viewer) return redirectWithinSite('/auth/sign-in?next=/settings');

  const cookieStore = await cookies();
  const flow = decodeSocialFlow(cookieStore.get(SOCIAL_COOKIE)?.value);
  cookieStore.delete({ name: SOCIAL_COOKIE, path: '/social' });

  const query = request.nextUrl.searchParams;
  if (query.get('error')) return back('cancelled');
  const code = query.get('code');
  if (!flow || !code || flow.platform !== platform || query.get('state') !== flow.state) return back('failed');

  const key = env().SOCIAL_ATTESTATION_KEY;
  if (!key) return back('unavailable');

  let attestation;
  try {
    attestation = attest(viewer.id, flow.platform, await fetchSocialProfile(flow, code), key);
  } catch (error) {
    return back(error instanceof SocialError && error.code === 'no_channel' ? 'no_channel' : 'failed');
  }

  const supabase = await getSupabase();
  const { error } = await supabase.rpc('link_social_account', {
    p_platform: attestation.platform,
    p_external_id: attestation.externalId,
    p_handle: attestation.handle,
    p_audience: attestation.audience,
    p_profile_url: attestation.url,
    p_metrics: attestation.metrics,
    p_issued_at: attestation.issuedAt,
    p_signature: attestation.signature,
  });
  if (error) {
    logUnexpected('link_social_account', error);
    return back(error.message === 'social_taken' ? 'taken' : error.code === 'PF429' ? 'rate_limited'
      : error.message === 'socials_not_configured' ? 'unavailable' : 'failed');
  }
  return back('linked');
}
