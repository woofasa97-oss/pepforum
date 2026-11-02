/**
 * Scoring run: read a consistent snapshot, score with both algorithms, apply
 * the configured one atomically. Safe to run concurrently (the database
 * refuses overlapping runs) and to retry (idempotent per run id).
 */
import { randomUUID } from 'node:crypto';

import { parseScoringInput } from '../config.ts';
import type { Logger } from '../logger.ts';
import { scoreNotes } from '../scoring/index.ts';
import type { NoteScore } from '../scoring/types.ts';
import type { ApplyScoresResult, WorkerStore } from '../store.ts';

export interface ScoreNotesOptions {
  readonly windowDays: number;
  readonly dryRun?: boolean;
  readonly runId?: string;
}

export interface ScoreNotesReport {
  readonly runId: string;
  readonly mode: 'bootstrap' | 'bridging';
  readonly notes: number;
  readonly ratings: number;
  readonly plannedTransitions: Array<{ noteId: string; from: string; to: string }>;
  readonly agreement: number;
  readonly guardTriggered: boolean;
  readonly applied: ApplyScoresResult | null;
}

const countByStatus = (scores: readonly NoteScore[]) =>
  scores.reduce<Record<string, number>>((acc, s) => ({ ...acc, [s.status]: (acc[s.status] ?? 0) + 1 }), {});

export async function scoreNotesJob(store: WorkerStore, log: Logger, options: ScoreNotesOptions): Promise<ScoreNotesReport> {
  const runId = options.runId ?? randomUUID();
  const input = parseScoringInput(await store.loadScoringInput(options.windowDays));
  const outcome = scoreNotes(input.openNotes, input.ratings, input.config);

  if (outcome.guardTriggered) {
    log.warn('bridging mode configured but rater pool too small; applying bootstrap', {
      establishedRaters: outcome.establishedRaters,
      required: input.config.bridging.switchMinRaters,
    });
  }

  const current = new Map(input.openNotes.map((n) => [n.id, n.status]));
  const plannedTransitions = outcome.applied
    .filter((s) => current.get(s.noteId) !== s.status)
    .map((s) => ({ noteId: s.noteId, from: current.get(s.noteId) ?? 'unknown', to: s.status }));

  const shadow = {
    mode: outcome.appliedMode === 'bridging' ? 'bootstrap' : 'bridging',
    agreement: Math.round(outcome.agreement * 1000) / 1000,
    established_raters: outcome.establishedRaters,
    guard_triggered: outcome.guardTriggered,
    statuses: countByStatus(outcome.shadow),
  };

  let applied: ApplyScoresResult | null = null;
  if (!options.dryRun) {
    applied = await store.applyScores({
      runId,
      snapshot: input.snapshot,
      mode: outcome.appliedMode,
      results: outcome.applied,
      shadow,
    });
  }

  const report: ScoreNotesReport = {
    runId,
    mode: outcome.appliedMode,
    notes: input.openNotes.length,
    ratings: input.ratings.length,
    plannedTransitions,
    agreement: outcome.agreement,
    guardTriggered: outcome.guardTriggered,
    applied,
  };
  log.info('scoring run complete', {
    runId,
    mode: report.mode,
    dryRun: Boolean(options.dryRun),
    notes: report.notes,
    ratings: report.ratings,
    plannedTransitions: plannedTransitions.length,
    shadowAgreement: shadow.agreement,
    ...(applied ?? {}),
  });
  return report;
}
