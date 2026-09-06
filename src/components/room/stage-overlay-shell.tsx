import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

/**
 * The click-through-margin, interactive-content-inside shell shared by
 * every room composition that layers chat/controls *over* the stage
 * instead of beside it (`PortraitRoom`, `MobileLandscapeRoom` — never
 * `DesktopRoom`, whose chat is a real sidebar with nothing to overlay).
 * Extracted once both callers needed the identical structure — not a
 * speculative abstraction, an existing duplication.
 *
 * **Two layers, not one** (real-device finding: an open seat's tile could
 * end up under this overlay): the outer element is `pointer-events-none`
 * — its only job is the background gradient and the top spacer that
 * keeps the stage visible above the actual content — so a tap landing in
 * that decorative margin reaches the stage underneath instead of being
 * swallowed. Only the inner wrapper, where the real controls/chat live,
 * is `pointer-events-auto`. `topClassName` controls how tall that
 * decorative spacer is — portrait can afford more of it than the
 * shorter, more space-constrained mobile-landscape composition.
 *
 * `gradient` (issue #21, 05 interaction model): the always-on wash was
 * sized for a permanently-visible chat strip/control block underneath
 * it. The 05 design's bottom controls are small individual translucent
 * "glass" emblems that carry their own legibility, not one tall panel —
 * a full-height gradient behind them would reintroduce exactly the
 * "video isn't the dominant surface" look that redesign was rejecting.
 * Defaults to `true` (today's existing wash, unchanged) so every
 * existing caller (`MobileLandscapeRoom`) keeps its current appearance;
 * only a caller that explicitly wants the lighter treatment opts out.
 * The click-through-outer/interactive-inner structure — the actual bug
 * fix this component exists for — is identical either way.
 *
 * **`idle`** (pre-launch interaction pass, Section 8): when true, this
 * background gradient — the actual scrim covering the lower speaker —
 * fades to a lighter wash so more of the video shows through while the
 * viewer is simply watching. Deliberately only the gradient's own
 * opacity, never the inner `pointer-events-auto` wrapper or its
 * children (foreground text/icons/controls) — those stay at full
 * opacity/contrast and fully interactive regardless, per Section 8's own
 * "do NOT make controls disappear completely" / "never let hit targets
 * disappear" instructions. Caller (`PortraitRoom`/`MobileLandscapeRoom`)
 * owns the actual idle-detection (`useIdleActivity`) — this component
 * only renders whatever it's told. Defaults to `false` (today's full-
 * opacity gradient, unchanged) so every existing caller/test is
 * unaffected until it opts in.
 */
export function StageOverlayShell({
  children,
  topClassName = "pt-14",
  className,
  gradient = true,
  idle = false,
}: {
  children: ReactNode;
  topClassName?: string;
  className?: string;
  gradient?: boolean;
  idle?: boolean;
}) {
  return (
    <div
      data-testid="stage-bottom-overlay"
      className={cn(
        "stage-overlay pointer-events-none absolute inset-x-0 bottom-0 z-10",
        gradient && "bg-gradient-to-t from-black/90 via-black/60 to-transparent transition-opacity duration-300",
        gradient && idle && "opacity-50",
        topClassName,
      )}
      data-idle={idle ? "true" : "false"}
    >
      <div className={cn("pointer-events-auto flex flex-col gap-1 px-3 pb-3", className)}>{children}</div>
    </div>
  );
}
