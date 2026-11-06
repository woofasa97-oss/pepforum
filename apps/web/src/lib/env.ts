import 'server-only';

import { z } from 'zod';

/**
 * Server environment, validated once on first use. The browser never needs
 * any of these: every Supabase call happens on the server, so the publishable
 * key isn't even shipped to clients. The secret key is NOT read here — it
 * belongs to the worker only.
 */
const EnvSchema = z.object({
  SUPABASE_URL: z.url({ protocol: /^https?$/ }),
  SUPABASE_PUBLISHABLE_KEY: z.string().min(20),
  // Normalised to the bare origin, so "https://example.com/" doesn't produce "//auth/confirm".
  SITE_URL: z.url({ protocol: /^https?$/, error: 'expected a full URL such as https://example.com' }).transform((url) => new URL(url).origin),
  TURNSTILE_SITE_KEY: z.string().min(1).optional(),
  // Web push (…022): the public half of the VAPID pair; the private half is the worker's.
  VAPID_PUBLIC_KEY: z.string().min(20).optional(),
  // Ad frequency capping (…025): salts the per-visitor token. Any random string.
  AD_VISITOR_SALT: z.string().min(8).optional(),
  // "Continue with Google" on our own domain (lib/google-oauth.ts). Both set → our flow; otherwise Supabase's.
  GOOGLE_CLIENT_ID: z.string().regex(/\.apps\.googleusercontent\.com$/, 'expected the OAuth client ID ending in .apps.googleusercontent.com').optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(10).optional(),
  // Verified social accounts (…028, lib/socials.ts). The key is shared with the database
  // (private.app_secrets 'social_attestation'); each network appears once its app is set.
  SOCIAL_ATTESTATION_KEY: z.string().min(32, 'use at least 32 random characters').optional(),
  X_CLIENT_ID: z.string().min(5).optional(),
  X_CLIENT_SECRET: z.string().min(5).optional(),
  INSTAGRAM_CLIENT_ID: z.string().min(5).optional(),
  INSTAGRAM_CLIENT_SECRET: z.string().min(5).optional(),
  TIKTOK_CLIENT_KEY: z.string().min(5).optional(),
  TIKTOK_CLIENT_SECRET: z.string().min(5).optional(),
  REDDIT_CLIENT_ID: z.string().min(5).optional(),
  REDDIT_CLIENT_SECRET: z.string().min(5).optional(),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export type ServerEnv = z.infer<typeof EnvSchema>;

let cached: ServerEnv | undefined;

export function env(): ServerEnv {
  if (cached) return cached;
  // Empty strings (a blank line copied from .env.example) mean "not set".
  const source = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== ''));
  const parsed = EnvSchema.safeParse({
    ...source,
    // Without SITE_URL, use the https://<service>.onrender.com URL Render sets on web services.
    SITE_URL: source.SITE_URL ?? source.RENDER_EXTERNAL_URL,
  });
  if (!parsed.success) {
    // Zod messages describe the problem without echoing the value.
    const fields = parsed.error.issues.map((issue) => `${issue.path.join('.')} (${issue.message})`).join(', ');
    throw new Error(`Invalid server environment: ${fields}. See .env.example.`);
  }
  if ('SUPABASE_SECRET_KEY' in process.env && parsed.data.NODE_ENV === 'production') {
    // Defence in depth: the web service must never hold the RLS-bypassing key.
    throw new Error('SUPABASE_SECRET_KEY must not be configured on the web service.');
  }
  cached = parsed.data;
  return cached;
}
