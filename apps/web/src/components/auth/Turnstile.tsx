'use client';

import Script from 'next/script';

/**
 * Cloudflare Turnstile CAPTCHA. Renders into the surrounding <form> and adds a
 * hidden `cf-turnstile-response` field, which the Server Action forwards to
 * Supabase Auth for verification. Rendered only when TURNSTILE_SITE_KEY is set
 * (the CSP allows challenges.cloudflare.com only in that case).
 */
export function Turnstile({ siteKey, nonce }: { siteKey: string | undefined; nonce: string | undefined }) {
  if (!siteKey) return null;
  return (
    <>
      <Script src="https://challenges.cloudflare.com/turnstile/v0/api.js" strategy="afterInteractive" nonce={nonce} />
      <div className="cf-turnstile mb12" data-sitekey={siteKey} data-theme="auto" />
    </>
  );
}
