/**
 * Bootstrap scorer — used at launch, while the rater pool is too small for a
 * factor model to find meaningful viewpoints.
 *
 * A note is Helpful when the lower bound of the Wilson score interval on its
 * weighted helpful share clears `helpfulLowerBound` (default 0.65 at 90%), and
 * Not Helpful when the upper bound falls below `notHelpfulUpperBound`. Weak
 * evidence stays Needs More Ratings. Its known weakness — a coordinated
 * majority can carry a note — is mitigated by founding raters, probation and
 * queue assignment, and removed entirely once bridging mode takes over.
 */
import type { BootstrapConfig, NoteScore, OpenNote, Rating } from './types.ts';

export interface WilsonInterval {
  readonly lower: number;
  readonly upper: number;
}

/**
 * Wilson score interval for a proportion. `successes` may be fractional
 * (weighted ratings, Somewhat = 0.5).
 */
export function wilsonInterval(successes: number, total: number, z: number): WilsonInterval {
  if (total <= 0) return { lower: 0, upper: 1 };
  const p = Math.min(Math.max(successes / total, 0), 1);
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const centre = (p + z2 / (2 * total)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) / denominator;
  return { lower: Math.max(0, centre - margin), upper: Math.min(1, centre + margin) };
}

export function scoreBootstrap(notes: readonly OpenNote[], ratings: readonly Rating[], config: BootstrapConfig): NoteScore[] {
  const totals = new Map<string, { weight: number; helpful: number }>();
  for (const rating of ratings) {
    const entry = totals.get(rating.noteId) ?? { weight: 0, helpful: 0 };
    entry.weight += rating.weight;
    entry.helpful += rating.weight * rating.value;
    totals.set(rating.noteId, entry);
  }

  return notes.map((note) => {
    const { weight, helpful } = totals.get(note.id) ?? { weight: 0, helpful: 0 };
    const share = weight > 0 ? helpful / weight : null;
    if (weight < note.minRatings) {
      return { noteId: note.id, status: 'needs_more_ratings', intercept: share, factor: null, weightedRatings: weight };
    }
    const { lower, upper } = wilsonInterval(helpful, weight, config.z);
    const status = lower >= config.helpfulLowerBound ? 'helpful' : upper <= config.notHelpfulUpperBound ? 'not_helpful' : 'needs_more_ratings';
    return { noteId: note.id, status, intercept: share, factor: null, weightedRatings: weight };
  });
}
