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
 */
export function StageOverlayShell({
  children,
  topClassName = "pt-14",
  className,
}: {
  children: ReactNode;
  topClassName?: string;
  className?: string;
}) {
  return (
    <div
      data-testid="stage-bottom-overlay"
      className={cn(
        "stage-overlay pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/90 via-black/60 to-transparent",
        topClassName,
      )}
    >
      <div className={cn("pointer-events-auto flex flex-col gap-1 px-3 pb-3", className)}>{children}</div>
    </div>
  );
}
