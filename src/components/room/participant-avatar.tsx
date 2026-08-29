import { cn } from "@/lib/utils";

/** Up to 2 characters, uppercased — the canonical fallback shown wherever a real photo isn't available. Exported since `SpeakerTile`'s own inline uses of this exact pattern predate this component and read from it directly, rather than duplicating the logic. */
export function initialsFor(name: string): string {
  return name.trim().slice(0, 2).toUpperCase() || "?";
}

const SIZE_CLASSES = {
  xs: "h-7 w-7 text-[10px]",
  sm: "h-9 w-9 text-xs",
  md: "h-14 w-14 text-lg",
} as const;

/**
 * Issue #21, third corrective pass: the one canonical avatar presentation
 * for a participant identity — real-device finding: Expanded Comments
 * showed a bare name with no visual identity marker at all, while
 * `SpeakerTile` had its own inline initials-circle duplicated across four
 * separate render branches. Both now go through this single component
 * rather than each carrying its own copy.
 *
 * `imageUrl` exists for a real profile photo, but `profiles` has no such
 * column today (checked against `src/types/database.ts` before writing
 * this — no schema exists to source one from), so every current caller
 * passes nothing and correctly falls through to the initials placeholder
 * — exactly "otherwise the existing appropriate avatar/initials/guest
 * placeholder," per explicit instruction. The prop is here so a real
 * photo, once the schema supports one, needs no second avatar system to
 * render it.
 *
 * Identity-agnostic by design: this only ever receives a display name
 * (+ optional image) — it has no idea whether the participant is an
 * authenticated account, a guest, or a simulated identity, and doesn't
 * need to; every one of those already resolves to a plain display name
 * before reaching here, so all three render identically.
 */
export function ParticipantAvatar({
  name,
  imageUrl,
  size = "md",
  className,
}: {
  name: string;
  imageUrl?: string | null;
  size?: "xs" | "sm" | "md";
  className?: string;
}) {
  if (imageUrl) {
    // eslint-disable-next-line @next/next/no-img-element -- a participant photo's source is arbitrary/user-controlled (once one exists), not one of this app's own optimizable static assets.
    return <img src={imageUrl} alt="" className={cn("shrink-0 rounded-full object-cover", SIZE_CLASSES[size], className)} />;
  }
  return (
    <div
      data-testid="participant-avatar-initials"
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full bg-accent/15 font-semibold text-accent",
        SIZE_CLASSES[size],
        className,
      )}
    >
      {initialsFor(name)}
    </div>
  );
}
