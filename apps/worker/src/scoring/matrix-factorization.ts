/**
 * Bridging scorer: the matrix-factorisation model behind X's Community Notes.
 *
 *     r̂(u, n) = μ + i_u + i_n + f_u · f_n
 *
 * μ is the global mean, i_u a rater's leniency, f_u a rater's position on the
 * one dimension that best explains disagreement, and f_n how polarising a note
 * is along it. Agreement that is explained by viewpoint ends up in f_u·f_n;
 * what remains in the note intercept i_n is helpfulness that raters on *both*
 * sides recognise. That is the quantity we threshold.
 *
 * Fitting minimises
 *     Σ w·(r − r̂)² + λ_i·(Σ i_u² + Σ i_n²) + λ_f·(Σ f_u² + Σ f_n²)
 * by alternating ridge regressions: with rater parameters fixed, each note's
 * (i_n, f_n) has a closed-form 2×2 solution, and vice versa. Deterministic:
 * entities are processed in sorted order and factors are initialised from a
 * seeded PRNG, so the same input always yields the same statuses.
 */
import type { BridgingConfig, NoteScore, OpenNote, Rating } from './types.ts';

export interface FactorModel {
  readonly mu: number;
  readonly noteIntercepts: ReadonlyMap<string, number>;
  readonly noteFactors: ReadonlyMap<string, number>;
  readonly raterIntercepts: ReadonlyMap<string, number>;
  readonly raterFactors: ReadonlyMap<string, number>;
  readonly iterations: number;
  readonly loss: number;
}

export interface FitOptions {
  readonly lambdaIntercept: number;
  readonly lambdaFactor: number;
  readonly maxIterations?: number;
  readonly tolerance?: number;
  readonly seed?: number;
}

/** mulberry32: tiny, fast, deterministic PRNG. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Solves [[a, b], [b, d]] · [x, y] = [e, f]; returns [0, 0] if singular. */
function solve2x2(a: number, b: number, d: number, e: number, f: number): [number, number] {
  const det = a * d - b * b;
  if (Math.abs(det) < 1e-12) return [0, 0];
  return [(e * d - b * f) / det, (a * f - b * e) / det];
}

export function fitMatrixFactorization(ratings: readonly Rating[], options: FitOptions): FactorModel {
  const maxIterations = options.maxIterations ?? 300;
  const tolerance = options.tolerance ?? 1e-9;
  const random = prng(options.seed ?? 20261102);

  const byNote = new Map<string, Rating[]>();
  const byRater = new Map<string, Rating[]>();
  for (const r of ratings) {
    (byNote.get(r.noteId) ?? byNote.set(r.noteId, []).get(r.noteId)!).push(r);
    (byRater.get(r.raterId) ?? byRater.set(r.raterId, []).get(r.raterId)!).push(r);
  }
  const noteIds = [...byNote.keys()].sort();
  const raterIds = [...byRater.keys()].sort();

  const noteIntercepts = new Map<string, number>(noteIds.map((id) => [id, 0]));
  const raterIntercepts = new Map<string, number>(raterIds.map((id) => [id, 0]));
  const noteFactors = new Map<string, number>(noteIds.map((id) => [id, (random() - 0.5) * 0.2]));
  const raterFactors = new Map<string, number>(raterIds.map((id) => [id, (random() - 0.5) * 0.2]));

  const totalWeight = ratings.reduce((sum, r) => sum + r.weight, 0);
  let mu = totalWeight > 0 ? ratings.reduce((sum, r) => sum + r.weight * r.value, 0) / totalWeight : 0;

  const lossOf = (): number => {
    let loss = 0;
    for (const r of ratings) {
      const err = r.value - (mu + raterIntercepts.get(r.raterId)! + noteIntercepts.get(r.noteId)! + raterFactors.get(r.raterId)! * noteFactors.get(r.noteId)!);
      loss += r.weight * err * err;
    }
    for (const v of noteIntercepts.values()) loss += options.lambdaIntercept * v * v;
    for (const v of raterIntercepts.values()) loss += options.lambdaIntercept * v * v;
    for (const v of noteFactors.values()) loss += options.lambdaFactor * v * v;
    for (const v of raterFactors.values()) loss += options.lambdaFactor * v * v;
    return loss;
  };

  // One ridge step: refit (intercept, factor) for each entity given the other side.
  const refit = (
    ids: readonly string[],
    groups: ReadonlyMap<string, Rating[]>,
    intercepts: Map<string, number>,
    factors: Map<string, number>,
    otherIntercept: (r: Rating) => number,
    otherFactor: (r: Rating) => number,
  ): void => {
    for (const id of ids) {
      let sw = 0, swf = 0, swff = 0, swy = 0, swyf = 0;
      for (const r of groups.get(id)!) {
        const f = otherFactor(r);
        const y = r.value - mu - otherIntercept(r);
        sw += r.weight;
        swf += r.weight * f;
        swff += r.weight * f * f;
        swy += r.weight * y;
        swyf += r.weight * y * f;
      }
      const [intercept, factor] = solve2x2(sw + options.lambdaIntercept, swf, swff + options.lambdaFactor, swy, swyf);
      intercepts.set(id, intercept);
      factors.set(id, factor);
    }
  };

  let previous = lossOf();
  let iterations = 0;
  for (; iterations < maxIterations; iterations++) {
    refit(noteIds, byNote, noteIntercepts, noteFactors, (r) => raterIntercepts.get(r.raterId)!, (r) => raterFactors.get(r.raterId)!);
    refit(raterIds, byRater, raterIntercepts, raterFactors, (r) => noteIntercepts.get(r.noteId)!, (r) => noteFactors.get(r.noteId)!);

    if (totalWeight > 0) {
      let residual = 0;
      for (const r of ratings) {
        residual += r.weight * (r.value - raterIntercepts.get(r.raterId)! - noteIntercepts.get(r.noteId)! - raterFactors.get(r.raterId)! * noteFactors.get(r.noteId)!);
      }
      mu = residual / totalWeight;
    }

    const current = lossOf();
    if (Math.abs(previous - current) <= tolerance * Math.max(1, previous)) {
      previous = current;
      iterations += 1;
      break;
    }
    previous = current;
  }

  return { mu, noteIntercepts, noteFactors, raterIntercepts, raterFactors, iterations, loss: previous };
}

/** X's status rule on (intercept, factor). */
export function bridgingStatus(intercept: number, factor: number, config: BridgingConfig): OpenNote['status'] {
  if (intercept >= config.helpfulIntercept && Math.abs(factor) < config.maxFactor) return 'helpful';
  if (intercept <= config.notHelpfulIntercept - config.notHelpfulFactorSlope * Math.abs(factor)) return 'not_helpful';
  return 'needs_more_ratings';
}

export function scoreBridging(notes: readonly OpenNote[], ratings: readonly Rating[], config: BridgingConfig): NoteScore[] {
  const model = fitMatrixFactorization(ratings, {
    lambdaIntercept: config.lambdaIntercept,
    lambdaFactor: config.lambdaFactor,
  });
  const weights = new Map<string, number>();
  for (const r of ratings) weights.set(r.noteId, (weights.get(r.noteId) ?? 0) + r.weight);

  return notes.map((note) => {
    const weight = weights.get(note.id) ?? 0;
    const intercept = model.noteIntercepts.get(note.id) ?? null;
    const factor = model.noteFactors.get(note.id) ?? null;
    const status =
      weight < note.minRatings || intercept === null || factor === null
        ? 'needs_more_ratings'
        : bridgingStatus(intercept, factor, config);
    return { noteId: note.id, status, intercept, factor, weightedRatings: weight };
  });
}
