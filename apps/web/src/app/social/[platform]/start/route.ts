import { NextResponse } from 'next/server';

import { env } from '@/lib/env';
import { redirectWithinSite } from '@/lib/safe-redirect';
import { SOCIAL_COOKIE, authorizeUrl, configuredPlatforms, encodeSocialFlow, isSocialPlatform, newSocialFlow } from '@/lib/socials';
import { getViewer } from '@/server/context';

/**
 * "Verify" on Settings → Verified accounts (…028): sends the member to the
 * network to sign in. A GET link, like social sign-in (CSP form-action would
 * block the hop after a form post). The state cookie ties the callback to
 * this browser and this member's session.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ platform: string }> }) {
  const { platform } = await params;
  if (!(await getViewer())) return redirectWithinSite('/auth/sign-in?next=/settings');
  if (!isSocialPlatform(platform) || !configuredPlatforms().includes(platform)) return redirectWithinSite('/settings?social=unavailable#socials');

  const flow = newSocialFlow(platform);
  const url = authorizeUrl(flow);
  if (!url) return redirectWithinSite('/settings?social=unavailable#socials');
  const response = NextResponse.redirect(url);
  response.cookies.set(SOCIAL_COOKIE, encodeSocialFlow(flow), {
    httpOnly: true, secure: env().NODE_ENV === 'production', sameSite: 'lax', path: '/social', maxAge: 600,
  });
  return response;
}
