import { describe, expect, it } from 'vitest';

import { scoreBootstrap, wilsonInterval } from '../src/scoring/bootstrap.ts';
import { bridgingStatus, fitMatrixFactorization, scoreBridging } from '../src/scoring/matrix-factorization.ts';
import { scoreNotes } from '../src/scoring/index.ts';
import type { BridgingConfig, OpenNote, Rating, ScoringConfig } from '../src/scoring/types.ts';

const bridging: BridgingConfig = {
  lambdaIntercept: 0.15,
  lambdaFactor: 0.03,
  helpfulIntercept: 0.4,
  maxFactor: 0.5,
  notHelpfulIntercept: -0.05,
  notHelpfulFactorSlope: 0.8,
  switchMinRaters: 150,
};
const config: ScoringConfig = {
  mode: 'bootstrap',
  bootstrap: { helpfulLowerBound: 0.65, notHelpfulUpperBound: 0.35, z: 1.645 },
  bridging,
};

/** Deterministic PRNG for synthetic data. */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

type Kind = 'bridging' | 'partisanA' | 'partisanB' | 'bad';

/**
 * Two camps of raters (A and B) who disagree on contested notes. `sizeA` > `sizeB`
 * models a majority that could carry a note on its own.
 */
function polarisedCommunity(sizeA: number, sizeB: number, counts: Record<Kind, number>, seed = 7) {
  const random = rng(seed);
  const raters = [
    ...Array.from({ length: sizeA }, (_, i) => ({ id: `A${String(i).padStart(3, '0')}`, camp: 'A' as const })),
    ...Array.from({ length: sizeB }, (_, i) => ({ id: `B${String(i).padStart(3, '0')}`, camp: 'B' as const })),
  ];
  const notes: Array<{ id: string; kind: Kind }> = [];
  for (const kind of Object.keys(counts) as Kind[]) {
    for (let i = 0; i < counts[kind]; i++) notes.push({ id: `${kind}-${i}`, kind });
  }
  const pHelpful = (kind: Kind, camp: 'A' | 'B') =>
    ({ bridging: 0.92, bad: 0.06, partisanA: camp === 'A' ? 0.92 : 0.08, partisanB: camp === 'B' ? 0.92 : 0.08 })[kind];

  const ratings: Rating[] = [];
  for (const note of notes) {
    for (const rater of raters) {
      if (random() > 0.7) continue; // each rater sees ~70% of notes
      ratings.push({ noteId: note.id, raterId: rater.id, value: random() < pHelpful(note.kind, rater.camp) ? 1 : 0, weight: 1 });
    }
  }
  const open: OpenNote[] = notes.map((n) => ({ id: n.id, minRatings: 5, status: 'needs_more_ratings' }));
  return { notes, ratings, open };
}

describe('wilsonInterval', () => {
  it('is wide for small samples and narrows with evidence', () => {
    const small = wilsonInterval(4, 5, 1.645);
    const large = wilsonInterval(80, 100, 1.645);
    expect(small.upper - small.lower).toBeGreaterThan(large.upper - large.lower);
    expect(large.lower).toBeGreaterThan(0.72);
    expect(large.upper).toBeLessThan(0.87);
  });

  it('handles empty samples', () => {
    expect(wilsonInterval(0, 0, 1.645)).toEqual({ lower: 0, upper: 1 });
  });
});

describe('bootstrap scorer', () => {
  const open: OpenNote[] = [{ id: 'n', minRatings: 5, status: 'needs_more_ratings' }];
  const ratingsOf = (values: Array<0 | 0.5 | 1>, weight = 1): Rating[] =>
    values.map((value, i) => ({ noteId: 'n', raterId: `r${i}`, value, weight }));

  it('needs the minimum weighted ratings before deciding', () => {
    expect(scoreBootstrap(open, ratingsOf([1, 1, 1, 1]), config.bootstrap)[0]?.status).toBe('needs_more_ratings');
    // Unassigned ratings weigh 0.5: eight of them are only 4 full ratings.
    expect(scoreBootstrap(open, ratingsOf([1, 1, 1, 1, 1, 1, 1, 1], 0.5), config.bootstrap)[0]?.status).toBe('needs_more_ratings');
  });

  it('decides clear cases and leaves split evidence open', () => {
    expect(scoreBootstrap(open, ratingsOf([1, 1, 1, 1, 1, 1, 1, 1]), config.bootstrap)[0]?.status).toBe('helpful');
    expect(scoreBootstrap(open, ratingsOf([0, 0, 0, 0, 0, 0, 0, 0]), config.bootstrap)[0]?.status).toBe('not_helpful');
    expect(scoreBootstrap(open, ratingsOf([1, 0, 1, 0, 1, 0, 0.5, 0.5]), config.bootstrap)[0]?.status).toBe('needs_more_ratings');
  });
});

describe('bridging scorer (matrix factorisation)', () => {
  it('is deterministic', () => {
    const { ratings } = polarisedCommunity(20, 20, { bridging: 3, partisanA: 3, partisanB: 3, bad: 3 });
    const a = fitMatrixFactorization(ratings, { lambdaIntercept: 0.15, lambdaFactor: 0.03 });
    const b = fitMatrixFactorization(ratings, { lambdaIntercept: 0.15, lambdaFactor: 0.03 });
    expect([...a.noteIntercepts]).toEqual([...b.noteIntercepts]);
  });

  it('separates the two camps along the factor axis', () => {
    const { ratings } = polarisedCommunity(25, 25, { bridging: 5, partisanA: 10, partisanB: 10, bad: 15 });
    const model = fitMatrixFactorization(ratings, { lambdaIntercept: 0.15, lambdaFactor: 0.03 });
    const campMean = (camp: string) => {
      const values = [...model.raterFactors].filter(([id]) => id.startsWith(camp)).map(([, f]) => f);
      return values.reduce((s, v) => s + v, 0) / values.length;
    };
    expect(Math.sign(campMean('A'))).not.toBe(Math.sign(campMean('B')));
  });

  it('shows notes both camps find helpful and refuses notes only one camp likes', () => {
    const { notes, ratings, open } = polarisedCommunity(25, 25, { bridging: 5, partisanA: 10, partisanB: 10, bad: 15 });
    const status = new Map(scoreBridging(open, ratings, bridging).map((s) => [s.noteId, s.status]));
    for (const note of notes) {
      if (note.kind === 'bridging') expect(status.get(note.id), note.id).toBe('helpful');
      else expect(status.get(note.id), note.id).not.toBe('helpful');
      if (note.kind === 'bad') expect(status.get(note.id), note.id).toBe('not_helpful');
    }
  });

  it('is not fooled by a majority camp — the bootstrap scorer is', () => {
    // Camp A outnumbers B 85:15, so A-partisan notes look ~80% helpful overall
    // — enough to clear a pure majority bound. (At 3:1 the Wilson bound alone
    // still holds; the bootstrap scorer is only for the launch phase.)
    const { notes, ratings, open } = polarisedCommunity(85, 15, { bridging: 5, partisanA: 10, partisanB: 10, bad: 15 }, 11);
    const bridged = new Map(scoreBridging(open, ratings, bridging).map((s) => [s.noteId, s.status]));
    const boot = new Map(scoreBootstrap(open, ratings, config.bootstrap).map((s) => [s.noteId, s.status]));
    const partisanA = notes.filter((n) => n.kind === 'partisanA');

    expect(partisanA.some((n) => boot.get(n.id) === 'helpful')).toBe(true);
    expect(partisanA.every((n) => bridged.get(n.id) !== 'helpful')).toBe(true);
    for (const n of notes.filter((x) => x.kind === 'bridging')) expect(bridged.get(n.id)).toBe('helpful');
  });

  it('applies X’s status boundaries', () => {
    expect(bridgingStatus(0.45, 0.1, bridging)).toBe('helpful');
    expect(bridgingStatus(0.45, 0.6, bridging)).toBe('needs_more_ratings'); // polarising
    expect(bridgingStatus(-0.1, 0, bridging)).toBe('not_helpful');
    expect(bridgingStatus(-0.1, 0.3, bridging)).toBe('needs_more_ratings'); // -0.1 > -0.05 - 0.24
  });
});

describe('scoreNotes', () => {
  it('applies bootstrap by default and runs bridging in shadow', () => {
    const { ratings, open } = polarisedCommunity(10, 10, { bridging: 2, partisanA: 2, partisanB: 2, bad: 2 });
    const outcome = scoreNotes(open, ratings, config);
    expect(outcome.appliedMode).toBe('bootstrap');
    expect(outcome.shadow).toHaveLength(open.length);
    expect(outcome.agreement).toBeGreaterThanOrEqual(0);
  });

  it('refuses to switch to bridging before there are enough established raters', () => {
    const { ratings, open } = polarisedCommunity(10, 10, { bridging: 4, partisanA: 4, partisanB: 4, bad: 4 });
    const outcome = scoreNotes(open, ratings, { ...config, mode: 'bridging' });
    expect(outcome).toMatchObject({ appliedMode: 'bootstrap', guardTriggered: true });

    const enough = scoreNotes(open, ratings, { ...config, mode: 'bridging', bridging: { ...bridging, switchMinRaters: 5 } });
    expect(enough.appliedMode).toBe('bridging');
  });
});
