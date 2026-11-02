/**
 * Content-Security-Policy builder (pure, unit-tested in tests/csp.test.ts).
 *
 * Scripts: only Next's own bundles, authorised by a per-request nonce with
 * 'strict-dynamic' — no inline scripts, no third-party script origins except
 * Cloudflare Turnstile when CAPTCHA is enabled. The browser never talks to
 * Supabase directly (all data access is server-side), so connect-src stays
 * 'self'.
 *
 * Styles allow 'unsafe-inline' because React style attributes (progress bar
 * widths) need it; style injection without script execution is low risk and
 * documented in docs/THREAT_MODEL.md.
 */
export interface CspOptions {
  readonly nonce: string;
  readonly isDev: boolean;
  readonly turnstile: boolean;
}

const TURNSTILE = 'https://challenges.cloudflare.com';

export function buildCsp({ nonce, isDev, turnstile }: CspOptions): string {
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", ...(isDev ? ["'unsafe-eval'"] : []), ...(turnstile ? [TURNSTILE] : [])],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:'],
    'font-src': ["'self'"],
    'connect-src': ["'self'", ...(isDev ? ['ws:'] : []), ...(turnstile ? [TURNSTILE] : [])],
    'frame-src': turnstile ? [TURNSTILE] : ["'none'"],
    'frame-ancestors': ["'none'"],
    'form-action': ["'self'"],
    'base-uri': ["'none'"],
    'object-src': ["'none'"],
    'manifest-src': ["'self'"],
    'worker-src': ["'self'", 'blob:'],
  };
  const policy = Object.entries(directives).map(([name, values]) => `${name} ${values.join(' ')}`);
  if (!isDev) policy.push('upgrade-insecure-requests');
  return policy.join('; ');
}

/** 128-bit nonce, base64-encoded (Web Crypto: works in the proxy runtime). */
export function createNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
