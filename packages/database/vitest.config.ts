import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Each file boots its own in-process Postgres; keep files isolated.
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
