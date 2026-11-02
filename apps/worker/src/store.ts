/**
 * The worker's only view of the outside world. Jobs depend on this interface,
 * not on Supabase, so they run unchanged against PGlite in tests and dry runs.
 */
import type { Json } from '@pepforum/database';

import type { NoteScore } from './scoring/types.ts';

export interface ApplyScoresRequest {
  readonly runId: string;
  readonly snapshot: string;
  readonly mode: 'bootstrap' | 'bridging';
  readonly results: readonly NoteScore[];
  readonly shadow: Json;
}

export interface ApplyScoresResult {
  readonly scored?: number;
  readonly transitions?: number;
  readonly locked?: number;
  readonly skipped_stale?: number;
  readonly already_applied?: boolean;
}

export interface WorkerStore {
  /** Raw scoring_input() payload; validated by parseScoringInput(). */
  loadScoringInput(windowDays: number): Promise<unknown>;
  applyScores(request: ApplyScoresRequest): Promise<ApplyScoresResult>;
  runMaintenance(): Promise<Record<string, number>>;
  pendingAccountDeletions(limit: number): Promise<string[]>;
  /** Deletes the auth user (email, password hash, sessions). Idempotent. */
  deleteAuthUser(userId: string): Promise<void>;
  markAccountDeletionProcessed(userId: string): Promise<void>;
}

export function toResultsPayload(results: readonly NoteScore[]): Json {
  return results.map((r) => ({
    note_id: r.noteId,
    status: r.status,
    intercept: r.intercept === null ? null : round(r.intercept),
    factor: r.factor === null ? null : round(r.factor),
  }));
}

const round = (value: number): number => Math.round(value * 1e6) / 1e6;
