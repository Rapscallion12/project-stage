/**
 * Pre-launch interaction pass: centralized, easy-to-tune constants for
 * directed live-stage emoji reactions. Two groups:
 *
 * 1. **Heat/cooldown tuning** — mirrors migration
 *    00000000000045_stage_reaction_heat.sql's own SQL function default
 *    parameters *by hand*, not by any shared build-time source (SQL and
 *    TypeScript don't share a runtime) — change both together when
 *    tuning. The server's own copy (the actual security boundary) is
 *    authoritative; these values only drive the *client-visible* heat
 *    meter, which must merely track the server closely enough that
 *    normal use never visibly disagrees with it — see
 *    `useReactionHeat`'s own doc comment.
 * 2. **The curated reaction set** — deliberately small, appropriate for
 *    live conversation; not a general emoji keyboard (comments already
 *    have the system one for that).
 */

/** How much heat one accepted reaction adds, 0-100 scale. */
export const REACTION_HEAT_INCREMENT = 12;
/** How much heat drains per second of real time elapsed since the last reaction. */
export const REACTION_HEAT_DRAIN_PER_SECOND = 4;
/** Heat at which sending stops (the button visually reads "full"). */
export const REACTION_HEAT_MAX = 100;
/**
 * Cooldown-exit threshold, 0-100 scale. Real-device correction (this
 * was 55 — hysteresis to avoid bouncing right at the boundary): once
 * cooldown starts at REACTION_HEAT_MAX, sending now stays blocked for
 * the entire drain, all the way back down to genuinely empty — 0, not
 * partway down. Migration 00000000000046 changed the server RPC's own
 * default to match; keep both in sync for any future tuning pass (see
 * this file's own doc comment on why there's no shared runtime between
 * the two).
 */
export const REACTION_HEAT_COOLDOWN_EXIT = 0;

/**
 * Small, curated set appropriate for live conversation — not a general
 * emoji keyboard. First-time default is ❤️ (index 0) unless a viewer
 * already has a persisted preference.
 */
export const REACTION_EMOJI_SET = ["❤️", "😂", "👏", "🔥", "😮", "💀", "👍", "👎"] as const;
export type ReactionEmoji = (typeof REACTION_EMOJI_SET)[number];

export const DEFAULT_REACTION_EMOJI: ReactionEmoji = "❤️";

/** How long an on-screen reaction burst stays mounted before being pruned — see useStageReactions. */
export const REACTION_BURST_LIFETIME_MS = 2200;

/**
 * Real-device correction: how long `useStageReactions` remembers a
 * reaction id *it originated* for dedup purposes, independent of
 * `REACTION_BURST_LIFETIME_MS` (the id-dedup bug this fixes was exactly
 * this: the two were previously the same lifetime, so a round trip
 * slower than the burst's own on-screen animation meant the sender's own
 * confirming broadcast arrived *after* the optimistic entry had already
 * been pruned from `incoming`, defeating the id match and rendering a
 * second, duplicate burst). Generously long compared to any plausible
 * round trip (DB row lock + REST broadcast + Realtime propagation) —
 * this only needs to outlast that, not the visual animation.
 */
export const REACTION_SENT_ID_MEMORY_MS = 30_000;
