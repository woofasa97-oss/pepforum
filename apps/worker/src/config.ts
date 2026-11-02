/**
 * Validation for everything the worker reads from outside: environment
 * variables and the scoring_input() payload. Fails fast with a clear message
 * rather than scoring on half-parsed data.
 */
import { NOTE_STATUSES, RATING_VALUES } from '@pepforum/database';
import { z } from 'zod';

import type { OpenNote, Rating, ScoringConfig } from './scoring/types.ts';

const EnvSchema = z.object({
  SUPABASE_URL: z.url({ protocol: /^https?$/ }),
  // New-style secret key (sb_secret_…) or legacy service_role JWT.
  SUPABASE_SECRET_KEY: z.string().min(20),
  SCORING_WINDOW_DAYS: z.coerce.number().int().min(1).max(3650).default(180),
  DELETIONS_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),
});
export type WorkerEnv = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    // Report which variables are wrong, never their values.
    const fields = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new Error(`Invalid worker environment: ${fields}`);
  }
  return parsed.data;
}

const num = z.coerce.number().finite();

const ScoringConfigSchema = z.object({
  'scoring.mode': z.enum(['bootstrap', 'bridging']),
  'scoring.bootstrap.helpful_lower_bound': num.min(0).max(1),
  'scoring.bootstrap.not_helpful_upper_bound': num.min(0).max(1),
  'scoring.bootstrap.z': num.positive(),
  'scoring.bridging.lambda_intercept': num.nonnegative(),
  'scoring.bridging.lambda_factor': num.nonnegative(),
  'scoring.bridging.helpful_intercept': num,
  'scoring.bridging.max_factor': num.positive(),
  'scoring.bridging.not_helpful_intercept': num,
  'scoring.bridging.not_helpful_factor_slope': num.nonnegative(),
  'scoring.bridging.switch_min_raters': num.int().nonnegative(),
});

export function parseScoringConfig(raw: unknown): ScoringConfig {
  const c = ScoringConfigSchema.parse(raw);
  return {
    mode: c['scoring.mode'],
    bootstrap: {
      helpfulLowerBound: c['scoring.bootstrap.helpful_lower_bound'],
      notHelpfulUpperBound: c['scoring.bootstrap.not_helpful_upper_bound'],
      z: c['scoring.bootstrap.z'],
    },
    bridging: {
      lambdaIntercept: c['scoring.bridging.lambda_intercept'],
      lambdaFactor: c['scoring.bridging.lambda_factor'],
      helpfulIntercept: c['scoring.bridging.helpful_intercept'],
      maxFactor: c['scoring.bridging.max_factor'],
      notHelpfulIntercept: c['scoring.bridging.not_helpful_intercept'],
      notHelpfulFactorSlope: c['scoring.bridging.not_helpful_factor_slope'],
      switchMinRaters: c['scoring.bridging.switch_min_raters'],
    },
  };
}

const RATING_NUMERIC = { helpful: 1, somewhat: 0.5, not_helpful: 0 } as const;

const ScoringInputSchema = z.object({
  snapshot: z.string().min(1),
  config: z.record(z.string(), z.unknown()),
  open_notes: z.array(z.object({ id: z.uuid(), min_ratings: z.number().int().positive(), status: z.enum(NOTE_STATUSES) })),
  ratings: z.array(z.tuple([z.uuid(), z.uuid(), z.enum(RATING_VALUES), z.coerce.number().positive().max(1)])),
});

export interface ScoringInput {
  readonly snapshot: string;
  readonly config: ScoringConfig;
  readonly openNotes: OpenNote[];
  readonly ratings: Rating[];
}

export function parseScoringInput(raw: unknown): ScoringInput {
  const input = ScoringInputSchema.parse(raw);
  return {
    snapshot: input.snapshot,
    config: parseScoringConfig(input.config),
    openNotes: input.open_notes.map((n) => ({ id: n.id, minRatings: n.min_ratings, status: n.status })),
    ratings: input.ratings.map(([noteId, raterId, value, weight]) => ({ noteId, raterId, value: RATING_NUMERIC[value], weight })),
  };
}
