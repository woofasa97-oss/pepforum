/**
 * Runs before every page and route handler (Next.js 16 "proxy", formerly
 * middleware):
 *   1. issues a per-request CSP nonce (Next applies it to its own scripts);
 *   2. refreshes the Supabase session cookie so Server Components see a valid
 *      session, forwarding the no-store cache headers @supabase/ssr requires.
 *
 * It does NOT authorise anything. Pages and Server Actions check the session
 * themselves, and the database enforces permissions regardless (see
 * docs/ARCHITECTURE.md).
 */
import type { Database } from '@pepforum/database';
import { createServerClient } from '@supabase/ssr';
import { type NextRequest, NextResponse } from 'next/server';

import { buildCsp, createNonce } from '@/lib/csp';

export async function proxy(request: NextRequest) {
  const nonce = createNonce();
  const csp = buildCsp({
    nonce,
    isDev: process.env.NODE_ENV !== 'production',
    turnstile: Boolean(process.env.TURNSTILE_SITE_KEY),
  });

  const forwardHeaders = () => {
    const headers = new Headers(request.headers);
    headers.set('x-nonce', nonce);
    headers.set('content-security-policy', csp);
    return headers;
  };

  let response = NextResponse.next({ request: { headers: forwardHeaders() } });

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (url && key) {
    const supabase = createServerClient<Database>(url, key, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, headers) {
          for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
          response = NextResponse.next({ request: { headers: forwardHeaders() } });
          for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
          for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
        },
      },
    });
    // Verifies the JWT and refreshes it if expired. Do not add logic between
    // client creation and this call (per @supabase/ssr guidance).
    await supabase.auth.getClaims();
  }

  response.headers.set('content-security-policy', csp);
  return response;
}

export const config = {
  matcher: [
    // Everything except static assets and image optimisation.
    '/((?!_next/static|_next/image|favicon.ico|icon.svg|robots.txt|.*\\.(?:svg|png|jpg|jpeg|webp|ico|woff2?)$).*)',
  ],
};
