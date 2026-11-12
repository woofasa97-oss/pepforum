import type { NextConfig } from 'next';

/**
 * Static security headers for every response. The Content-Security-Policy is
 * per-request (it carries a nonce) and is set in src/proxy.ts.
 */
const securityHeaders = [
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()' },
];

// Same fallback as src/lib/env.ts; an invalid value is reported there, not here.
const siteUrl = process.env.SITE_URL || process.env.RENDER_EXTERNAL_URL;
const siteHost = siteUrl && URL.canParse(siteUrl) ? new URL(siteUrl).host : undefined;

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The database package ships TypeScript source.
  transpilePackages: ['@pepforum/database'],
  experimental: {
    serverActions: {
      bodySizeLimit: '256kb',
      // Server Actions already reject cross-origin POSTs; list extra trusted
      // origins here only if the app is served behind another hostname.
      allowedOrigins: siteHost ? [siteHost] : [],
    },
  },
  async headers() {
    // Click-throughs to stores (…032) tell the store nothing about where the visitor came from, so
    // that one route gets the same headers with a stricter Referrer-Policy. The two rules never
    // overlap: when two rules set the same header on one path, the stricter value is not guaranteed to win.
    const noReferrer = securityHeaders.map((h) => (h.key === 'Referrer-Policy' ? { ...h, value: 'no-referrer' } : h));
    return [
      { source: '/((?!prices/go/).*)', headers: securityHeaders },
      { source: '/prices/go/:id', headers: noReferrer },
    ];
  },
};

export default config;
