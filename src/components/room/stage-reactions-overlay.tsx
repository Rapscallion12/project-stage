"use client";

import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import type { IncomingStageReaction } from "@/hooks/use-stage-reactions";

/**
 * Pre-launch interaction pass, Section 3/4A: renders one speaker tile's
 * own incoming reaction bursts — "On speaker" display mode, the default.
 * Mounted *inside* `SpeakerTile`'s own `relative` root (see that
 * component), already filtered to reactions whose `targetIdentity`
 * matches this tile's seat — this component itself has no identity
 * logic, purely presentation.
 *
 * **Ephemeral, never permanent UI**: each burst renders for exactly
 * `REACTION_BURST_LIFETIME_MS` (the caller, `useStageReactions`, prunes
 * it from the shared list after that — this component just stops
 * receiving it in `reactions`) and animates via CSS only — no JS timer
 * of its own, no layout reservation, `pointer-events-none` throughout so
 * it never intercepts the next double-tap.
 *
 * **Subtle variation, not distraction**: each burst derives its own
 * drift/rotation from its own `id` (a cheap, stable hash — not
 * `Math.random()`, so a given reaction's animation doesn't jitter across
 * re-renders) rather than sharing one fixed path — repeated reactions
 * from the same spot fan out slightly instead of perfectly stacking, per
 * Section 3's explicit instruction. Reduced-motion drops the drift/
 * rotation/scale entirely (a plain fade), per Section 11.
 */
export function OnSpeakerReactionBursts({ reactions }: { reactions: IncomingStageReaction[] }) {
  const prefersReducedMotion = usePrefersReducedMotion();

  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      {reactions.map((reaction) => {
        const { driftX, rotate } = burstVariation(reaction.id);
        return (
          <span
            key={reaction.id}
            className="absolute text-2xl sm:text-3xl"
            style={{
              left: `${reaction.x * 100}%`,
              top: `${reaction.y * 100}%`,
              // Custom properties read by the keyframes themselves (see
              // globals.css) — keeps the per-burst randomization here,
              // next to the id it's derived from, rather than computing
              // matching inline transforms by hand.
              ["--drift-x" as string]: `${driftX}px`,
              ["--rotate" as string]: `${rotate}deg`,
              animation: prefersReducedMotion
                ? "reaction-burst-rise-reduced 1.6s ease-out forwards"
                : "reaction-burst-rise 1.8s ease-out forwards",
            }}
          >
            {reaction.emoji}
          </span>
        );
      })}
    </div>
  );
}

/**
 * Pre-launch interaction pass, Section 4B: the "Side" display mode —
 * incoming reactions (regardless of which speaker they targeted; a
 * viewer who chose Side has opted out of per-speaker positioning
 * entirely, not per-speaker-B-only) float up a narrow lane instead of
 * covering either speaker's video. Rendered once at the stage level
 * (`SpeakerStage`), not per-tile.
 *
 * The reaction is still genuinely associated with its correct target
 * internally (`useStageReactions`' own shared event carries
 * `targetIdentity` throughout) — this mode simply chooses not to *show*
 * that positioning, per Section 4's own "the sender's event stays
 * presentation-independent; each receiving client decides how to
 * render it."
 */
export function ReactionSideLane({ reactions }: { reactions: IncomingStageReaction[] }) {
  const prefersReducedMotion = usePrefersReducedMotion();
  // Only the most recent handful — a lane that never stops growing
  // defeats "tasteful," and older bursts have already finished their
  // own CSS animation and would just sit invisible (opacity 0) anyway.
  const visible = reactions.slice(-8);

  return (
    <div
      aria-hidden="true"
      data-testid="reaction-side-lane"
      className="pointer-events-none absolute right-2 bottom-24 z-10 flex w-10 flex-col-reverse items-center gap-1 sm:right-3"
    >
      {visible.map((reaction) => (
        <span
          key={reaction.id}
          className="text-xl sm:text-2xl"
          style={{
            animation: prefersReducedMotion
              ? "reaction-burst-rise-reduced 1.6s ease-out forwards"
              : "reaction-lane-rise 2s ease-out forwards",
          }}
        >
          {reaction.emoji}
        </span>
      ))}
    </div>
  );
}

/** Cheap, stable per-id hash — see OnSpeakerReactionBursts' own doc comment for why this isn't Math.random(). */
function burstVariation(id: string): { driftX: number; rotate: number } {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  const driftX = (((hash % 40) + 40) % 40) - 20; // -20..20px
  const rotate = ((((hash >> 8) % 24) + 24) % 24) - 12; // -12..12deg
  return { driftX, rotate };
}
