# ADR-0003 · Note scoring: bootstrap first, bridging in shadow

**Status:** accepted · 2026-11-02

## Context

X's Community Notes uses matrix factorisation to find agreement *across* viewpoints. A factor model needs many raters with overlapping histories. At launch, Pepforum will have tens of raters, and a 1-D factor fitted on thin data is noise. The prototype's "60% of two groups" rule has the same problem, plus it needed 60 ratings per note, which would never settle.

## Decision

- Two scorers, both pure TypeScript in `apps/worker/src/scoring`:
  - **bootstrap**: the Wilson lower bound on the weighted helpful share;
  - **bridging**: matrix factorisation, using X's published model and thresholds.
- Both run on every pass. `scoring.mode` picks which one is applied; the other's results and the agreement rate go to `scoring_runs.shadow`.
- A guard refuses bridging mode until `switch_min_raters` raters have 10 or more ratings.
- Launch safety comes from:
  - founding raters (vetted, expiring);
  - probation (new raters weigh 0 until their record matches outcomes);
  - queue assignment (self-picked notes weigh 0.5).
- Status is applied by one SQL function (`apply_note_scores`). It is idempotent per run id, refuses concurrent runs, skips notes rated after the snapshot, and settles rewards only once a status has held for 72 hours.

## Consequences

- At launch, a coordinated majority could carry a note in bootstrap mode. Mitigated by the measures above; the worker tests demonstrate the failure case and the bridging fix.
- Our own matrix factorisation is about 150 lines and deterministic, with alternating closed-form ridge steps. If scale demands it, port X's open-source scorer behind the same interface.
