/**
 * Issue #21, Part 3: the Continue/Replace round-outcome decision —
 * pure, unit-tested, same "keep the decision pure, keep the I/O in a
 * thin wrapper" discipline as `decideClaimEligibility`/
 * `determineCanPublish`/`applySpeakerChange` elsewhere in this codebase.
 * The authoritative version of this exact logic lives in
 * `resolve_speaker_round` (migration 00000000000021) — kept in sync by
 * hand and cross-referenced there, the same way
 * `SPEAKER_DISCONNECT_GRACE_SECONDS`/`11` already is. This module exists
 * so the exact percentage boundaries are testable without a live
 * database, and so the thresholds live in exactly one place rather than
 * scattered through components — per explicit instruction.
 */

/** Each new speaker's initial and every subsequent protected block. */
export const ROUND_DURATION_SECONDS = 60;
/** The "final thought" period after a narrow Replace loss — not another survival round, a guaranteed-replacement grace period. */
export const CLOSING_DURATION_SECONDS = 30;
/** Replace must exceed this percentage of votes cast to lose the round at all — an exact 50/50 tie stays Continue, per explicit instruction. */
export const NARROW_LOSS_THRESHOLD_PCT = 50;
/** Replace at or above this percentage of votes cast is decisive — replaced at the current round's own boundary, no closing period. */
export const DECISIVE_REPLACE_THRESHOLD_PCT = 66;

export type RoundOutcome = "continue" | "narrow-loss" | "decisive-replace";

/**
 * Zero votes, or Replace at/under `NARROW_LOSS_THRESHOLD_PCT`, is
 * "continue" (silence must never eject anyone). Between the two
 * thresholds (exclusive/inclusive as documented on each constant) is a
 * "narrow-loss" — the decision is made, but the speaker still gets
 * `CLOSING_DURATION_SECONDS` to finish their thought before actually
 * being replaced. At or above `DECISIVE_REPLACE_THRESHOLD_PCT` is an
 * immediate "decisive-replace" at the current round's boundary.
 *
 * Integer cross-multiplication (`replaceCount * 100` vs.
 * `threshold * total`), never a computed float percentage — there is no
 * rounding ambiguity at the exact 50%/66% boundaries this way, and the
 * authoritative SQL function (`resolve_speaker_round`) uses the
 * identical comparison for the identical reason.
 */
export function resolveRoundOutcome(continueCount: number, replaceCount: number): RoundOutcome {
  const total = continueCount + replaceCount;
  if (total === 0) return "continue";
  if (replaceCount * 100 >= DECISIVE_REPLACE_THRESHOLD_PCT * total) return "decisive-replace";
  if (replaceCount * 100 > NARROW_LOSS_THRESHOLD_PCT * total) return "narrow-loss";
  return "continue";
}

/**
 * Part 1/2 (test-build presentation vs. real product): the real product
 * default reveals the round timer / emphasizes the Vote control only in
 * roughly the final `ROUND_TIMER_REVEAL_SECONDS` of a round — this is
 * the one place that boundary is defined, so the test-build override
 * (`isPreviewBuild`, see `lib/preview-mode.ts`) is a single check at the
 * display layer, never a second timing system.
 */
export const ROUND_TIMER_REVEAL_SECONDS = 10;

/** The Replace percentage of votes cast, for display only (e.g. the simulator's observability panel) — never the actual decision, which is always the integer cross-multiplication above. `null` when no votes have been cast yet. */
export function replacePercentage(continueCount: number, replaceCount: number): number | null {
  const total = continueCount + replaceCount;
  if (total === 0) return null;
  return (replaceCount / total) * 100;
}
