/**
 * Issue #21, Phase 1: the weighted-random pick among a frozen Top 3 —
 * isolated here, deliberately, per explicit instruction to keep
 * probability logic out of components/actions rather than scattered.
 *
 * **Weighting choice, stated before implementing (per instruction)**:
 * fixed rank-based weights, not raw vote-count-proportional. Rank 1 gets
 * weight 3, rank 2 gets weight 2, rank 3 gets weight 1 — regardless of
 * *how large* the actual vote gap between them is. With 3 candidates the
 * leader wins exactly 3/6 = 50% of selections, 2nd gets 33%, 3rd 17%;
 * with 2 candidates, 60/40; with 1, 100% (nothing to weigh against).
 *
 * This satisfies "more votes must produce better odds, but #1 must not
 * automatically win": higher rank (which requires more votes to reach)
 * always gets strictly better odds, but a landslide leader — 500 votes
 * to 1, say — gets exactly the same 50% as a narrow 3-to-2 leader,
 * because only *rank position*, not vote magnitude, drives the weight.
 * A raw vote-count-proportional weighting wouldn't have that property —
 * a large enough gap would make the outcome practically deterministic,
 * which is the specific failure mode called out to avoid.
 *
 * `SELECTION_RANK_WEIGHTS` is the one place this curve lives — swapping
 * it for a vote-count-sensitive curve later (e.g. `sqrt(votes + 1)`) is
 * a one-line change here, not a hunt through components.
 */
export const SELECTION_RANK_WEIGHTS: readonly number[] = [3, 2, 1];

export type SelectionCandidate = {
  requestId: string;
  /** 1-indexed rank within the frozen pool — ties already broken deterministically upstream (see freeze_speaker_candidates' SQL: vote count desc, created_at asc, id asc). */
  rank: number;
};

/**
 * Picks one candidate, weighted by `SELECTION_RANK_WEIGHTS`. `randomValue`
 * is an externally supplied number in `[0, 1)` — never generated inside
 * this function — so every boundary is exactly reproducible in tests
 * without mocking `Math.random`. The caller (a Server Action, never a
 * client component) is responsible for supplying real randomness.
 *
 * Returns `null` for an empty candidate list (Section C's "0 candidates"
 * case is the caller's responsibility to detect before calling this —
 * this is just the pure math).
 */
export function selectWeightedCandidate(
  candidates: readonly SelectionCandidate[],
  randomValue: number,
): string | null {
  if (candidates.length === 0) return null;

  const sorted = [...candidates].sort((a, b) => a.rank - b.rank);
  const weights = sorted.map((_, index) => SELECTION_RANK_WEIGHTS[index] ?? 1);
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  const threshold = randomValue * totalWeight;

  let cumulative = 0;
  for (let i = 0; i < sorted.length; i++) {
    cumulative += weights[i];
    if (threshold < cumulative) return sorted[i].requestId;
  }
  // Only reachable if randomValue >= 1 (out of the documented [0, 1)
  // contract, e.g. a caller passing exactly 1) — falls back to the last
  // candidate rather than returning null/undefined for a technically
  // out-of-range input.
  return sorted[sorted.length - 1].requestId;
}
