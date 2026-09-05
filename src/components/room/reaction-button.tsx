"use client";

import { cn } from "@/lib/utils";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";

/**
 * Pre-launch interaction pass, Section 1/5: the Watch Mode control row's
 * "React" emblem — no longer a static inert placeholder
 * (`WatchModeControls`' own previous `ControlEmblem`). Tapping it opens
 * the reaction panel (`ReactionPanel`); it never sends a reaction
 * itself — there is no "general reaction" action in this design (see
 * `ReactionPanel`'s own doc comment).
 *
 * **Heat visualization** (Section 5): the *client-visible* meter — a
 * radial fill behind the emoji, centered, rising from empty to full as
 * `heatFraction` (0-1) increases. Deliberately not a separate progress
 * bar — the button itself communicates it, per explicit instruction.
 * `inCooldown` adds a slow, subtle pulse (never a hard flash) — skipped
 * entirely under `prefers-reduced-motion`, per Section 11's "cooldown
 * should avoid flashing/pulsing that could be uncomfortable" (motion is
 * never the *only* signal either — the fill itself stays visibly full
 * during cooldown regardless of the animation).
 */
export function ReactionButton({
  emoji,
  heatFraction,
  inCooldown,
  onOpenPanel,
  idle = false,
}: {
  emoji: string;
  heatFraction: number;
  inCooldown: boolean;
  onOpenPanel: () => void;
  /** Pre-launch interaction pass, Section 8: fades this button's own translucent background while the viewer is idle — see WatchModeControls' own `idle` doc comment. Defaults to false, unaffected for any caller/test that doesn't pass it. */
  idle?: boolean;
}) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const clampedFraction = Math.max(0, Math.min(1, heatFraction));

  return (
    <button
      type="button"
      // Same testid the original inert "React" placeholder emblem used
      // (WatchModeControls) — preserves every existing "is this the
      // audience/Watch Mode control row" check across this codebase's
      // own role-consistency tests, which predate this button and have
      // no reason to know it now exists.
      data-testid="watch-emoji-emblem"
      onClick={onOpenPanel}
      aria-label={`Reactions — currently set to ${emoji}. Opens reaction settings.`}
      aria-haspopup="dialog"
      className={cn(
        "relative flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full border border-white/30 text-lg transition-colors duration-300",
        idle ? "bg-white/[0.06]" : "bg-white/[0.14]",
        inCooldown && !prefersReducedMotion && "animate-[reaction-cooldown-pulse_1.6s_ease-in-out_infinite]",
      )}
    >
      {/* Heat fill — a radial wash rising behind the emoji, never a separate bar. Purely decorative (aria-hidden); the button's own accessible name doesn't change with heat. */}
      <span
        aria-hidden="true"
        data-testid="reaction-heat-fill"
        className={cn("absolute inset-0 rounded-full bg-accent/70", !prefersReducedMotion && "transition-transform duration-150")}
        style={{
          transform: `scale(${clampedFraction})`,
          opacity: clampedFraction > 0 ? 1 : 0,
        }}
      />
      <span aria-hidden="true" className="relative">
        {emoji}
      </span>
    </button>
  );
}
