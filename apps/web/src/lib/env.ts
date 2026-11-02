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
  SITE_URL: z.url({ protocol: /^https?$/ }),
  TURNSTILE_SITE_KEY: z.string().min(1).optional(),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export type ServerEnv = z.infer<typeof EnvSchema>;

let cached: ServerEnv | undefined;

export function env(): ServerEnv {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new Error(`Invalid server environment: ${fields}. See .env.example.`);
  }
  if ('SUPABASE_SECRET_KEY' in process.env && parsed.data.NODE_ENV === 'production') {
    // Defence in depth: the web service must never hold the RLS-bypassing key.
    throw new Error('SUPABASE_SECRET_KEY must not be configured on the web service.');
  }
  cached = parsed.data;
  return cached;
}
