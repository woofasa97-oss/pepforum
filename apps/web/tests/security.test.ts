import { describe, expect, it } from 'vitest';

import { buildCsp, createNonce } from '@/lib/csp';
import { safeRedirectPath } from '@/lib/safe-redirect';

describe('safeRedirectPath (open-redirect guard)', () => {
  it.each([
    ['/post/abc', '/post/abc'],
    ['/notes?tab=helpful#x', '/notes?tab=helpful#x'],
    ['/auth/update-password', '/auth/update-password'],
  ])('allows same-site path %s', (input, expected) => {
    expect(safeRedirectPath(input)).toBe(expected);
  });

  it.each([
    'https://evil.example',
    '//evil.example/path',
    '/\\evil.example',
    'javascript:alert(1)',
    '/.//evil.example',
    '/a/..//evil.example',
    '/%2e//evil.example',
    '/./\\evil.example',
    'evil.example',
    '',
    '/\u0000x',
    `/${'a'.repeat(600)}`,
    undefined,
    42,
  ])('rejects %s', (input) => {
    expect(safeRedirectPath(input)).toBe('/');
  });
});

describe('Content-Security-Policy', () => {
  const nonce = 'abc123==';

  it('only allows nonce-authorised scripts in production', () => {
    const csp = buildCsp({ nonce, isDev: false, turnstile: false });
    expect(csp).toContain(`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`);
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain('upgrade-insecure-requests');
    expect(csp).toContain("frame-src 'none'");
  });

  it('opens exactly the Turnstile origin when CAPTCHA is enabled', () => {
    const csp = buildCsp({ nonce, isDev: false, turnstile: true });
    expect(csp).toContain('frame-src https://challenges.cloudflare.com');
    expect(csp.match(/https:\/\//g)).toHaveLength(3); // script, connect, frame
  });

  it('never lets the browser talk to third-party APIs directly', () => {
    expect(buildCsp({ nonce, isDev: false, turnstile: false })).toContain("connect-src 'self';");
  });

  it('creates unique, 128-bit nonces', () => {
    const a = createNonce();
    const b = createNonce();
    expect(a).not.toBe(b);
    expect(Buffer.from(a, 'base64')).toHaveLength(16);
  });
});
