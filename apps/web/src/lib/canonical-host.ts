/**
 * The site moved from pepforum.ca to pepforums.com (2026-11). Requests that
 * arrive on an old or "www" host are sent to the same path on SITE_URL, so
 * links, bookmarks and search results keep working.
 *
 * Only known hosts are redirected: the Render service URL, localhost and any
 * other host are left alone, so a wrong SITE_URL can never lock the site out.
 */
export const LEGACY_HOSTS: readonly string[] = ['pepforum.ca', 'www.pepforum.ca'];

/** Returns the absolute URL to redirect to, or null to serve the request as is. */
export function canonicalRedirect(hostHeader: string | null, siteUrl: string | undefined, pathAndQuery: string): string | null {
  if (!hostHeader || !siteUrl) return null;
  let site: URL;
  try {
    site = new URL(siteUrl);
  } catch {
    return null;
  }
  const host = hostHeader.trim().toLowerCase().replace(/:\d+$/, '');
  if (host === site.hostname) return null;
  if (!LEGACY_HOSTS.includes(host) && host !== `www.${site.hostname}`) return null;
  // Path and query only: never let the request choose the destination host.
  const path = pathAndQuery.startsWith('/') && !pathAndQuery.startsWith('//') ? pathAndQuery : '/';
  return `${site.origin}${path}`;
}
