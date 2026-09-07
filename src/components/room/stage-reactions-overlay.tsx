"use client";

import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import type { IncomingStageReaction } from "@/hooks/use-stage-reactions";
import { cn } from "@/lib/utils";

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
 *
 * **`compact`** (mobile UX correction): Expanded Comments' own mini stage
 * renders speaker tiles at a fraction of the normal size — the full-size
 * `text-2xl`/`text-3xl` burst would visually overwhelm a tile that small.
 * Shrinks the emoji glyph only; positioning, timing, and drift math are
 * all unchanged. Defaults to `false`.
 *
 * **`z-10`** (speaker presentation-toggle correction, real-device
 * report): a real iPhone Safari test found a speaker's own reactions
 * invisible once their tile showed a real, live `<video>` — even though
 * the filtering/routing logic that decides *whether* a reaction reaches
 * this component was audited and confirmed correct (a regression test
 * locks that in — see `SpeakerTile.test.tsx`). Per the CSS painting-order
 * spec, a positioned (`absolute`) `z-index:auto` element like this one's
 * root should already paint above the tile's non-positioned `<video>`
 * sibling regardless of DOM order — but Safari's own video-compositing
 * layer is exactly the kind of non-spec-faithful behavior this codebase
 * has already documented twice for `<video>` elements specifically (see
 * DECISIONS.md's "renders black until forced to repaint" entries). This
 * sibling, `ReactionSideLane` below, already carries an explicit `z-10`
 * for its own reasons (layering over the stage) — this was the one
 * reaction surface that never got the same explicit stacking-context
 * promotion. Matching that value here removes any ambiguity for a
 * browser's own video compositing to exploit, without depending on paint
 * order alone.
 */
export function OnSpeakerReactionBursts({
  reactions,
  compact = false,
}: {
  reactions: IncomingStageReaction[];
  compact?: boolean;
}) {
  const prefersReducedMotion = usePrefersReducedMotion();

  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
      {reactions.map((reaction) => {
        const { driftX, rotate } = burstVariation(reaction.id);
        return (
          <span
            key={reaction.id}
            className={cn("absolute", compact ? "text-base" : "text-2xl sm:text-3xl")}
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
 * Pre-launch interaction pass, Section 4B — refined by a real-device
 * follow-up pass: the "Side" display mode, for *other viewers'*
 * reactions (the caller, `SpeakerStage`, already excludes the current
 * viewer's own reactions from what it passes here — their own feedback
 * renders on-speaker instead, at their exact tap location, so they never
 * lose precise spatial confirmation of what they just did; see that
 * component's own doc comment). Rendered at the stage level, not
 * per-tile.
 *
 * **`region`** (real-device follow-up: "Side mode must preserve which
 * speaker was targeted"): a single shared bottom-corner lane originally
 * treated every reaction identically regardless of target, which lost
 * the directed reaction's whole point — a viewer had no way to tell
 * "someone reacted to the top speaker" from "someone reacted to the
 * bottom speaker." `SpeakerStage` now renders *two* instances of this
 * component in the two-tile portrait case, one per currently-visible
 * slot (`region="top"`/`region="bottom"`), each already pre-filtered to
 * that slot's own target identity — this component itself still has no
 * identity logic, it just positions itself differently per region.
 * "Currently visible slot" tracks local timer-swap ordering (Section 7),
 * not seat 1/2 — again, entirely the caller's job; by the time a
 * reaction array reaches here it's already correctly bucketed.
 * `region` omitted (landscape/solo/desktop) preserves the original
 * single, unsplit lane position exactly — a deliberate, reported scope
 * decision (see DECISIONS.md) to avoid guessing at a landscape/desktop
 * spatial treatment ahead of the dedicated desktop UX audit.
 */
export function ReactionSideLane({
  reactions,
  region,
}: {
  reactions: IncomingStageReaction[];
  region?: "top" | "bottom";
}) {
  const prefersReducedMotion = usePrefersReducedMotion();
  // Only the most recent handful — a lane that never stops growing
  // defeats "tasteful," and older bursts have already finished their
  // own CSS animation and would just sit invisible (opacity 0) anyway.
  const visible = reactions.slice(-8);

  return (
    <div
      aria-hidden="true"
      data-testid={region ? `reaction-side-lane-${region}` : "reaction-side-lane"}
      className={cn(
        "pointer-events-none absolute right-2 z-10 flex w-10 flex-col-reverse items-center gap-1 sm:right-3",
        region === "top" ? "top-[18%]" : region === "bottom" ? "bottom-[12%]" : "bottom-24",
      )}
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
