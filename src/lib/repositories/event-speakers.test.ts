import { describe, expect, it } from "vitest";
import { createClient } from "@/lib/supabase/client";

/**
 * Integration test against the real linked Supabase project (same
 * credentials the app itself uses from .env.local) — not a mock. Skips
 * gracefully rather than failing if credentials aren't configured (e.g. a
 * fresh clone before .env.local is set up), matching this project's
 * graceful-degradation principle rather than hard-failing CI-less local
 * runs.
 *
 * Uses the browser Supabase client directly (not `listActiveSpeakers`
 * itself), because the repository function goes through
 * `lib/supabase/server.ts`, which calls `next/headers`' `cookies()` — only
 * valid inside a real Next.js request lifecycle, not a plain test process.
 * What's under test here — the RLS policy and grants on `event_speakers`
 * — is identical either way; the server client uses the same anon key and
 * is subject to the same Postgres-level rules.
 */
const hasCredentials = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
);

describe.skipIf(!hasCredentials)("event_speakers RLS", () => {
  it("returns no active speakers for an event with none", async () => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("event_speakers")
      .select("*")
      .eq("event_id", "00000000-0000-0000-0000-000000000000")
      .is("left_at", null);

    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("blocks inserting a speaker directly — every write goes through claim_speaker_seat/leave_speaker_seat/end_speaker_seat instead (see migration 00000000000006)", async () => {
    const supabase = createClient();
    const { error } = await supabase.from("event_speakers").insert({
      event_id: "00000000-0000-0000-0000-000000000000",
      profile_id: "00000000-0000-0000-0000-000000000000",
      seat_number: 1,
      display_name: "test",
    });

    // 42501 = permission denied (no INSERT grant) — proves this table is
    // genuinely read-only from the app's perspective, not just documented
    // as such; the RPC functions write to it via security definer, not
    // via a grant an ordinary client request would ever have.
    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501");
  });
});
