/**
 * Runs both scorers on the same input. The configured mode decides which one
 * is applied; the other runs in shadow so we can measure agreement before
 * switching (docs/SELF_MODERATION.md §Scoring).
 */
import { scoreBootstrap } from './bootstrap.ts';
import { scoreBridging } from './matrix-factorization.ts';
import type { NoteScore, OpenNote, Rating, ScoringConfig } from './types.ts';

export interface ScoringOutcome {
  /** Mode actually applied (bridging falls back to bootstrap below the rater threshold). */
  readonly appliedMode: 'bootstrap' | 'bridging';
  readonly applied: NoteScore[];
  readonly shadow: NoteScore[];
  /** Share of notes on which the two scorers agree. */
  readonly agreement: number;
  /** Raters with at least 10 counted ratings in the input window. */
  readonly establishedRaters: number;
  readonly guardTriggered: boolean;
}

export function establishedRaterCount(ratings: readonly Rating[], minRatings = 10): number {
  const counts = new Map<string, number>();
  for (const r of ratings) counts.set(r.raterId, (counts.get(r.raterId) ?? 0) + 1);
  let established = 0;
  for (const count of counts.values()) if (count >= minRatings) established += 1;
  return established;
}

export function scoreNotes(notes: readonly OpenNote[], ratings: readonly Rating[], config: ScoringConfig): ScoringOutcome {
  const bootstrap = scoreBootstrap(notes, ratings, config.bootstrap);
  const bridging = scoreBridging(notes, ratings, config.bridging);

  const establishedRaters = establishedRaterCount(ratings);
  // Guard: never let a premature config switch hand status to a factor model
  // that can't yet see viewpoints.
  const guardTriggered = config.mode === 'bridging' && establishedRaters < config.bridging.switchMinRaters;
  const appliedMode = config.mode === 'bridging' && !guardTriggered ? 'bridging' : 'bootstrap';

  const statusOf = new Map(bridging.map((s) => [s.noteId, s.status]));
  const agreeing = bootstrap.filter((s) => statusOf.get(s.noteId) === s.status).length;

  return {
    appliedMode,
    applied: appliedMode === 'bridging' ? bridging : bootstrap,
    shadow: appliedMode === 'bridging' ? bootstrap : bridging,
    agreement: notes.length > 0 ? agreeing / notes.length : 1,
    establishedRaters,
    guardTriggered,
  };
}

export type { BootstrapConfig, BridgingConfig, NoteScore, OpenNote, Rating, ScoringConfig } from './types.ts';
