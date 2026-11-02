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
