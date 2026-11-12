import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// env() caches its result, so each test loads a fresh copy of the module.
async function loadEnv() {
  vi.resetModules();
  return (await import('@/lib/env')).env();
}

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', 'https://project.supabase.co');
  vi.stubEnv('SUPABASE_PUBLISHABLE_KEY', 'x'.repeat(32));
  vi.stubEnv('SITE_URL', undefined);
  vi.stubEnv('RENDER_EXTERNAL_URL', undefined);
  vi.stubEnv('TURNSTILE_SITE_KEY', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('server environment', () => {
  it('falls back to Render’s external URL when SITE_URL is not set', async () => {
    vi.stubEnv('RENDER_EXTERNAL_URL', 'https://pepforum-web.onrender.com');
    expect((await loadEnv()).SITE_URL).toBe('https://pepforum-web.onrender.com');
  });

  it('prefers SITE_URL and normalises it to the origin', async () => {
    vi.stubEnv('RENDER_EXTERNAL_URL', 'https://pepforum-web.onrender.com');
    vi.stubEnv('SITE_URL', 'https://pepforums.com/');
    expect((await loadEnv()).SITE_URL).toBe('https://pepforums.com');
  });

  it('explains an invalid SITE_URL without echoing the value', async () => {
    vi.stubEnv('SITE_URL', 'pepforums.com');
    const error = await loadEnv().catch((e: Error) => e);
    expect(String(error)).toContain('SITE_URL (expected a full URL such as https://example.com)');
    expect(String(error)).not.toContain('pepforums.com');
  });

  it('treats blank optional variables as unset', async () => {
    vi.stubEnv('SITE_URL', 'http://localhost:3000');
    vi.stubEnv('TURNSTILE_SITE_KEY', '');
    expect((await loadEnv()).TURNSTILE_SITE_KEY).toBeUndefined();
  });
});
