import { env } from '@/lib/env';

/**
 * Route handlers don't get Server Actions' built-in origin check, so state-
 * changing ones call this: the request must come from a page on this site.
 */
export function isSameOrigin(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin') return false;
  const origin = request.headers.get('origin');
  if (!origin) return site === 'same-origin';
  try {
    return new URL(origin).host === new URL(env().SITE_URL).host || new URL(origin).host === request.headers.get('host');
  } catch {
    return false;
  }
}
