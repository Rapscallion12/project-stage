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
 * Hysteresis: once cooldown starts at REACTION_HEAT_MAX, sending stays
 * blocked until heat has drained back down to *this* threshold — not
 * merely below REACTION_HEAT_MAX — so a viewer never bounces between
 * blocked/unblocked right at the boundary.
 */
export const REACTION_HEAT_COOLDOWN_EXIT = 55;

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
