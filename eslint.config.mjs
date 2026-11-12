// @ts-check
import js from '@eslint/js';
import nextVitals from 'eslint-config-next/core-web-vitals';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const scopeTo = (files, configs) => configs.map((config) => ({ ...config, files }));

export default defineConfig(
  { ignores: ['**/node_modules/**', '**/.next/**', '**/dist/**', '**/coverage/**', '**/next-env.d.ts'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      eqeqeq: ['error', 'always'],
      'no-console': ['error', { allow: ['error', 'warn'] }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },

  // Web app: Next.js + React rules, plus security guard rails.
  ...scopeTo(['apps/web/**/*.{ts,tsx}'], nextVitals),
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    settings: { next: { rootDir: 'apps/web' } },
    rules: {
      // All user content renders as text. Raw HTML injection is never needed.
      'react/no-danger': 'error',
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['@pepforum/database/testing', '@electric-sql/pglite'], message: 'Test harness only — never ship it in the web app.' },
          { group: ['**/worker/**'], message: 'The worker holds the secret key; the web app must not import it.' },
        ],
      }],
      'no-restricted-properties': ['error', {
        object: 'process', property: 'env',
        message: 'Read configuration through src/lib/env.ts (validated, server-only).',
      }],
    },
  },
  {
    // The proxy and Next config run before env() can be used.
    files: ['apps/web/src/proxy.ts', 'apps/web/next.config.ts', 'apps/web/src/lib/env.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },

  // Worker: structured JSON logs go to stdout.
  { files: ['apps/worker/**/*.ts'], rules: { 'no-console': 'off' } },

  // Price pipeline: a CLI. One JSON summary on stdout, logs on stderr.
  // `x == null` (null or undefined) is the ported code's idiom for values read from vendors' feeds.
  { files: ['apps/prices/**/*.ts'], rules: { 'no-console': 'off', eqeqeq: ['error', 'always', { null: 'ignore' }] } },

  // Tests may use console and loose typing for fixtures.
  { files: ['**/tests/**/*.ts'], rules: { 'no-console': 'off' } },
);
