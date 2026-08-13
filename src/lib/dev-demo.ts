/**
 * Shared between `scripts/dev-harness.mts` (the CLI) and the dev-only
 * `/dev` page (`src/app/dev/`) — both tag demo data identically so
 * either tool's cleanup finds what the other created. Pure
 * constants/functions only, no Supabase, no I/O — same "no Supabase, no
 * I/O" discipline as `lib/events.ts`/`lib/room-status.ts`, which is what
 * lets the standalone CLI script (which otherwise imports nothing else
 * from `src/` — see its own header comment) still share this one source
 * of truth via a plain relative import, without pulling in anything
 * heavier than a few constants and pure functions.
 */

export const DEV_EVENT_PREFIX = "[dev-harness] ";
/** Reserved, non-routable TLD (RFC 2606) — a real signup can never collide with this. */
export const DEV_TEST_EMAIL_DOMAIN = "@dev-harness.invalid";

export function isDevEventTitle(title: string): boolean {
  return title.startsWith(DEV_EVENT_PREFIX);
}

export function isDevTestEmail(email: string): boolean {
  return email.toLowerCase().endsWith(DEV_TEST_EMAIL_DOMAIN);
}

export type DevEventPhase = "ready" | "lobby_open" | "upcoming";

/**
 * Timestamps chosen so a freshly-created event is immediately in the
 * requested phase — see `lib/events.ts`'s `getEventPhase` for the phase
 * boundaries this mirrors.
 */
export function devTimingForPhase(
  phase: DevEventPhase,
  now: Date = new Date(),
): { scheduled_start: string; lobby_opens_at: string } {
  const ms = now.getTime();
  if (phase === "ready") {
    return {
      scheduled_start: new Date(ms - 60_000).toISOString(),
      lobby_opens_at: new Date(ms - 5 * 60_000).toISOString(),
    };
  }
  if (phase === "lobby_open") {
    return {
      scheduled_start: new Date(ms + 15 * 60_000).toISOString(),
      lobby_opens_at: new Date(ms - 60_000).toISOString(),
    };
  }
  return {
    scheduled_start: new Date(ms + 2 * 60 * 60_000).toISOString(),
    lobby_opens_at: new Date(ms + 60 * 60_000).toISOString(),
  };
}

/**
 * Whether dev/demo tooling (the `/dev` page and its Server Actions)
 * should do anything at all. Next.js itself force-sets
 * `NODE_ENV=production` for every `next build`/`next start`, regardless
 * of shell environment — not something a stray env var can accidentally
 * leave off — so this is a reliable, un-spoofable-by-accident signal,
 * not a new flag to configure. The CLI script doesn't use this (it has
 * no production deployment to accidentally run inside); it's specific to
 * the UI-reachable surface.
 */
export function isDevToolsAvailable(): boolean {
  return process.env.NODE_ENV !== "production";
}
