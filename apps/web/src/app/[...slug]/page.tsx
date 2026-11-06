import { notFound, permanentRedirect, redirect } from 'next/navigation';

import { safeRedirectPath } from '@/lib/safe-redirect';
import { resolveRedirect } from '@/server/queries';

/**
 * Catch-all for paths no page matched: follows a managed redirect (admin →
 * SEO, migration …021) or shows the 404 page. A redirect can therefore never
 * shadow a real route.
 */
export default async function UnmatchedPath({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  let path: string;
  try {
    path = '/' + slug.map((s) => encodeURIComponent(decodeURIComponent(s))).join('/');
  } catch {
    notFound(); // malformed percent-encoding
  }
  const target = await resolveRedirect(path);
  if (!target) notFound();
  // External targets were validated as https by the database; internal ones go through safeRedirectPath.
  const to = target.to.startsWith('/') ? safeRedirectPath(target.to) : target.to;
  if (target.permanent) permanentRedirect(to);
  redirect(to);
}
