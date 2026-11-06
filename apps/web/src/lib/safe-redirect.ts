/**
 * Open-redirect guard for `next=` parameters. Only same-site relative paths
 * are allowed; anything that could leave the site (`//evil.com`,
 * `/\evil.com`, `https://…`, `javascript:`) falls back to the default.
 */
export function safeRedirectPath(candidate: unknown, fallback = '/'): string {
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 512) return fallback;
  if (!candidate.startsWith('/')) return fallback;
  if (candidate.startsWith('//') || candidate.startsWith('/\\')) return fallback;
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\u0000-\u001f\u007f]/.test(candidate)) return fallback;
  try {
    // Resolve against a dummy origin: if the origin changes, it wasn't relative.
    const url = new URL(candidate, 'https://pepforum.invalid');
    if (url.origin !== 'https://pepforum.invalid') return fallback;
    // Normalisation can *create* a protocol-relative path: "/.//evil.com" and
    // "/a/..//evil.com" both resolve to "//evil.com". Re-check the result.
    if (url.pathname.startsWith('//') || url.pathname.startsWith('/\\')) return fallback;
    return url.pathname + url.search + url.hash;
  } catch {
    return fallback;
  }
}

/**
 * A redirect from a route handler to a path on this site. The Location is
 * relative on purpose: behind Render's proxy the request URL is the internal
 * `https://localhost:10000`, so a URL built from `request.nextUrl.origin`
 * sends people to localhost. A relative one keeps the browser on whatever
 * address it used, which is also where any session cookie was just set.
 */
export function redirectWithinSite(path: string): Response {
  return new Response(null, { status: 307, headers: { Location: safeRedirectPath(path) } });
}
