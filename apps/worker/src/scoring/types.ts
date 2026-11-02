import type { NoteStatus } from '@pepforum/database';

/** One full-weight-or-discounted rating. Helpful = 1, Somewhat = 0.5, Not helpful = 0. */
export interface Rating {
  readonly noteId: string;
  readonly raterId: string;
  readonly value: 0 | 0.5 | 1;
  /** 1 for assigned graduated raters, `notes.unassigned_weight` otherwise. Never 0 here. */
  readonly weight: number;
}

export interface OpenNote {
  readonly id: string;
  readonly minRatings: number;
  readonly status: NoteStatus;
}

export interface NoteScore {
  readonly noteId: string;
  readonly status: NoteStatus;
  /** Bootstrap: weighted helpful share. Bridging: note intercept i_n. */
  readonly intercept: number | null;
  /** Bridging only: note factor f_n (polarisation). */
  readonly factor: number | null;
  readonly weightedRatings: number;
}

export interface BootstrapConfig {
  readonly helpfulLowerBound: number;
  readonly notHelpfulUpperBound: number;
  readonly z: number;
}

export interface BridgingConfig {
  readonly lambdaIntercept: number;
  readonly lambdaFactor: number;
  readonly helpfulIntercept: number;
  readonly maxFactor: number;
  readonly notHelpfulIntercept: number;
  readonly notHelpfulFactorSlope: number;
  readonly switchMinRaters: number;
}

export interface ScoringConfig {
  readonly mode: 'bootstrap' | 'bridging';
  readonly bootstrap: BootstrapConfig;
  readonly bridging: BridgingConfig;
}
